// src/commands/install.ts — verb (c): install missing required binaries
// from the target repositories. For every MISSING binary: resolve the
// package (search), show the install command, confirm (unless --force),
// run it with inherited stdio (sudo may prompt), then RE-VERIFY — a
// binary still missing after its install command is a hard failure.
// For every MISSING binary: resolve the package, show the install
// command, confirm (unless --force), run it with inherited stdio
// (sudo may prompt), then RE-VERIFY — a binary still missing after
// its install command is a hard failure for the run.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { checkDotsEnv, readRequires, missing } from "../lib/dots";
import { resolvePackage, runInstall, installed } from "../lib/deployScript";
import { confirm } from "../lib/lines";

const isInteractive = (): boolean => process.stdin.isTTY === true;


export async function walk(yes: boolean, dryRun: boolean, only?: string[]): Promise<number> {
    const requires = await readRequires();
    const target = requires.target;
    console.log(`target: ${target} (wm.required)`);
    // fail fast instead of hanging: a non-interactive run without --force
    // can never answer the per-binary confirmations
    if (!dryRun && !yes && !isInteractive() && missing(requires.binaries).length > 0) {
        console.error(
            "install: aborting, non-interactive without --force — " +
            "install: the confirmation prompts would hang, re-run with --force" +
            "(or interactively).",
        );
        return 1;
    }

    let failed = 0;
    const wanted = only?.length ? requires.binaries.filter((b) => only.includes(b)) : requires.binaries;
    for (const binary of wanted) {
        if (installed(binary)) {
            console.log(`	${binary}	already installed`);
            continue;
        }
        const res = await resolvePackage(target, binary);
        if (!res.ok) {
            console.error(`	${binary}	UNRESOLVED`);
            console.error(`	${" ".repeat(20)} ${res.problem ?? ""}`);
            failed += 1;
            continue;
        }
        console.log(`	${binary}	MISSING (package: ${res.pkg})`);
        if (dryRun) continue;

        if (!yes) {
            const ok = await confirm(`	install ${res.pkg}? [Y/n] `);
            if (ok === "abort") {
                console.error(`install: stopped, EOF (ctrl-d), ${binary} unresolved`);
                process.exit(130);
            }
            if (ok === "no") {
                console.error(`install: skipped, ${binary} stays missing`);
                failed += 1;
                continue;
            }
        }
        const inst = await runInstall(target, binary);
        if (!inst.ok) {
            console.error(`install: FAILED, ${inst.problem ?? inst.command}`);
            failed += 1;
            continue;
        }
        // re-verify: the install command ran; the binary must exist now
        if (installed(binary)) {
            console.log(`	installed: ${inst.command}`);
        } else {
            console.error(`install: FAILED, ${binary} still absent`);
            console.error(`install: ran, ${inst.command}`);
            failed += 1;
        }
    }
    return failed;
}

export default defineCommand({
    name: "install",
    description:
        "Install the missing required binaries via the deploy target (search + install + re-verify)",
    options: {
        force: option(z.boolean().optional(), { argumentKind: "flag" as const,
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
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const failed = await walk(
            !!flags.force, !!flags["dry-run"],
            flags.only?.split(/[,\s]+/).filter(Boolean),
        );
        if (failed > 0) {
            console.error(`install: ${failed} requirement(s) unresolved`);
            process.exit(1);
        }
        console.log("install: all requirements satisfied");
    },
});
