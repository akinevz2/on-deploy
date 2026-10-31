// src/commands/deploy.ts — the interactive (or --yes) requirement walk.
// For every MISSING binary: resolve the package, show the install
// command, confirm (unless --yes), run it with inherited stdio
// (sudo may prompt), then RE-VERIFY — a binary still missing after
// its install command is a hard failure for the run.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { checkDotsEnv, readRequires, missing } from "../lib/dots";
import { resolvePackage, runInstall, installed } from "../lib/deployScript";

const isInteractive = (): boolean => process.stdin.isTTY === true;

// One-line stdin reader — NOT node:readline: bun's readline wedges or
// rejects ("readline was closed") around spawned processes and stream
// closes; a raw data-event reader is bulletproof under bun.
function readLine(): Promise<string> {
    return new Promise((resolve) => {
        let buf = "";
        const dec = new TextDecoder();
        const done = (value: string) => {
            process.stdin.off("data", onData);
            process.stdin.off("end", onEnd);
            process.stdin.off("close", onEnd);
            resolve(value);
        };
        const onData = (chunk: Uint8Array | string) => {
            buf += typeof chunk === "string" ? chunk : dec.decode(chunk);
            const i = buf.indexOf("\n");
            if (i >= 0) done(buf.slice(0, i));
        };
        const onEnd = () => done("");
        process.stdin.on("data", onData);
        process.stdin.once("end", onEnd);
        process.stdin.once("close", onEnd);
    });
}

async function confirm(prompt: string): Promise<boolean> {
    // a non-TTY stdin never EOFs mid-session: a blocking read would
    // hang forever. Non-interactive runs must say --yes (the dots
    // house convention: service-action's YES=1 gate).
    if (!isInteractive()) {
        console.error("         non-interactive without --yes — skipped");
        return false;
    }
    process.stdout.write(prompt);
    const a = (await readLine()).trim().toLowerCase();
    return a === "" || a === "y" || a === "yes"; // [Y/n]: Enter = yes
}

export async function walk(yes: boolean, dryRun: boolean): Promise<number> {
    const requires = await readRequires();
    const target = requires.target;
    console.log(`deploy target: ${target} (from wm.requires)`);
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
    for (const binary of requires.binaries) {
        if (installed(binary)) {
            console.log(`  ${binary.padEnd(20)} already installed`);
            continue;
        }
        const res = await resolvePackage(target, binary);
        if (!res.ok) {
            console.error(`  ${binary.padEnd(20)} UNRESOLVABLE: ${res.problem}`);
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
            console.error(`         FAILED: '${binary}' still not on PATH after: ${inst.command}`);
            failed += 1;
        }
    }
    return failed;
}

export default defineCommand({
    name: "deploy",
    description: "Install every missing required binary (interactive unless --yes)",
    options: {
        yes: option(z.boolean().optional(), {
            description: "install without confirmation (non-interactive)",
            short: "y",
        }),
        "dry-run": option(z.boolean().optional(), {
            description: "resolve + report, run nothing",
        }),
    },
    handler: async ({ flags }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const failed = await walk(!!flags.yes, !!flags["dry-run"]);
        if (failed > 0) {
            console.error(`deploy: ${failed} requirement(s) unresolved`);
            process.exit(1);
        }
        console.log("deploy: all requirements satisfied");
    },
});
