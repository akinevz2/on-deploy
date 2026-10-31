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
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { checkDotsEnv, DOTS_DIR } from "../lib/dots";
import { readLine } from "../lib/lines";

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

// One-line stdin reader — NOT node:readline (bun's readline wedges;
// see deploy.ts). Resolves per newline, so scripted feeds work too.
async function tuiEdit(m: Manifest): Promise<void> {
    const list = (): string => m.binaries.join(" ");

    for (;;) {
        console.log("");
        console.log("wm.requires");
        console.log(`  1) deploy target   : ${m.target}`);
        console.log(`  2) required binaries: ${list()}`);
        console.log(`  s) save & exit`);
        console.log(`  q) quit without saving`);
        process.stdout.write("choice: ");
        const a = (await readLine()).trim().toLowerCase();
        if (a === "s" || a === "") break;
        if (a === "q") return;

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
    }
}

export default defineCommand({
    name: "configure",
    description:
        "Edit the deploy target + required-package list of wm.requires (TUI or flags)",
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
        show: option(z.boolean().optional(), {
            description: "print the current manifest",
        }),
    },
    handler: async ({ flags }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const m = readManifest();

        if (flags.show) {
            console.log(`target:   ${m.target}`);
            console.log(`binaries: ${m.binaries.join(" ")}`);
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

        if (!flags.target && !flags.add && !flags.remove) {
            // the menu works on a tty (interactive) and over a pipe
            // (scripted feeds); EOF terminates it with a save
            await tuiEdit(m);
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
    },
});
