// src/commands/configure.ts — edit the deployment manifests from a TUI
// (or flags): the deploy TARGET and the REQUIRED-PACKAGE list of
// wm.requires.
//
//   on-deploy configure              interactive menu / flags
//   on-deploy configure --target arch
//   on-deploy configure --add pkgA,pkgB
//   on-deploy configure --remove pkgA
//   on-deploy configure --show
//
// wm.requires structure: line 1 = whitespace-separated required
// binaries; the LAST non-comment line = the deploy target name
// (selecting ~/.local/bin/install/<target>.deploy). Comments (#) are
// preserved; edits rewrite only the two content lines.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { join } from "node:path";
import {
    readFileSync, writeFileSync, existsSync, readdirSync,
    chmodSync, symlinkSync, realpathSync,
} from "node:fs";
import { checkDotsEnv, DOTS_DIR, readRequires } from "../lib/dots";
import { readLine } from "../lib/lines";
import { runApply } from "../lib/configureCore";
import { walk } from "./install";
import {
    packagesWithMakefiles, printResults, runRule, stowPackages, stowPkg,
    type PkgResult,
} from "../lib/pkgops";
import type { PromptApi } from "@bunli/core";
import { tuiText } from "../lib/tui";

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
    target: string;
}

function readManifest(): Manifest {
    const text = readFileSync(join(DOTS_DIR, "wm.requires"), "utf8");
    const all = text.split("\n");
    const content = all.filter((l) => l.trim() && !l.trim().startsWith("#"));
    if (content.length < 2) {
        throw new Error("wm.requires: expected a binaries line and a target line");
    }
    const comments = all.slice(0, all.indexOf(content[0]));
    return {
        comments,
        binaries: content[0].trim().split(/\s+/).filter(Boolean),
        target: content[content.length - 1].trim(),
    };
}

function writeManifest(m: Manifest): void {
    const body = [...m.comments, m.binaries.join(" "), m.target];
    writeFileSync(join(DOTS_DIR, "wm.requires"), body.join("\n") + "\n");
}

// --- the deployment model (the `session =` line of wm.requires) ------------
// The model selects the deploy target implementation (apply): session =
// HOW the graphical session starts. wm.requires IS the single manifest —
// binaries line, session line, deploy target line (positional). Comments
// are preserved; only the session line is rewritten in place.

const SESSIONS = ["greetd", "wsl-systemd", "xinit", "nested"];

/** the session model from wm.requires line 2 ("" = absent) */
function readSession(): string {
    const lines = readFileSync(join(DOTS_DIR, "wm.requires"), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
    return lines.length >= 3 ? lines[1] : "";
}

/** rewrite ONLY the session line (wm.requires line 2), comments kept */
function writeSession(session: string): void {
    const path = join(DOTS_DIR, "wm.requires");
    const lines = readFileSync(path, "utf8").split("\n");
    const content = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => l.trim() && !l.trim().startsWith("#"));
    if (content.length >= 3) lines[content[1].i] = session;
    else lines.splice(content[0].i + 1, 0, session);
    writeFileSync(path, lines.join("\n"));
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
    // ~/.my-credentials must expose the repo file; create the stow
    // link when absent (stow owns it afterwards)
    if (!existsSync(CRED_HOME)) {
        symlinkSync(CRED_REPO, CRED_HOME);
        notes.push(`linked ${CRED_HOME} -> ${CRED_REPO}`);
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
    if (words.length !== 3) return "name: exactly three words required";
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
    console.log("  the shell rc files load git identity from that file at startup —");
    console.log("  two lines: your full name (three words), then your email.");
    for (;;) {
        process.stdout.write("  name  (three words, empty=skip): ");
        const name = (await readLine()).trim();
        if (!name) {
            console.log("configure: skipped — git identity stays unset (re-run 'on-deploy configure' later)");
            return null;
        }
        process.stdout.write("  email (empty=skip): ");
        const email = (await readLine()).trim();
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
async function tuiEdit(prompt: PromptApi, m: Manifest): Promise<boolean> {
    const cred = readCredentials() as { name: string; email: string; dirty?: boolean };
    let session = readSession();

    for (;;) {
        const a = await prompt.select("configure — what to edit?", {
            options: [
                { label: `deploy target:     ${m.target}`, value: "target" },
                { label: `required binaries: ${m.binaries.join(" ")}`, value: "binaries" },
                { label: `session model:     ${session || "wsl-systemd (default)"}`, value: "session" },
                { label: `git credentials:   ${cred.name || "(unset)"} <${cred.email || "none"}>`, value: "credentials" },
                { label: "save + apply", value: "save" },
                { label: "quit without saving", value: "quit" },
            ],
        });
        if (prompt.isCancel(a)) {
            console.log("configure: cancelled — nothing saved");
            return false;
        }
        if (a === "quit") return false;
        if (a === "save") break;

        if (a === "target") {
            const t = await prompt.select("deploy target", {
                options: [
                    ...KNOWN_TARGETS.map((k) => ({ label: k, value: k })),
                    { label: "custom name…", value: "__custom" },
                ],
            });
            if (prompt.isCancel(t)) continue;
            if (t === "__custom") {
                const c = await tuiText(prompt, "custom target name", {
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
            const sel = await prompt.multiselect("required binaries — space toggles, enter confirms", {
                options: known.map((b) => ({
                    label: b,
                    value: b,
                    hint: CATALOG.includes(b) ? "catalog" : "extra",
                })),
                initialValues: m.binaries,
            });
            if (prompt.isCancel(sel)) continue;
            // keep the manifest order stable: known-list order, then
            // anything not listed (defensive)
            m.binaries = known.filter((b) => sel.includes(b));
            const extra = sel.filter((b) => !known.includes(b));
            if (extra.length > 0) m.binaries.push(...extra);
            continue;
        }
        if (a === "session") {
            const s = await prompt.select("deployment model — how the graphical session starts", {
                options: SESSIONS.map((k) => ({ label: k, value: k })),
                default: SESSIONS.includes(session) ? session : undefined,
            });
            if (prompt.isCancel(s)) continue;
            session = s;
            continue;
        }
        if (a === "credentials") {
            const n = await tuiText(prompt, `git user name (three words) [${cred.name}]`, {
                validate: (v) => v.trim().split(/\s+/).filter(Boolean).length !== 3
                    ? "exactly three words required" : undefined,
            });
            if (n === null) continue;
            const e = await tuiText(prompt, `git user email [${cred.email}]`, {
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
    return true;
}

export default defineCommand({
    name: "configure",
    description:
        "Configure the deployment: target + binaries (wm.requires), deployment model + services (deploy.profile), git credentials (dots/shell/.my-credentials)",
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
        session: option(z.string().optional(), {
            description: `deployment model session (${SESSIONS.join("|")})`,
        }),
        name: option(z.string().optional(), {
            description: "git user name (three words; stored in dots/shell/.my-credentials)",
        }),
        email: option(z.string().optional(), {
            description: "git user email (stored in dots/shell/.my-credentials)",
        }),
        show: option(z.boolean().optional(), {
            description: "print the current configuration",
        }),
        "dry-run": option(z.boolean().optional(), {
            description: "save nothing; print what the folded apply would run",
        }),
    },
    handler: async ({ flags, prompt }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const m = readManifest();
        const cred = readCredentials();

        if (flags.show) {
            console.log(`target:    ${m.target}`);
            console.log(`binaries:  ${m.binaries.join(" ")}`);
            console.log(`session:   ${readSession() || "wsl-systemd (default)"}`);
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
                console.error(`configure: unknown session '${flags.session}' (${SESSIONS.join("|")})`);
                process.exit(2);
            }
            writeSession(flags.session);
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
        if (!flags.target && !flags.add && !flags.remove && !modelDirty && !credNotes) {
            // TTY-ONLY menu: bunli 0.9.x prompts hard-fail without an
            // interactive terminal (the old readLine menu tolerated
            // pipes; the opentui one does not). A piped/captured run
            // keeps the recorded manifest and just gets the folded apply.
            const ttyMenu = process.stdin.isTTY && process.stdout.isTTY;
            if (!ttyMenu) {
                console.log("configure: non-interactive — keeping the recorded configuration; applying it");
            }
            if (ttyMenu) {
                const saved = await tuiEdit(prompt, m);
                if (!saved) {
                    console.log("configure: quit — nothing deployed");
                    return;
                }
                // the WIZARD: the saved configuration now drives the full
                // deployment — binaries from the repos, each package's
                // install rule, stow, then the deploy target apply.
                const go = await prompt.confirm(
                    "run the full deployment now? (install + package rules + stow + apply)",
                    { default: true },
                );
                if (go) {
                    console.log("wizard: binaries");
                    const failed = await walk(false, false);
                    if (failed > 0) {
                        console.error(`wizard: ${failed} binary/b missing`);
                        process.exit(1);
                    }
                    console.log("wizard: package install rules");
                    const results: PkgResult[] = [];
                    for (const pkg of packagesWithMakefiles()) {
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
