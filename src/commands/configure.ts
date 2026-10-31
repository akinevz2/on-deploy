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
import { runApply } from "../lib/applyCore";
import { walk } from "./install";
import {
    packagesWithMakefiles, printResults, runRule, stowPackages, stowPkg,
    whiptailYesNo, type PkgResult,
} from "../lib/pkgops";

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

// One-line stdin reader — NOT node:readline (bun's readline wedges;
// see deploy.ts). Resolves per newline, so scripted feeds work too.
async function tuiEdit(m: Manifest): Promise<boolean> {
    const list = (): string => m.binaries.join(" ");
    const cred = readCredentials() as { name: string; email: string; dirty?: boolean };

    const toggleList = async (title: string, items: string[], sel: string[]): Promise<void> => {
        console.log(`    ${title}:`);
        items.forEach((b, i) =>
            console.log(`      ${String(i + 1).padStart(2)}) ${sel.includes(b) ? "[x]" : "[ ]"} ${b}`),
        );
        process.stdout.write("    toggle numbers (space-separated, empty=skip): ");
        const t = (await readLine()).trim();
        for (const tok of t.split(/\s+/).filter(Boolean)) {
            const n = Number.parseInt(tok, 10);
            if (!Number.isFinite(n) || n < 1 || n > items.length) continue;
            const b = items[n - 1];
            const at = sel.indexOf(b);
            if (at >= 0) sel.splice(at, 1);
            else sel.push(b);
        }
    };

    for (;;) {
        console.log("");
        console.log("wm.requires");
        console.log(`  1) deploy target    : ${m.target}`);
        console.log(`  2) required binaries: ${list()}`);
        console.log("deployment model (wm.requires session line)");
        console.log(`  3) session model    : ${readSession() || "(default)"}`);
        console.log("credentials (dots/shell/.my-credentials, stowed)");
        console.log(`  4) git credentials  : ${cred.name} <${cred.email}>`);
        console.log("  s) save & exit");
        console.log("  q) quit without saving");
        process.stdout.write("choice: ");
        const a = (await readLine()).trim().toLowerCase();
        if (a === "s" || a === "") break;
        if (a === "q") return false;

        if (a === "1") {
            console.log(`    targets: ${KNOWN_TARGETS.join(", ")} — or a custom name`);
            process.stdout.write("    target: ");
            const t = (await readLine()).trim();
            if (t) m.target = t;
            continue;
        }
        if (a === "2") {
            console.log("    catalog:");
            const known = [...new Set([...CATALOG, ...m.binaries])];
            known.forEach((b, i) =>
                console.log(`      ${String(i + 1).padStart(2)}) ${m.binaries.includes(b) ? "[x]" : "[ ]"} ${b}`),
            );
            process.stdout.write(
                "    toggle numbers (space-separated, empty=skip): ",
            );
            const t = (await readLine()).trim();
            for (const tok of t.split(/\s+/).filter(Boolean)) {
                const n = Number.parseInt(tok, 10);
                if (!Number.isFinite(n) || n < 1 || n > known.length) continue;
                const b = known[n - 1];
                const at = m.binaries.indexOf(b);
                if (at >= 0) m.binaries.splice(at, 1);
                else m.binaries.push(b);
            }
            process.stdout.write(
                "    additional binaries to ADD (comma-separated, empty=skip): ",
            );
            const add = (await readLine()).trim();
            for (const b of add.split(/[,\s]+/).filter(Boolean)) {
                if (!m.binaries.includes(b)) m.binaries.push(b);
            }
            process.stdout.write(
                "    binaries to REMOVE (comma-separated, empty=skip): ",
            );
            const rm = (await readLine()).trim();
            m.binaries = m.binaries.filter(
                (b) => !rm.split(/[,\s]+/).filter(Boolean).includes(b),
            );
            continue;
        }
        if (a === "3") {
            console.log(`    session models: ${SESSIONS.join(", ")}`);
            process.stdout.write("    session: ");
            let model = readSession();
            const t = (await readLine()).trim();
            if (t && SESSIONS.includes(t)) model = t;
            continue;
        }
        if (a === "4") {
            process.stdout.write(`    name (three words) [${cred.name}]: `);
            const n = (await readLine()).trim() || cred.name;
            process.stdout.write(`    email [${cred.email}]: `);
            const e = (await readLine()).trim() || cred.email;
            const err = validCredentials(n, e);
            if (err) { console.log(`    invalid: ${err}`); continue; }
            cred.name = n;
            cred.email = e;
            cred.dirty = true;
            continue;
        }
    }
    writeSession(readSession());
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
            console.log(`target:    ${m.target}`);
            console.log(`binaries:  ${m.binaries.join(" ")}`);
            console.log(`session:   ${readSession() || "wsl-systemd (default)"}`);
            console.log(`git:       ${cred.name} <${cred.email}>`);
            return;
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
        if (flags.name || flags.email) {
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
            // the menu works on a tty (interactive) and over a pipe
            // (scripted feeds); EOF terminates it with a save
            const saved = await tuiEdit(m);
            if (!saved) {
                console.log("configure: quit — nothing deployed");
                return;
            }
            // the WIZARD: the saved configuration now drives the full
            // deployment — binaries from the repos, each package's
            // install rule, stow, then the deploy target apply. Output is
            // printed sequentially per phase (the TUI has closed).
            if (process.stdin.isTTY) {
                const go = whiptailYesNo(
                    "configure", "run the full deployment now?\n(install + package rules + stow + apply)",
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
                }
            }
            return;
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
    },
});
