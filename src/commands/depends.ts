// src/commands/depends.ts — the SUBMODULE deploy step of the dots repo.
// "Bootstrapping dots" means deploying on-deploy to the system (the dots
// Makefile's bootstrap); deploying the submodules means THIS command.
//
//	on-deploy depends	sync the submodule checkouts
//	on-deploy depends --build	sync + build (no install)
//	on-deploy depends --install	sync + build + install
//
// Steps:
//   1. SYNC — `git submodule sync` + `git submodule update --init
//      --recursive` inside ~/dots (PINNED doctrine, 2026-11: the
//	nested asset submodules — bat themes/syntaxes and co. — are
//	updated by UPSTREAM, not chased per machine; the plain update
//	uses the RECORDED pins, so remotes never re-pull sub-submodule
//      churn; `git submodule update --remote` bumps a checkout BY
//	HAND when a pinned tree is to be advanced). --no-sync skips the
//	git phase (re-running builds without touching the checkouts).
//	2. DRIVE — every stow package that ships the per-package Makefile
//	dots/<pkg>/.local/state/depends/<pkg>.Makefile gets the rule the
//      depth asks for: `build` (--build) or `install` (--install). ALL
//	the build/install/link logic lives in those Makefiles —
//	on-deploy hardcodes nothing per package (--force passes FORCE=1;
//      the Makefiles' ensure/rebuild semantics are theirs to define).
//	3. bare (no depth) — the discovery report: which packages host which
//	submodules and have a Makefile ready.
//
// Exit codes: 2 env/precondition, 1 any package rule failed, 0 ok.

    // ── the per-package make run rides the SHARED pkgops spinner+async
import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { join } from "node:path";
import { checkDotsEnv, DOTS_DIR } from "../lib/dots";
import { runMakeSpun } from "../lib/pkgops";
import { say } from "../lib/lines";
import {
    depsMakefile, submodulesByPackage, type PkgResult,
} from "../lib/pkgops";

function shInherit(args: string[], cwd: string): number {
    const r = Bun.spawnSync(args, {
        cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit",
    });
    return r.exitCode ?? 1;
}
function runDepsRule(pkg: string, rule: string, makeVars: string[]): PkgResult {
    const file = depsMakefile(pkg)!;
    const dir = join(DOTS_DIR, pkg);
    const p = Bun.spawnSync(
        ["make", "-C", dir, "--no-print-directory", "-f", file, ...makeVars, rule],
        { cwd: DOTS_DIR, stdout: "pipe", stderr: "pipe" },
    );
    const lines = [
        ...`${p.stdout ?? ""}`.trim().split("\n").filter(Boolean),
        ...`${p.stderr ?? ""}`.trim().split("\n").filter(Boolean),
    ];
    return { pkg, ok: (p.exitCode ?? 1) === 0, lines };
}

// the per-package make run rides the SHARED pkgops spinner+async
// helper; the deps scheme only differs in the Makefile path + cwd.
async function runDepsRuleSpun(pkg: string, rule: string, makeVars: string[]): Promise<PkgResult> {
    const file = depsMakefile(pkg)!;
    const dir = join(DOTS_DIR, pkg);
    const r = await runMakeSpun(dir, file, makeVars, rule, `${pkg}:${rule}`);
    return { pkg, ok: r.ok, lines: r.lines };
}

export default defineCommand({
    name: "depends",
    description: "Drive package Makefiles",
    options: {
        build: option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "sync + run each package's Makefile `build` rule (toolchain + compile, no install)",
            short: "b",
        }),
        install: option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "sync + run each package's Makefile `install` rule (build + deploy)",
            short: "i",
        }),
        force: option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "pass FORCE=1 to the Makefiles (redeploy even when installed)",
            short: "f",
        }),
        only: option(z.string().optional(), {
            description: "comma/space-separated subset of packages to drive",
        }),
        "no-sync": option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "run only the Makefile rules — skip the git submodule phase",
        }),
        "dry-run": option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "report what would run, change nothing",
        }),
    },
    handler: async ({ flags, positional }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            say(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const raw = (positional ?? [])[0] ?? "";
        const mode = flags.install ? "install" : flags.build ? "build" : "";
        const dry = !!flags["dry-run"];
        const noSync = !!flags["no-sync"];

        // 1) SYNC — the submodule checkouts at their RECORDED pins
        // (pinned doctrine: nested asset submodules — e.g. bat's
        // themes/syntaxes — are updated by UPSTREAM, not chased per
        // machine; remotes never re-pull sub-submodule churn.
        // `git submodule update --remote` must be run BY HAND to bump)
        if (!noSync) {
            if (dry) {
                console.log("  [dry] submodule sync+pins");
            } else {
                console.log("depends: submodule sync");
                if (shInherit(["git", "submodule", "sync"], DOTS_DIR) !== 0) process.exit(1);
                console.log("depends: submodule pins");
                if (shInherit(["git", "submodule", "update", "--init", "--recursive"], DOTS_DIR) !== 0) {
                    say("depends: submodule update FAILED");
                    process.exit(1);
                }
            }
        }

        // 2) DRIVE — CONFIGURED SCOPE: the packages system.depends lists
        // (submodule manifest), intersected with .Makefile presence — a
        // package with submodules but no Makefile is a misconfiguration,
        // reported, not silently skipped
        const subs = submodulesByPackage();
        let targets = Object.keys(subs)
            .filter((p) => depsMakefile(p) !== null)
            .sort();
        for (const p of Object.keys(subs)) {
            if (!depsMakefile(p)) console.log(`depends: ${p}: no Makefile`);
        }
        if (flags.only) {
            const wanted = flags.only.split(/[,\s]+/).filter(Boolean);
            const unknown = wanted.filter((p) => !targets.includes(p));
            for (const p of unknown) console.log(`depends: ${p}: no depends Makefile`);
            targets = targets.filter((p) => wanted.includes(p));
        }
        if (!mode || targets.length === 0) {
            // 3) discovery report
            console.log(`depends: packages: ${targets.join(" ") || "(none)"}`);
            for (const pkg of targets) {
                console.log(`  ${pkg.padEnd(12)} <- ${(subs[pkg] ?? ["(no submodules)"]).join(" ")}`);
            }
            console.log(`depends: rerun --build|-b or --install|-i` +
                ` (the subwalk depth)`);
            return;
        }

        console.log(
            `depends: ${mode} ${targets.join(" ") || "(none)"}` +
            ` — per-pkg Makefile${noSync ? ", no sync" : ", synced"}` +
            `${dry ? ", dry" : ""}`,
        );
        if (dry) {
            for (const pkg of targets) console.log(`  [dry] make ${pkg} ${mode}`);
            return;
        }
        const makeVars = flags.force ? ["FORCE=1"] : [];
        const results: PkgResult[] = [];
        for (const pkg of targets) results.push(await runDepsRuleSpun(pkg, mode, makeVars));
        for (const r of results) {
            console.log(`==${r.pkg} ${r.ok ? "SUCCESS" : "FAILURE"}`);
            for (const l of r.lines) console.log(l);
        }
        if (results.some((r) => !r.ok)) {
            say("depends: FAILED packages above");
            process.exit(1);
        }
        console.log(`depends: ${mode} done on ${targets.length} package(s)`);
    },
});
