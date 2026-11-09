// src/commands/install.ts — verb (c): install missing required binaries
// from the target repositories. For every MISSING binary: resolve the
// package (search), show the install command, confirm (unless --yes),
// run it with inherited stdio (sudo may prompt), then RE-VERIFY — a
// binary still missing after its install command is a hard failure.
// For every MISSING binary: resolve the package, show the install
// command, confirm (unless --yes), run it with inherited stdio
// (sudo may prompt), then RE-VERIFY — a binary still missing after
// its install command is a hard failure for the run.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { checkDotsEnv, readRequires, missing } from "../lib/dots";
import { resolvePackage, runInstall, installed } from "../lib/deployScript";
import { confirm, say } from "../lib/lines";
import { sudoPreauth } from "../lib/provisioners";

const isInteractive = (): boolean => process.stdin.isTTY === true;


export async function walk(yes: boolean, dryRun: boolean, only?: string[]): Promise<number> {
    const requires = await readRequires();
    const target = requires.target;
    console.log(`target: ${target} (wm.depends)`);
    // fail fast instead of hanging: a non-interactive run without --yes
    // can never answer the per-binary confirmations
    if (!dryRun && !yes && !isInteractive() && missing(requires.binaries).length > 0) {
        say(
            "deploy: non-interactive terminal without --yes — " +
            "the confirmation prompts would hang. Re-run with --yes " +
            "(or interactively).",
        );
        return 1;
    }

    let failed = 0;
    const wanted = only?.length ? requires.binaries.filter((b) => only.includes(b)) : requires.binaries;
    // the sudo grant is the FIRST interaction, before ANY output: the
    // walk's root operations (apt/pacman installs) must never prompt
    // mid-run — the pre-request happens on a clean tty here or the
    // run aborts
    const absentNow = wanted.filter((b) => !installed(b));
    if (absentNow.length > 0 && !(await sudoPreauth(
        `root access is required to install ${absentNow.length} missing requirement(s) via the deploy target's package manager (${absentNow.join(", ")})`,
        dryRun,
    ))) {
        say("sudo: credentials not granted (refused, or no tty to prompt on) — run `sudo -v` first, or --dry-run to resolve only");
        return 1;
    }
    for (const binary of wanted) {
        if (installed(binary)) {
            console.log(`  ${binary.padEnd(20)} already installed`);
            continue;
        }
        const res = await resolvePackage(target, binary);
        if (!res.ok) {
            say(`  ${binary.padEnd(20)} UNRESOLVED`);
            say(`  ${" ".repeat(20)} ${res.problem ?? ""}`);
            failed += 1;
            continue;
        }
        console.log(`  ${binary.padEnd(20)} MISSING (package: ${res.pkg})`);
        if (dryRun) continue;

        if (!yes) {
            const ok = await confirm(`         install ${res.pkg}? [Y/n] `);
            if (ok === "abort") {
                say(`         EOF (ctrl-d): stopped — ${binary} unresolved`);
                process.exit(130);
            }
            if (ok === "no") {
                say(`         skipped — ${binary} stays missing`);
                failed += 1;
                continue;
            }
        }
        const inst = await runInstall(target, binary);
        if (!inst.ok) {
            say(`         FAILED: ${inst.problem ?? inst.command}`);
            failed += 1;
            continue;
        }
        // re-verify: the install command ran; the binary must exist now
        if (installed(binary)) {
            console.log(`         installed: ${inst.command}`);
        } else {
            say(`         FAILED: ${binary} still absent`);
            say(`         ran: ${inst.command}`);
            failed += 1;
        }
    }
    return failed;
}

export default defineCommand({
    name: "install",
    description: "Install missing binaries",
    options: {
        yes: option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "install without confirmation (non-interactive)",
            short: "y",
        }),
        "dry-run": option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "resolve + report, run nothing",
        }),
        only: option(z.string().optional(), {
            description: "comma/space-separated subset of binaries to install",
        }),
    },
    handler: async ({ flags }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            say(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const failed = await walk(
            !!flags.yes, !!flags["dry-run"],
            flags.only?.split(/[,\s]+/).filter(Boolean),
        );
        if (failed > 0) {
            say(`install: ${failed} requirement(s) unresolved`);
            process.exit(1);
        }
        console.log("install: all requirements satisfied");
        // EXPLICIT exit: the line-reader's stdin listener (lines.ts
        // attach) keeps the event loop alive on a TTY — stdin never
        // EOFs there, and a fall-off-the-end handler hung the walk
        // forever after its final line (the make-install hang)
        process.exit(0);
    },
});
