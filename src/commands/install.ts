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

const isInteractive = (): boolean => process.stdin.isTTY === true;


export async function walk(yes: boolean, dryRun: boolean, only?: string[]): Promise<number> {
    const requires = await readRequires();
    const target = requires.target;
    console.log(`target: ${target} (wm.requires)`);
    // fail fast instead of hanging: a non-interactive run without --yes
    // can never answer the per-binary confirmations
    if (!dryRun && !yes && !isInteractive() && missing(await Promise.resolve(requires.binaries)).length > 0) {
        console.error(
            "deploy: non-interactive terminal without --yes — " +
            "the confirmation prompts would hang. Re-run with --yes " +
            "(or interactively).",
        );
        return 1;
    }

    let failed = 0;
    const wanted = only?.length ? requires.binaries.filter((b) => only.includes(b)) : requires.binaries;
    for (const binary of wanted) {
        if (installed(binary)) {
            console.log(`  ${binary.padEnd(20)} already installed`);
            continue;
        }
        const res = await resolvePackage(target, binary);
        if (!res.ok) {
            console.error(`  ${binary.padEnd(20)} UNRESOLVED`);
            console.error(`  ${" ".repeat(20)} ${res.problem ?? ""}`);
            failed += 1;
            continue;
        }
        console.log(`  ${binary.padEnd(20)} MISSING (package: ${res.pkg})`);
        if (dryRun) continue;

        if (!yes) {
            const ok = await confirm(`         install ${res.pkg}? [Y/n] `);
            if (!ok) {
                console.error(`         skipped — ${binary} stays missing`);
                failed += 1;
                continue;
            }
        }
        const inst = await runInstall(target, binary);
        if (!inst.ok) {
            console.error(`         FAILED: ${inst.problem ?? inst.command}`);
            failed += 1;
            continue;
        }
        // re-verify: the install command ran; the binary must exist now
        if (installed(binary)) {
            console.log(`         installed: ${inst.command}`);
        } else {
            console.error(`         FAILED: ${binary} still absent`);
            console.error(`         ran: ${inst.command}`);
            failed += 1;
        }
    }
    return failed;
}

export default defineCommand({
    name: "install",
    description:
        "Install missing required binaries from the target repositories (search + install + re-verify)",
    options: {
        yes: option(z.boolean().optional(), {
            description: "install without confirmation (non-interactive)",
            short: "y",
        }),
        "dry-run": option(z.boolean().optional(), {
            description: "resolve + report, run nothing",
        }),
        only: option(z.string().optional(), {
            description: "comma/space-separated subset of binaries to install",
        }),
    },
    handler: async ({ flags }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const failed = await walk(
            !!flags.yes, !!flags["dry-run"],
            flags.only?.split(/[,\s]+/).filter(Boolean),
        );
        if (failed > 0) {
            console.error(`install: ${failed} requirement(s) unresolved`);
            process.exit(1);
        }
        console.log("install: all requirements satisfied");
    },
});
