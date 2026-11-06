// src/commands/configure.ts — edit the deployment manifests from a TUI
// (or flags): the deploy TARGET and the REQUIRED-PACKAGE list of
// wm.required.
//
//   on-deploy configure              interactive menu / flags
//   on-deploy configure --target arch
//   on-deploy configure --add pkgA,pkgB
//   on-deploy configure --remove pkgA
//   on-deploy configure --show
//
// wm.required structure: line 1 = whitespace-separated required
// binaries; the LAST non-comment line = the deploy target name
// (selecting ~/.local/bin/install/<target>.deploy). Comments (#) are
// preserved; edits rewrite only the two content lines.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { join } from "node:path";
import {
    readFileSync, writeFileSync, existsSync, readdirSync,
    chmodSync, realpathSync,
} from "node:fs";
import { checkDotsEnv, DOTS_DIR, readRequires, readWmPackages } from "../lib/dots";
import { readLine } from "../lib/lines";
import { runApply } from "../lib/configureCore";
import { walk } from "./install";
import {
    packagesWithMakefiles, printResults, runRule, stowPackages, stowPkg,
    type PkgResult,
} from "../lib/pkgops";
// the interactive layer is OURS (lib/tui*): no facade prompts — the
// vendored per-prompt listener pattern (MaxListenersExceeded) stays
// out of dependency land; see lib/tuiSession.tsx
import { tuiChecklist, tuiSelect, tuiText, tuiYesNo, releaseTui } from "../lib/tui";

const KNOWN_TARGETS = ["ubuntu", "debian", "manjaro", "arch", "fedora"];
// the candidate catalog for the checklist (the current list is always
// included and preselected)
const CATALOG = [
    "herbstluftwm", "herbstclient", "compton", "polybar", "rofi",
    "hsetroot", "xset", "dunst", "notify-send",
    "xvfb", "x11vnc", "novnc", "xinit", "xauth", "lightdm", "greetd",
];

interface Manifest {
    comments: string[];
    binaries: string[];
    /** the positional session line (line 2 of the content; "" when absent) */
    session: string;
    target: string;
}

function readManifest(): Manifest {
    const text = readFileSync(join(DOTS_DIR, "wm.required"), "utf8");
    const all = text.split("\n");
    const content = all.filter((l) => l.trim() && !l.trim().startsWith("#"));
    if (content.length < 2) {
        throw new Error("wm.required: expected a binaries line and a target line");
    }
    const comments = all.slice(0, all.indexOf(content[0]));
    // positional layout: [binaries] [session?] [target]
    // readSession() defines line 2 = the session; target is the LAST line
    const target = content[content.length - 1].trim();
    const session = content.length >= 3 ? content[1].trim() : "";
    return {
        comments,
        binaries: content[0].trim().split(/\s+/).filter(Boolean),
        session,
        target,
    };
}

function writeManifest(m: Manifest): void {
    // the manifest layout is POSITIONAL (the session line has no key):
    // [comments...] binaries session(target) — rewriting must keep the
    // middle line (writeSession reads it positionally too), else the
    // saved manifest silently loses the deployment model
    if (m.session || readSession()) writeSession(m.session);
    writeFileSync(
        join(DOTS_DIR, "wm.required"),
        [...m.comments, m.binaries.join(" "), m.session, m.target].join("\n") + "\n",
    );
}

// --- the deployment model (the `session =` line of wm.required) ------------
// The model selects the deploy target implementation (apply): session =
// HOW the graphical session starts. wm.required IS the manifest —
// binaries line, session line, deploy target line (positional). Comments
// are preserved; only the session line is rewritten in place.

const SESSIONS = ["greetd", "wsl-systemd", "xinit", "nested"];

/** the session model from wm.required line 2 ("" = absent) */
function readSession(): string {
    const lines = readFileSync(join(DOTS_DIR, "wm.required"), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
    return lines.length >= 3 ? lines[1] : "";
}

/** rewrite ONLY the session line (wm.required line 2), comments kept */
function writeSession(session: string): void {
    const path = join(DOTS_DIR, "wm.required");
    const lines = readFileSync(path, "utf8").split("\n");
    const content = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => l.trim() && !l.trim().startsWith("#"));
    if (content.length >= 3) lines[content[1].i] = session;
    else lines.splice(content[0].i + 1, 0, session);
    writeFileSync(path, lines.join("\n"));
}

// --- stows.required (the STOW manifest) & system.required (SUBMODULES) ----
// Both are plain list files: comments (#) and blanks preserved, content
// lines rewritten per edit. The configure TUI offers checkslists over
// the same structured pieces; flags accept comma/space separated specs.

interface StowsFile { comments: string[]; packages: string[] }

function readStows(): StowsFile {
    const all = readFileSync(join(DOTS_DIR, "stows.required"), "utf8").split("\n");
    const firstContent = all.findIndex((l) => l.trim() && !l.trim().startsWith("#"));
    const comments = firstContent < 0 ? all.slice() : all.slice(0, firstContent);
    const packages = all
        .filter((l) => l.trim() && !l.trim().startsWith("#"))
        .flatMap((l) => l.split(/\s+/))
        .filter(Boolean);
    return { comments, packages };
}

function writeStows(s: StowsFile): void {
    writeFileSync(
        join(DOTS_DIR, "stows.required"),
        [...s.comments, ...s.packages].join("\n") + "\n",
    );
}

interface SubsFile { comments: string[]; entries: { pkg: string; paths: string[] }[] }

function readSubs(): SubsFile {
    const all = readFileSync(join(DOTS_DIR, "system.required"), "utf8").split("\n");
    const firstContent = all.findIndex((l) => l.trim() && !l.trim().startsWith("#"));
    const comments = firstContent < 0 ? all.slice() : all.slice(0, firstContent);
    const entries: SubsFile["entries"] = [];
    for (const line of all) {
        const l = line.trim();
        if (!l || l.startsWith("#")) continue;
        const fields = l.split(/\s+/).filter(Boolean);
        if (fields.length >= 2) entries.push({ pkg: fields[0], paths: fields.slice(1) });
    }
    return { comments, entries };
}

function writeSubs(s: SubsFile): void {
    writeFileSync(
        join(DOTS_DIR, "system.required"),
        [
            ...s.comments,
            ...s.entries.map((e) => [e.pkg, ...e.paths].join(" ")),
        ].join("\n") + "\n",
    );
}

// --- git credentials (dots/shell/.my-credentials, stowed) ------------------
// The file LIVES in the repo (gitignored) and is stowed to
// ~/.my-credentials — the repo copy is the single source of truth.

const CRED_REPO = join(DOTS_DIR, "shell", ".my-credentials");
const CRED_HOME = join(process.env.HOME!, ".my-credentials");

function readCredentials(): { name: string; email: string } {
    // prefer the stowed path; fall back to the repo file directly
    const p = existsSync(CRED_HOME) ? CRED_HOME : CRED_REPO;
    if (!existsSync(p)) return { name: "", email: "" };
    const lines = readFileSync(p, "utf8").split("\n");
    return { name: (lines[0] ?? "").trim(), email: (lines[1] ?? "").trim() };
}

function writeCredentials(name: string, email: string): string[] {
    const notes: string[] = [];
    writeFileSync(CRED_REPO, `${name}\n${email}\n`);
    try { chmodSync(CRED_REPO, 0o600); } catch { /* best-effort */ }
    // ~/.my-credentials must end up as a STOW-OWNED link (from the
    // shell package); never create it here — an absolute symlink from
    // this code made stow fail with "existing target is not owned by
    // stow: .my-credentials" on the next `make wm/update`. Only warn
    // when the path exists and ISN'T the repo file (fresh machines
    // with nothing at the path: stow shell creates the link later).
    if (!existsSync(CRED_HOME)) {
        notes.push("no ~/.my-credentials link yet — 'make wm' (shell package) creates the stow link");
    } else if (realpathSync(CRED_HOME) !== realpathSync(CRED_REPO)) {
        notes.push("WARNING: ~/.my-credentials is not a link into dots/shell — stow the shell package");
    }
    // the shell exports (GIT_NAME/GIT_EMAIL) + git config
    const envf = join(process.env.HOME!, ".my-credentials-env");
    writeFileSync(envf, `# generated by on-deploy configure\nGIT_NAME='${name}'\nGIT_EMAIL='${email}'\n`);
    try { chmodSync(envf, 0o600); } catch { /* best-effort */ }
    if (existsSync(CRED_HOME)) {
        const load = join(process.env.HOME!, ".local/bin/load-credentials");
        if (existsSync(load)) {
            const r = Bun.spawnSync([load], { stdout: "pipe", stderr: "pipe" });
            notes.push(r.exitCode === 0 ? "git config applied" : "WARNING: load-credentials rejected the values");
        }
    } else {
        notes.push("git config NOT applied — stow shell first");
    }
    return notes;
}

function validCredentials(name: string, email: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "name: empty";
    if (!email.includes("@")) return "email: '@' required";
    return "";
}

/** PROMPT for the git identity when dots/shell/.my-credentials is
 *  ABSENT (gitignored; first run on a fresh machine — the shell rc
 *  files autoload it once it exists). Two lines: name, email —
 *  deliberately on the SIMPLE line reader (lines.ts), NOT the bunli
 *  text prompt: under `make install` the stdin feeding races the
 *  opentui prompt session's initialization (blank screen + lost
 *  keystrokes); a plain line read is make-recipe-safe.
 *  Returns the values, or null when the user skipped / is non-tty. */
async function promptCredentials(): Promise<{ name: string; email: string } | null> {
    if (existsSync(CRED_REPO) || existsSync(CRED_HOME)) return null;
    if (!process.stdin.isTTY) return null;
    console.log("configure: no git credentials on file (~/.my-credentials missing)");
    console.log("	the shell rc files load git identity from that file at startup");
    console.log("	two lines: your full name, then your email.");
    for (;;) {
        process.stdout.write("	name	(empty=skip): ");
        const nameLine = await readLine();
        if (nameLine === null) {
            console.log("configure: EOF (ctrl-d)");
            console.log("configure: skipped");
            console.log("configure: git identity stays unset (re-run 'on-deploy configure' later)");
            return null;
        }
        const name = nameLine.trim();
        if (!name) {
            console.log("configure: skipped");
            console.log("configure: git identity stays unset (re-run 'on-deploy configure' later)");
            return null;
        }
        process.stdout.write("	email (empty=skip): ");
        const emailLine = await readLine();
        if (emailLine === null) {
            console.log("configure: EOF (ctrl-d)");
            console.log("configure: skipped");
            console.log("configure: git identity stays unset (re-run 'on-deploy configure' later)");
            return null;
        }
        const email = emailLine.trim();
        if (!email) {
            console.log("configure: skipped");
            console.log("configure: git identity stays unset (re-run 'on-deploy configure' later)");
            return null;
        }
        const warn = validCredentials(name, email);
        if (!warn) return { name, email };
        console.log(`configure: ${warn}`);
        console.log("configure: try again");
        console.log("configure: or leave the name empty to skip");
    }
}

// One-line stdin reader — NOT node:readline (bun's readline wedges;
// see deploy.ts). Resolves per newline, so scripted feeds work too.
// The bunli-native menu: opentui-rendered select/multiselect frames
// inline in the scrollback; every field validates at the prompt; Esc
// cancels the CURRENT field (the menu stays) or quits at the menu root.
type EditResult = "cancel" | "quit" | "saved";

async function tuiEdit(m: Manifest): Promise<EditResult> {
    const cred = readCredentials() as { name: string; email: string; dirty?: boolean };
    let session = readSession();

    for (;;) {
        const stows = readStows();
        const subs = readSubs();
        const a = await tuiSelect("configure — what to edit?", [
            { label: `deploy target:	${m.target}`, value: "target" },
            { label: `required binaries: ${m.binaries.join(" ")}`, value: "binaries" },
            { label: `session model:	${session || "wsl-systemd (default)"}`, value: "session" },
            { label: `stow packages:	${stows.packages.join(" ") || "(none)"}`, value: "stows" },
            { label: `submodules:	${subs.entries.map((e) => e.pkg).join(" ") || "(none)"}`, value: "subs" },
            { label: `git credentials:	${cred.name || "(unset)"} <${cred.email || "none"}>`, value: "credentials" },
            { label: "save + apply", value: "save" },
            { label: "quit without saving", value: "quit" },
        ]);
        if (a === null) {
            // esc/ctrl-c at the ROOT = hard cancel (exit code 130 → make stops)
            console.log("configure: cancelled");
            console.log("configure: nothing saved");
            process.exit(130);
        }
        if (a === "quit") {
            console.log("configure: quit without saving");
            console.log("configure: nothing changed");
            return "quit";
        }
        if (a === "save") break;

        if (a === "stows") {
            // candidate catalog: every repo top-level directory (the stow
            // package set); current list always included + preselected
            const known = new Set<string>(stows.packages);
            for (const e of readdirSync(DOTS_DIR, { withFileTypes: true })) {
                if (e.isDirectory() && !e.name.startsWith(".")) known.add(e.name);
            }
            const names = [...known].sort();
            const sel = await tuiChecklist<string>(
                "stow packages (stows.required) — space toggles, enter confirms",
                names.map((p) => ({
                    label: p,
                    value: p,
                    hint: stows.packages.includes(p) ? "stowed" : "",
                })),
                { preselect: stows.packages },
            );
            if (sel === null) continue;
            writeStows({ comments: stows.comments, packages: names.filter((p) => sel.includes(p)) });
            console.log("configure: stows.required rewritten to the checked set");
            continue;
        }
        if (a === "subs") {
            // keep the manifest entries whose line is still checked;
            // additions loop after the checklist until an empty edit
            const labels = subs.entries.map((e) => [e.pkg, ...e.paths].join(" "));
            const sel = await tuiChecklist<string>(
                "system.required submodules — UNCHECK a line to DROP it, enter confirms",
                labels.map((l) => ({ label: l, value: l })),
                { preselect: labels },
            );
            if (sel === null) continue;
            const kept = subs.entries.filter((e) => sel.includes([e.pkg, ...e.paths].join(" ")));
            for (;;) {
                const add = await tuiText("add a submodule line: <pkg> <dots-relative path…> (empty = done)");
                if (add === null || !add.trim()) break;
                const fields = add.trim().split(/\s+/);
                if (fields.length < 2) {
                    console.log("configure: need <pkg> AND at least one <path>");
                    console.log("configure: retry");
                    console.log("configure: empty to skip");
                    continue;
                }
                kept.push({ pkg: fields[0], paths: fields.slice(1) });
            }
            writeSubs({ comments: subs.comments, entries: kept });
            console.log(`configure: system.required rewritten (${kept.length} package line(s))`);
            continue;
        }
        if (a === "target") {
            const t = await tuiSelect<string>("deploy target", [
                ...KNOWN_TARGETS.map((k) => ({ label: k, value: k })),
                { label: "custom name…", value: "__custom" },
            ]);
            if (t === null) continue;
            if (t === "__custom") {
                const c = await tuiText("custom target name", {
                    validate: (v) => /^[a-z][a-z0-9-]*$/i.test(v.trim()) ? undefined : "letters/digits/dash only",
                });
                if (c === null || !c.trim()) continue;
                m.target = c.trim();
            } else {
                m.target = t;
            }
            continue;
        }
        if (a === "binaries") {
            const known = [...new Set([...CATALOG, ...m.binaries])];
            const sel = await tuiChecklist<string>(
                "required binaries — space toggles, enter confirms",
                known.map((b) => ({
                    label: b,
                    value: b,
                    hint: CATALOG.includes(b) ? "catalog" : "extra",
                })),
                { preselect: m.binaries },
            );
            if (sel === null) continue;
            // keep the manifest order stable: known-list order, then
            // anything not listed (defensive)
            m.binaries = known.filter((b) => sel.includes(b));
            const extra = sel.filter((b) => !known.includes(b));
            if (extra.length > 0) m.binaries.push(...extra);
            continue;
        }
        if (a === "session") {
            const s = await tuiSelect<string>("deployment model — how the graphical session starts",
                SESSIONS.map((k) => ({ label: k, value: k })),
                { initialValue: SESSIONS.includes(session) ? session : undefined },
            );
            if (s === null) continue;
            session = s;
            continue;
        }
        if (a === "credentials") {
            const n = await tuiText(`git user name [${cred.name}]`, {
                validate: (v) => v.trim().split(/\s+/).filter(Boolean).length === 0
                    ? "empty" : undefined,
            });
            if (n === null) continue;
            const e = await tuiText(`git user email [${cred.email}]`, {
                validate: (v) => v.includes("@") ? undefined : "'@' required",
            });
            if (e === null) continue;
            cred.name = n.trim();
            cred.email = e.trim();
            cred.dirty = true;
            continue;
        }
    }
    writeSession(session);
    if (cred.dirty) {
        for (const note of writeCredentials(cred.name, cred.email)) {
            console.log(`configure: ${note}`);
        }
    }
    return "saved";
}

export default defineCommand({
    name: "configure",
    description:
        "Configure the deployment: target + binaries (wm.required), deployment model + services (deploy.profile), git credentials (dots/shell/.my-credentials)",
    options: {
        target: option(z.string().optional(), {
            description: "set the deploy target directly",
        }),
        add: option(z.string().optional(), {
            description: "comma/space-separated binaries to add",
        }),
        remove: option(z.string().optional(), {
            description: "comma/space-separated binaries to remove",
        }),
        "add-stows": option(z.string().optional(), {
            description: "comma/space-separated stow packages to add (stows.required)",
        }),
        "remove-stows": option(z.string().optional(), {
            description: "comma/space-separated stow packages to drop (stows.required)",
        }),
        "add-subs": option(z.string().optional(), {
            description: "submodule lines to add: pkg:pkg-relative.path[,pkg:path2…] (system.required)",
        }),
        "remove-subs": option(z.string().optional(), {
            description: "submodule entries to drop (\"pkg\" or pkg:path) (system.required)",
        }),
        session: option(z.string().optional(), {
            description: `deployment model session (${SESSIONS.join("|")})`,
        }),
        name: option(z.string().optional(), {
            description: "git user name (stored in dots/shell/.my-credentials)",
        }),
        email: option(z.string().optional(), {
            description: "git user email (stored in dots/shell/.my-credentials)",
        }),
        show: option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "print the current configuration",
        }),
        "dry-run": option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "save nothing; print what the folded apply would run",
        }),
    },
    handler: async ({ flags }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const m = readManifest();
        const cred = readCredentials();

        if (flags.show) {
            const stowsNow = readStows();
            const subsNow = readSubs();
            console.log(`target:	${m.target}`);
            console.log(`binaries:	${m.binaries.join(" ")}`);
            console.log(`session:	${readSession() || "wsl-systemd (default)"}`);
            console.log(`stows:	${stowsNow.packages.join(" ") || "(none)"}`);
            console.log(`submodules:${subsNow.entries.map((e) => " [" + [e.pkg, ...e.paths].join(" ") + "]").join("") || " (none)"}`);
            console.log(`git:	${cred.name || "(unset)"} <${cred.email}>`);
            return;
        }

        // ABSENT credentials (fresh machine): prompt for the two lines
        // unless the caller already supplied them via flags
        let prompted: { name: string; email: string } | null = null;
        if (!cred.name && !cred.email && !flags.name && !flags.email) {
            prompted = await promptCredentials();
        }

        if (flags.target) m.target = flags.target.trim();
        if (flags.add) {
            for (const b of flags.add.split(/[,\s]+/).filter(Boolean)) {
                if (!m.binaries.includes(b)) m.binaries.push(b);
            }
        }
        if (flags.remove) {
            const gone = flags.remove.split(/[,\s]+/).filter(Boolean);
            m.binaries = m.binaries.filter((b) => !gone.includes(b));
        }
        if (flags.session) {
            if (!SESSIONS.includes(flags.session)) {
                console.error(`configure: unknown session, ${flags.session} (valid: ${SESSIONS.join("|")})`);
                process.exit(2);
            }
            writeSession(flags.session);
        }
        // stows.required + system.required flag edits — applied
        // directly (they stand alone; apply/stow flows re-read them)
        if (flags["add-stows"] || flags["remove-stows"]) {
            const s = readStows();
            const drop = (flags["remove-stows"] ?? "").split(/[,\s]+/).filter(Boolean);
            s.packages = s.packages.filter((p) => !drop.includes(p));
            for (const p of (flags["add-stows"] ?? "").split(/[,\s]+/).filter(Boolean)) {
                if (!s.packages.includes(p)) s.packages.push(p);
            }
            writeStows(s);
            console.log(`configure: stows.required now: ${s.packages.join(" ")}`);
        }
        if (flags["add-subs"] || flags["remove-subs"]) {
            const s = readSubs();
            const dropped = (flags["remove-subs"] ?? "").split(/[,\s]+/).filter(Boolean);
            s.entries = s.entries.filter((e) => {
                const whole = [e.pkg, ...(e.paths ?? [])].join(" ");
                return !dropped.includes(whole) && !dropped.includes(e.pkg);
            });
            for (const spec of (flags["add-subs"] ?? "").split(/[,\s]+/).filter(Boolean)) {
                const pkg = spec.split(":", 1)[0];
                let path = spec.slice(pkg.length + 1);
                if (!path) {
                    console.error(`configure: add-subs needs pkg:path, no path in ${spec}`);
                    process.exit(2);
                }
                path = path.replace(/^dots\//, "");
                if (!existsSync(join(DOTS_DIR, path))) {
                    console.error("configure: submodule path does not exist in the dots checkout,");
                console.error(`configure: ${path}`);
                    process.exit(2);
                }
                const existing = s.entries.find((e) => e.pkg === pkg);
                if (!existing) s.entries.push({ pkg, paths: [path] });
                else if (!existing.paths.includes(path)) existing.paths.push(path);
            }
            writeSubs(s);
            console.log(`configure: system.required now ${s.entries.length} package line(s)`);
        }
        let credNotes: string[] | null = null;
        if (prompted) {
            credNotes = writeCredentials(prompted.name, prompted.email);
        } else if (flags.name || flags.email) {
            const n = flags.name ?? cred.name;
            const e = flags.email ?? cred.email;
            const err = validCredentials(n, e);
            if (err) {
                console.error(`configure: ${err}`);
                process.exit(2);
            }
            credNotes = writeCredentials(n, e);
        }

        const modelDirty = flags.session;
        if (!flags.target && !flags.add && !flags.remove && !modelDirty && !credNotes &&
            !flags["add-stows"] && !flags["remove-stows"] && !flags["add-subs"] && !flags["remove-subs"]) {
            // TTY-ONLY menu: bunli 0.9.x prompts hard-fail without an
            // interactive terminal (the old readLine menu tolerated
            // pipes; the opentui one does not). A piped/captured run
            // keeps the recorded manifest and just gets the folded apply.
            const ttyMenu = process.stdin.isTTY && process.stdout.isTTY;
            if (!ttyMenu) {
                console.log("configure: non-interactive");
                console.log("configure: keeping the recorded configuration");
                console.log("configure: applying it");
            }
            if (ttyMenu) {
                const saved = await tuiEdit(m);
                if (saved !== "saved") {
                    // quit: the manifest stays as recorded and NOTHING is
                    // applied (the explicit "quit without saving" menu pick;
                    // re-run deploy to deploy an older recorded config)
                    console.log("configure: quit");
                    console.log("configure: recorded configuration kept");
                    return;
                }
                // the WIZARD: the saved configuration now drives the full
                // deployment — binaries from the repos, each package's
                // install rule, stow, then the deploy target apply.
                const go = await tuiYesNo(
                    "run the full deployment now? (install + package rules + stow + apply)",
                    { initialValue: true },
                );
                if (go === null) {
                    // esc/ctrl-c at the wizard gate: hard cancel
                    console.log("configure: cancelled after save");
                    console.log("configure: deployment stopped");
                    process.exit(130);
                }
                if (!go) {
                    console.log("configure: saved, deployment skipped");
                    console.log("configure: re-run 'make install' to deploy");
                    return;
                }
                if (go) {
                    // the wizard's install confirms + sudo are LINE-READER
                    // flows; the raw-mode TUI session must step down first
                    await releaseTui();
                    console.log("wizard: binaries");
                    const failed = await walk(false, false);
                    if (failed > 0) {
                        console.error(`wizard: ${failed} binary/b missing`);
                        process.exit(1);
                    }
                    console.log("wizard: package install rules");
                    // scope to the stows.required manifest — the individually
                    // deployable packages (novnc/x11vnc/xrdp/xvfb…) must
                    // NOT be swept here: a blanket walk installs them AND
                    // then fails on their unstowed user units
                    const manifest = readWmPackages();
                    const rules = packagesWithMakefiles().filter(
                        (pkg) => manifest.includes(pkg),
                    );
                    const skipped = packagesWithMakefiles().filter(
                        (pkg) => !manifest.includes(pkg),
                    );
                    if (skipped.length > 0) {
                        console.log(`wizard: skipped (not in wm.required): ${skipped.join(" ")}`);
                    }
                    const results: PkgResult[] = [];
                    for (const pkg of rules) {
                        results.push(runRule(pkg, "install"));
                    }
                    printResults(results);
                    if (results.some((r) => !r.ok)) process.exit(1);
                    console.log("wizard: stow");
                    const stowed = stowPackages().map((p) => stowPkg(p));
                    printResults(stowed);
                    console.log("wizard: apply");
                    const applyFailed = await runApply({});
                    if (applyFailed > 0) {
                        console.error(`wizard: apply FAILED (${applyFailed})`);
                        process.exit(1);
                    }
                    console.log("wizard: complete");
                    return;
                }
            }
        }

        // warn when the target has no deploy script
        const script = join(
            process.env.HOME!, ".local/bin/install", `${m.target}.deploy`,
        );
        if (!existsSync(script)) {
            console.error(
                `configure: WARNING — no deploy script for '${m.target}': ${script} missing`,
            );
        }
        writeManifest(m);
        console.log(`configure: target=${m.target} binaries=${m.binaries.join(" ")}`);
        for (const note of credNotes ?? []) {
            console.log(`configure: ${note}`);
        }
        // FOLDED `apply`: configuration APPLIES itself (the generic
        // per-platform step list; the verbose platform detail lives in
        // lib/configureCore.ts). `--dry-run` prints without running.
        const failed = await runApply({ dryRun: !!flags["dry-run"] });
        if (failed > 0) {
            console.error(`configure: ${failed} apply step(s) failed`);
            process.exit(1);
        }
        console.log("configure: saved + applied");
    },
});
