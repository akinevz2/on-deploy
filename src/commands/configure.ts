// src/commands/configure.ts — edit the deployment manifests from a TUI
// (or flags): the deploy TARGET and the REQUIRED-PACKAGE list of
// wm.depends.
//
//	on-deploy configure	interactive menu / flags
//	on-deploy configure --target arch
//	on-deploy configure --add pkgA,pkgB
//	on-deploy configure --remove pkgA
//	on-deploy configure --show
//
// wm.depends structure: line 1 = whitespace-separated required
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
import { checkDotsEnv, DOTS_DIR, manifestPath, readRequires, readWmPackages } from "../lib/dots";
import { readLine, say } from "../lib/lines";
import { runApply } from "../lib/configureCore";
import { flush } from "../lib/out";
import { walk } from "./install";
import {
    packagesWithMakefiles, printResults, pkgMakefile, runMakeSpun, stowPackages, stowPkg,
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
    const text = readFileSync(manifestPath("wm"), "utf8");
    const all = text.split("\n");
    const content = all.filter((l) => l.trim() && !l.trim().startsWith("#"));
    if (content.length < 2) {
        throw new Error("wm.depends: expected a binaries line and a target line");
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
        join(DOTS_DIR, "wm.depends"),
        [...m.comments, m.binaries.join(" "), m.session, m.target].join("\n") + "\n",
    );
}

// --- the deployment model (the `session =` line of wm.depends) ------------
// The model selects the deploy target implementation (apply): session =
// HOW the graphical session starts. wm.depends IS the manifest —
// binaries line, session line, deploy target line (positional). Comments
// are preserved; only the session line is rewritten in place.

const SESSIONS = ["greetd", "wsl-systemd", "xinit", "nested"];

/** the session model from wm.depends line 2 ("" = absent) */
function readSession(): string {
    const lines = readFileSync(manifestPath("wm"), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
    return lines.length >= 3 ? lines[1] : "";
}

/** rewrite ONLY the session line (wm.depends line 2), comments kept.
 * Reads the LAYERED manifest (user .depends, else the canonical
 * .required) and writes the result to the USER layer — configure
 * never dirties a tracked file. */
function writeSession(session: string): void {
    const lines = readFileSync(manifestPath("wm"), "utf8").split("\n");
    const content = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => l.trim() && !l.trim().startsWith("#"));
    if (content.length >= 3) lines[content[1].i] = session;
    else lines.splice(content[0].i + 1, 0, session);
    writeFileSync(join(DOTS_DIR, "wm.depends"), lines.join("\n"));
}

// --- stow.depends (the STOW manifest) & system.depends (SUBMODULES) ----
// Both are plain list files: comments (#) and blanks preserved, content
// lines rewritten per edit. The configure TUI offers checkslists over
// the same structured pieces; flags accept comma/space separated specs.

interface StowsFile { comments: string[]; packages: string[] }

function readStows(): StowsFile {
    const all = readFileSync(manifestPath("stow"), "utf8").split("\n");
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
        join(DOTS_DIR, "stow.depends"),
        [...s.comments, ...s.packages].join("\n") + "\n",
    );
}

interface SubsFile { comments: string[]; entries: { pkg: string; paths: string[] }[] }

function readSubs(): SubsFile {
    const all = readFileSync(manifestPath("system"), "utf8").split("\n");
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
        join(DOTS_DIR, "system.depends"),
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
    // the shell exports (GIT_NAME/GIT_EMAIL) + git config — a PACKAGE
    // ARTIFACT like every deployed file: dots/shell/.my-credentials-env
    // (gitignored), deployed to $HOME ONLY by stowing the shell
    // package; never written raw into the profile (2026-11 doctrine).
    // Fall back to $HOME only when the package tree is absent.
    const envf = existsSync(join(DOTS_DIR, "shell"))
        ? join(DOTS_DIR, "shell", ".my-credentials-env")
        : join(process.env.HOME!, ".my-credentials-env");
    writeFileSync(envf, `# generated by on-deploy configure\nGIT_NAME='${name}'\nGIT_EMAIL='${email}'\n`);
    try { chmodSync(envf, 0o600); } catch { /* best-effort */ }
    if (existsSync(CRED_HOME)) {
        // the configure flow IS the only credentials interaction point:
        // git config is applied HERE, inline — no standalone helper bins
        // (load-credentials is gone; the shells load the identity at
        // startup via ~/.shellx.rc's GIT_AUTHOR_*/GIT_COMMITTER_* exports)
        const r1 = Bun.spawnSync(["git", "config", "--global", "user.name", name]);
        const r2 = Bun.spawnSync(["git", "config", "--global", "user.email", email]);
        notes.push(
            r1.exitCode === 0 && r2.exitCode === 0
                ? "git config applied"
                : "WARNING: git config rejected the values",
        );
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
 * ABSENT (gitignored; first run on a fresh machine — the shell rc
 * files autoload it once it exists). Two lines: name, email —
 * deliberately on the SIMPLE line reader (lines.ts), NOT the bunli
 *  text prompt: under `make install` the stdin feeding races the
 *  opentui prompt session's initialization (blank screen + lost
 * keystrokes); a plain line read is make-recipe-safe.
 * Returns the values, or null when the user skipped / is non-tty. */
async function promptCredentials(): Promise<{ name: string; email: string } | null> {
    if (existsSync(CRED_REPO) || existsSync(CRED_HOME)) return null;
    if (!process.stdin.isTTY) return null;
    // [FLUSH-CLASS: prompt] everything this function prints must be on
    // the terminal before readLine() waits — never buffer here
    console.log("configure: no git credentials on file (~/.my-credentials missing)");
    console.log("  the shell rc files load git identity from that file at startup —");
    console.log("  two lines: your full name, then your email.");
    for (;;) {
        process.stdout.write("  name  (empty=skip): ");
        const nameLine = await readLine();
        if (nameLine === null) {
            console.log("configure: EOF (ctrl-d) — skipped; git identity stays unset (re-run 'on-deploy configure' later)");
            return null;
        }
        const name = nameLine.trim();
        if (!name) {
            console.log("configure: skipped — git identity stays unset (re-run 'on-deploy configure' later)");
            return null;
        }
        process.stdout.write("  email (empty=skip): ");
        const emailLine = await readLine();
        if (emailLine === null) {
            console.log("configure: EOF (ctrl-d) — skipped; git identity stays unset (re-run 'on-deploy configure' later)");
            return null;
        }
        const email = emailLine.trim();
        if (!email) {
            console.log("configure: skipped — git identity stays unset (re-run 'on-deploy configure' later)");
            return null;
        }
        const warn = validCredentials(name, email);
        if (!warn) return { name, email };
        console.log(`configure: ${warn} — try again (or leave name empty to skip)`);
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
            { label: `deploy target:     ${m.target}`, value: "target" },
            { label: `required binaries: ${m.binaries.join(" ")}`, value: "binaries" },
            { label: `session model:     ${session || "wsl-systemd (default)"}`, value: "session" },
            { label: `stow packages:     ${stows.packages.join(" ") || "(none)"}`, value: "stows" },
            { label: `submodules:        ${subs.entries.map((e) => e.pkg).join(" ") || "(none)"}`, value: "subs" },
            { label: `git credentials:   ${cred.name || "(unset)"} <${cred.email || "none"}>`, value: "credentials" },
            { label: "save + apply", value: "save" },
            { label: "quit without saving", value: "quit" },
        ]);
        if (a === null) {
            // esc/ctrl-c at the ROOT = hard cancel (exit code 130 → make stops)
            console.log("configure: cancelled — nothing saved");
            process.exit(130);
        }
        if (a === "quit") {
            console.log("configure: quit without saving — nothing changed");
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
                "stow packages (stow.depends) — space toggles, enter confirms",
                names.map((p) => ({
                    label: p,
                    value: p,
                    hint: stows.packages.includes(p) ? "stowed" : "",
                })),
                { preselect: stows.packages },
            );
            if (sel === null) continue;
            writeStows({ comments: stows.comments, packages: names.filter((p) => sel.includes(p)) });
            console.log("configure: stow.depends rewritten to the checked set");
            continue;
        }
        if (a === "subs") {
            // keep the manifest entries whose line is still checked;
            // additions loop after the checklist until an empty edit
            const labels = subs.entries.map((e) => [e.pkg, ...e.paths].join(" "));
            const sel = await tuiChecklist<string>(
                "system.depends submodules — UNCHECK a line to DROP it, enter confirms",
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
                    console.log("configure: need <pkg> AND at least one <path> — retry (empty to skip)");
                    continue;
                }
                kept.push({ pkg: fields[0], paths: fields.slice(1) });
            }
            writeSubs({ comments: subs.comments, entries: kept });
            console.log(`configure: system.depends rewritten (${kept.length} package line(s))`);
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
    description: "Edit deploy manifests",
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
            description: "comma/space-separated stow packages to add (stow.depends)",
        }),
        "remove-stows": option(z.string().optional(), {
            description: "comma/space-separated stow packages to drop (stow.depends)",
        }),
        "add-subs": option(z.string().optional(), {
            description: "submodule lines to add: pkg:pkg-relative.path[,pkg:path2…] (system.depends)",
        }),
        "remove-subs": option(z.string().optional(), {
            description: "submodule entries to drop (\"pkg\" or pkg:path) (system.depends)",
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
            say(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const m = readManifest();
        const cred = readCredentials();

        if (flags.show) {
            const stowsNow = readStows();
            const subsNow = readSubs();
            console.log(`target:    ${m.target}`);
            console.log(`binaries:  ${m.binaries.join(" ")}`);
            console.log(`session:   ${readSession() || "wsl-systemd (default)"}`);
            console.log(`stows:     ${stowsNow.packages.join(" ") || "(none)"}`);
            console.log(`submodules:${subsNow.entries.map((e) => " [" + [e.pkg, ...e.paths].join(" ") + "]").join("") || " (none)"}`);
            console.log(`git:       ${cred.name || "(unset)"} <${cred.email}>`);
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
                say(`configure: unknown session '${flags.session}' (${SESSIONS.join("|")})`);
                process.exit(2);
            }
            writeSession(flags.session);
        }
        // stow.depends + system.depends flag edits — applied
        // directly (they stand alone; apply/stow flows re-read them)
        if (flags["add-stows"] || flags["remove-stows"]) {
            const s = readStows();
            const drop = (flags["remove-stows"] ?? "").split(/[,\s]+/).filter(Boolean);
            s.packages = s.packages.filter((p) => !drop.includes(p));
            for (const p of (flags["add-stows"] ?? "").split(/[,\s]+/).filter(Boolean)) {
                if (!s.packages.includes(p)) s.packages.push(p);
            }
            writeStows(s);
            console.log(`configure: stow.depends now: ${s.packages.join(" ")}`);
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
                    say(`configure: add-subs needs pkg:path — '${spec}' has no path`);
                    process.exit(2);
                }
                path = path.replace(/^dots\//, "");
                if (!existsSync(join(DOTS_DIR, path))) {
                    say(`configure: submodule path '${path}' does not exist in the dots checkout`);
                    process.exit(2);
                }
                const existing = s.entries.find((e) => e.pkg === pkg);
                if (!existing) s.entries.push({ pkg, paths: [path] });
                else if (!existing.paths.includes(path)) existing.paths.push(path);
            }
            writeSubs(s);
            console.log(`configure: system.depends now ${s.entries.length} package line(s)`);
        }
        let credNotes: string[] | null = null;
        if (prompted) {
            credNotes = writeCredentials(prompted.name, prompted.email);
        } else if (flags.name || flags.email) {
            const n = flags.name ?? cred.name;
            const e = flags.email ?? cred.email;
            const err = validCredentials(n, e);
            if (err) {
                say(`configure: ${err}`);
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
            // [FLUSH-CLASS: exec] the flag-edit/quit/wizard prints below
            // all order against the TUI drain (releaseTui → stdout
            // history) or the runApply subprocess — none may queue
            if (!ttyMenu) {
                console.log("configure: non-interactive — keeping the recorded configuration; applying it");
            }
            if (ttyMenu) {
                const saved = await tuiEdit(m);
                if (saved !== "saved") {
                    // quit: the manifest stays as recorded and NOTHING is
                    // applied (the explicit "quit without saving" menu pick;
                    // re-run deploy to deploy an older recorded config)
                    // the session MUST step down before returning — a live
                    // renderer keeps the event loop alive and the beforeExit
                    // dispose wedges (idle() never settles) → hung process
                    await releaseTui();
                    console.log("configure: quit — recorded configuration kept");
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
                    console.log("configure: cancelled after save — deployment stopped");
                    await releaseTui();
                    process.exit(130);
                }
                if (!go) {
                    // saved without deploying: the session must step down
                    // BEFORE returning (same hang class as the quit path)
                    await releaseTui();
                    console.log("configure: saved (deployment skipped — re-run 'make install' to deploy)");
                    return;
                }
                if (go) {
                    // the wizard's install confirms + sudo are LINE-READER
                    // flows; the raw-mode TUI session must step down first
                    await releaseTui();
                    // [FLUSH-CLASS: exec] releaseTui() drains the TUI
                    // history onto stdout — these banners must land in
                    // that ordering, never queued behind it
                    console.log("wizard: tui released (cooked terminal)");
                    console.log("wizard: binaries");
                    // [FLUSH-CLASS: exit] the walk's buffered verdict
                    // flushes before the failure gate reads the value
                    const failed = flush(await walk(false, false));
                    if (failed > 0) {
                        say(`wizard: ${failed} binary/b missing`);
                        process.exit(1);
                    }
                    if (process.env.ONDEPLOY_INSTALL_CHAIN === "1") {
                        // CALLED FROM THE DOTS INSTALL RECIPE: the caller
                        // owns preserve -> package rules -> stow -> apply
                        // right after this (running them here ran the
                        // package install procedure TWICE). The requirement
                        // walk above still runs — the chain has no
                        // binaries walk of its own.
                        console.log("wizard: rules/stow/apply deferred to the caller (the dots install chain)");
                        return;
                    }
                    console.log("wizard: package install rules");
                    // scope to the stow.depends manifest — the individually
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
                        console.log(`wizard: skipped (not in wm.depends): ${skipped.join(" ")}`);
                    }
                    const results: PkgResult[] = [];
                    for (const pkg of rules) {
                        const mf = pkgMakefile(pkg);
                        if (!mf) { results.push({ pkg, ok: false, lines: ["no Makefile"] }); continue; }
                        const r = await runMakeSpun(mf.dir, mf.file, [], "install", `${pkg}:install`);
                        results.push({ pkg, ok: r.ok, lines: r.lines });
                    }
                    printResults(results);
                    if (results.some((r) => !r.ok)) process.exit(1);
                    console.log("wizard: stow");
                    const stowed = stowPackages().map((p) => stowPkg(p));
                    printResults(stowed);
                    console.log("wizard: apply");
                    const applyFailed = await runApply({});
                    if (applyFailed > 0) {
                        say(`wizard: apply FAILED (${applyFailed})`);
                        process.exit(1);
                    }
                    console.log("wizard: complete");
                    return;
                }
            }
        }

        // warn when the target has no deploy script
        // [FLUSH-CLASS: exec] the save report + apply banners order
        // against runApply's subprocess output below
        const script = join(
            process.env.HOME!, ".local/bin/install", `${m.target}.deploy`,
        );
        if (!existsSync(script)) {
            say(
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
            say(`configure: ${failed} apply step(s) failed`);
            process.exit(1);
        }
        console.log("configure: saved + applied");
    },
});
