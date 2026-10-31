// src/commands/configure.ts — edit the deployment manifests from a TUI
// (or flags): the deploy TARGET and the REQUIRED-PACKAGE list of
// wm.requires.
//
//   on-deploy configure              TUI (whiptail) / plain prompts
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

/** whiptail: the UI draws on stderr and the RESULT is printed to
 *  stdout — so map stdout=pipe (the captured answer) and leave
 *  stderr/stdin inherited (the caller's terminal). NO fd dance and no
 *  bash wrapper: with stderr piped the TUI has no terminal and hangs
 *  (the bug this replaced). */
function whiptail(args: string[]): string | null {
    const p = Bun.spawnSync(["whiptail", ...args], {
        stdout: "pipe",
        stderr: "inherit",
        stdin: "inherit",
    });
    if ((p.exitCode ?? 1) !== 0) return null; // cancelled
    return (p.stdout ?? "").toString().trim();
}

function hasTty(): boolean {
    return process.stdin.isTTY === true;
}

async function tuiEdit(m: Manifest): Promise<void> {
    // 1. deploy target
    const items: string[] = [];
    for (const t of KNOWN_TARGETS) {
        items.push(t, "", t === m.target ? "ON" : "OFF");
    }
    const custom = !KNOWN_TARGETS.includes(m.target);
    items.push("other", "type a custom target name", custom ? "ON" : "OFF");
    let target = whiptail([
        "--title", "deploy target",
        "--radiolist",
        "Which platform deploy script should on-deploy use?\n(<target>.deploy in ~/.local/bin/install)",
        "0", "60", "0",
        ...items,
    ]);
    if (target === "other") {
        target = whiptail([
            "--title", "custom target", "--inputbox",
            "Deploy target name (the <name>.deploy script must exist):",
            "0", "40", m.target,
        ]);
    }
    if (target) m.target = target.trim();

    // 2. required binaries checklist
    const binItems: string[] = [];
    const known = [...new Set([...CATALOG, ...m.binaries])];
    for (const b of known) binItems.push(b, "", m.binaries.includes(b) ? "ON" : "OFF");
    const picked = whiptail([
        "--title", "required binaries", "--checklist",
        "The binaries wm.requires demands (space toggles):",
        "0", "60", "0",
        ...binItems,
    ]);
    if (picked !== null) {
        const list = picked.replace(/"/g, "").split(/\s+/).filter(Boolean);
        const extra = whiptail([
            "--title", "extra binaries", "--inputbox",
            "Any additional binary names (space-separated, Enter to skip):",
            "0", "50", "",
        ]);
        if (extra) {
            for (const e of extra.split(/\s+/)) {
                if (e && !list.includes(e)) list.push(e);
            }
        }
        m.binaries = list;
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
            if (!hasTty()) {
                console.error("configure: no TTY — use --target/--add/--remove flags");
                process.exit(1);
            }
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
