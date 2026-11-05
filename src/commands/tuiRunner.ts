// src/commands/tuiRunner.ts — the shared runner for the TUI package
// verbs: resolve the package list (args, else the bunli-native
// checklist), run the operation per package (output CAPTURED), then
// print the blocks sequentially once the TUI has closed.

import {
    hasMakefile, pkgUnits, printResults, runRule, stowPackages, stowPkg,
    unstowPkg, unitsOp, type PkgResult,
} from "../lib/pkgops";
import { releaseTui, tuiChecklist } from "../lib/tui";

export type Op = "stow" | "unstow" | "enable" | "disable";

export async function pkgOpTui(op: Op, explicit: string[]): Promise<void> {
    let pkgs = explicit;
    if (pkgs.length === 0) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            console.error(`${op}: no packages and no tty`);
            process.exit(2);
        }
        const sel = await tuiChecklist<string>(
            "select packages",
            stowPackages().map((p) => ({ label: p, value: p })),
        );
        // the selection is settled INSIDE the TUI session; the actioning
        // happens in plain CLI mode: release the session (flushes the
        // buffered history to stdout, clears the renderer's buffers and
        // restores the shell's terminal modes) BEFORE any operation runs
        // — otherwise the printed results interleave into the still-
        // painted menu (the broken-screen-on-submit class)
        await releaseTui();
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
