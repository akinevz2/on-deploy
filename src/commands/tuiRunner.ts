// src/commands/tuiRunner.ts — the shared runner for the TUI package
// verbs: resolve the package list (args, else the bunli-native
// checklist), run the operation per package (output CAPTURED), then
// print the blocks sequentially once the TUI has closed.

import type { PromptApi } from "@bunli/core";
import {
    hasMakefile, pkgUnits, printResults, runRule, stowPackages, stowPkg,
    unstowPkg, unitsOp, type PkgResult,
} from "../lib/pkgops";
import { tuiChecklist } from "../lib/tui";

export type Op = "stow" | "unstow" | "enable" | "disable";

export async function pkgOpTui(op: Op, explicit: string[], prompt: PromptApi): Promise<void> {
    let pkgs = explicit;
    if (pkgs.length === 0) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            console.error(`${op}: no packages and no tty`);
            process.exit(2);
        }
        const sel = await tuiChecklist(prompt, `on-deploy ${op}`, "select packages", stowPackages());
        if (sel === null) {
            console.log(`${op}: cancelled`);
            return;
        }
        pkgs = sel;
    }
    const known = stowPackages();
    const unknown = pkgs.filter((p) => !known.includes(p));
    for (const p of unknown) console.log(`${op}: not a dots package: ${p}`);
    const targets = pkgs.filter((p) => known.includes(p));

    const results: PkgResult[] = [];
    for (const pkg of targets) {
        if (op === "stow") { results.push(stowPkg(pkg)); continue; }
        if (op === "unstow") { results.push(unstowPkg(pkg)); continue; }
        if (hasMakefile(pkg)) {
            // the package owns its enable/disable: its Makefile rule
            results.push(runRule(pkg, op));
            continue;
        }
        const units = pkgUnits(pkg);
        results.push(
            units.length > 0
                ? unitsOp(pkg, op)
                : { pkg, ok: true, lines: [`nothing to ${op}`] },
        );
    }
    printResults(results);
    if (results.some((r) => !r.ok)) process.exit(1);
}
