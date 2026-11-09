// src/commands/install.ts — verb (c): install missing required binaries
// from the target repositories, BATCHED: resolve every missing binary
// up front, then run ONE package-manager command for the whole deduped
// package set (one sudo elevation, one apt/pacman invocation, ONE
// consent gate — skipped entirely under --yes; the package manager
// itself runs -y/--noconfirm once consent is given). Re-verify EVERY
// planned binary afterwards — one still missing after the batch is a
// hard failure for the run.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { checkDotsEnv, readRequires, missing } from "../lib/dots";
import { resolvePackage, installed, scriptPath } from "../lib/deployScript";
import { say } from "../lib/lines";
import { bind, flush, map, pure, tell, type Out } from "../lib/out";
import { sudoPreauth } from "../lib/provisioners";

const isInteractive = (): boolean => process.stdin.isTTY === true;


export async function walk(yes: boolean, dryRun: boolean, only?: string[]): Promise<Out<number>> {
    const requires = await readRequires();
    const target = requires.target;
    // [FLUSH-CLASS: prompt] the sudo preauth below asks on the tty —
    // the banner must be on the terminal before anything waits on input
    flush(tell(`target: ${target} (wm.depends)`));
    // fail fast instead of hanging: a non-interactive run without --yes
    // can never answer the per-binary confirmations
    if (!dryRun && !yes && !isInteractive() && missing(requires.binaries).length > 0) {
        return pure(1,
            "deploy: non-interactive terminal without --yes — " +
            "the confirmation prompts would hang. Re-run with --yes " +
            "(or interactively).",
        );
    }

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
        return pure(1,
            "sudo: credentials not granted (refused, or no tty to prompt on) — run `sudo -v` first, or --dry-run to resolve only",
        );
    }
    // PHASE 1 — report + resolve every missing binary up front: the
    // batch installs ALL resolved packages in ONE package-manager
    // command (one sudo elevation, one apt/pacman run, ONE consent
    // gate — never a per-package prompt).
    // [FLUSH-CLASS: buffered] the phase-1 report rides Out; it is
    // flushed at the phase-2 exec boundary (before any child output
    // could interleave) or returned for the handler's exit flush.
    let report = pure(0);
    const plans: { binary: string; pkg: string }[] = [];
    for (const binary of wanted) {
        if (installed(binary)) {
            report = bind(report, (f) => pure(f, `  ${binary.padEnd(20)} already installed`));
            continue;
        }
        const res = await resolvePackage(target, binary);
        if (!res.ok) {
            report = bind(report, (f) => pure(f + 1,
                `  ${binary.padEnd(20)} UNRESOLVED`,
                `  ${" ".repeat(20)} ${res.problem ?? ""}`,
            ));
            continue;
        }
        report = bind(report, (f) => pure(f, `  ${binary.padEnd(20)} MISSING (package: ${res.pkg as string})`));
        plans.push({ binary, pkg: res.pkg as string });
    }
    if (dryRun || plans.length === 0) return report;

    // [FLUSH-CLASS: exec] the phase-1 report lands NOW — the template
    // resolution and the batch below run children with inherited
    // stdio; queued lines would interleave out of order
    let out: Out<number> = pure(flush(report));

    // PHASE 2 — the BATCH command. The deploy script owns the command
    // SHAPE (`install <binary>` prints it); resolve it once for the
    // first planned binary and swap the trailing package token for the
    // whole deduped batch. Consent is ONE gate (skipped under --yes);
    // once consent is given the package manager runs
    // non-interactively (-y / --noconfirm) so it never re-asks.
    const pkgs = [...new Set(plans.map((p) => p.pkg))];
    const tmplProc = Bun.spawn(
        [scriptPath(target), "install", plans[0].binary],
        { stdout: "pipe", stderr: "ignore" },
    );
    const tmplCode = await tmplProc.exited;
    const tmpl = (await new Response(tmplProc.stdout).text()).trim();
    if (tmplCode !== 0 || !tmpl) {
        const lines = plans.map((p) =>
            `         FAILED: no install command for '${p.binary}' (${target}.deploy install)`);
        return pure(out.value + plans.length, ...lines);
    }
    const base = tmpl.split(/\s+/).slice(0, -1);
    if (base.some((t) => t.endsWith("apt"))) base.push("-y");
    else if (base.some((t) => t.endsWith("pacman"))) base.push("--noconfirm");
    const batchCmd = [...base, ...pkgs].join(" ");

    if (!yes) {
        // CONSENT DOCTRINE (2026-11): the sudo preauth above IS the
        // consent gate — the user typed the root password for exactly
        // this install, and the batch runs -y/--noconfirm. Any FURTHER
        // prompt after the grant is removed: every post-grant
        // interaction is a freeze class (the line-reader + the sudo
        // tty pump compete; see sudoPreauth's contract comment). A
        // user who does not want the install answers the sudo prompt
        // with ctrl-c, which aborts the walk before any work.
    }
    // [FLUSH-CLASS: exec] the command echo precedes the spawn so the
    // transcript shows what owns the terminal next
    flush(tell(`         running: ${batchCmd}`));
    // restore COOKED mode explicitly (see deployScript.runInstall — the
    // same frozen-prompt class): sudo/apt read the tty directly
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        try { process.stdin.setRawMode(false); } catch { /* not in raw mode */ }
    }
    const run = Bun.spawn(["sh", "-c", batchCmd], {
        stdout: "inherit", stderr: "inherit", stdin: "inherit",
    });
    const exit = await run.exited;
    if (exit !== 0) {
        out = bind(out, (f) => pure(f, `         install command exited ${exit} — re-verifying what landed`));
    }

    // PHASE 3 — re-verify: EVERY planned binary must exist now (the
    // batch's hard-failure contract, per binary)
    // [FLUSH-CLASS: buffered] the verdict lines accumulate; the
    // handler's exit flush prints them (nothing runs after this).
    const verdicts: string[] = [];
    for (const p of plans) {
        if (installed(p.binary)) {
            verdicts.push(`         installed: ${p.binary} (via ${p.pkg})`);
        } else {
            verdicts.push(`         FAILED: ${p.binary} still absent (package: ${p.pkg})`);
            out = map(out, (f) => f + 1);
        }
    }
    return pure(out.value, ...verdicts);
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
            // [FLUSH-CLASS: exit] precondition failure — the problem
            // line is the whole transcript; exit code carries severity
            say(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const result = await walk(
            !!flags.yes, !!flags["dry-run"],
            flags.only?.split(/[,\s]+/).filter(Boolean),
        );
        // [FLUSH-CLASS: exit] the walk's buffered verdict flushes here —
        // after this point only the exit code speaks
        const failed = flush(result);
        if (failed > 0) {
            say(`install: ${failed} requirement(s) unresolved`);
            process.exit(1);
        }
        // [FLUSH-CLASS: exit] final line of the transcript
        console.log("install: all requirements satisfied");
        // EXPLICIT exit: the line-reader's stdin listener (lines.ts
        // attach) keeps the event loop alive on a TTY — stdin never
        // EOFs there, and a fall-off-the-end handler hung the walk
        // forever after its final line (the make-install hang)
        process.exit(0);
    },
});
