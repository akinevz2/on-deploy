// src/commands/pkg.ts — GENERIC package operations, keyed entirely by
// the names the CALLER passes. Zero hardcoded package names; the
// deploy target resolution (apt | pacman) is the only intelligence here.
//
//	on-deploy pkg installed <name>...	exit 0 when ALL are installed
//	on-deploy pkg search <name>...	resolve the providing package
//	(binary names go through the
//	<target>.deploy protocol)
//	on-deploy pkg install <name>...	deploy target package manager
//	on-deploy pkg remove <name>...	deploy target package manager
//
// The package Makefiles defer here for the deploy target work; on-deploy
// never associates behavior to a specific name.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { checkDotsEnv, readRequires } from "../lib/dots";
import { say } from "../lib/lines";
import { bind, flush, pure, type Out } from "../lib/out";
import { resolvePackage } from "../lib/deployScript";
import {
    familyPkgManager, PKG_MANAGER_ID, PKG_OP,
    sudoPreauth, targetPkg, targetPkgInstalled,
    type PkgOpKind, type TargetFamily,
} from "../lib/provisioners";

type Op = "installed" | "search" | "install" | "remove";

export default defineCommand({
    name: "pkg",
    description: "Distro package ops",
    options: {
        yes: option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "no confirmations (non-interactive)",
            short: "y",
        }),
        "dry-run": option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "print what would run",
        }),
    },
    handler: async ({ flags, positional }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            // [FLUSH-CLASS: exit] precondition failure — the problem
            // line is the whole transcript; exit code carries severity
            say(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const [op, ...names] = positional;
        const OPS: Op[] = ["installed", "search", "install", "remove"];
        if (!op || !OPS.includes(op as Op) || names.length === 0) {
            // [FLUSH-CLASS: exit] usage report — exit code carries severity
            say(`pkg: ${op || "(no op)"} is not a pkg op`);
            say("pkg:\tusage\ton-deploy pkg <op> <name>...");
            say("pkg:\thelp\ton-deploy pkg help");
            process.exit(2);
        }
        const { target } = await readRequires();
        const family = target as TargetFamily | null;
        const pkgMgr = familyPkgManager(family) ?? PKG_MANAGER_ID.apt;
        const dry = !!flags["dry-run"];
        // CONSENT DOCTRINE (2026-11): the sudo grant is demanded ONLY
        // when there is real root work (a named package not already
        // installed). Demanding it unconditionally made `pkg install`
        // fail headless on fully-installed packages (compton/dunst:
        // nothing to do, yet "credentials not granted") and made the
        // grant the first interaction even for no-op runs. The verdict
        // lines for satisfied names stay buffered until the grant —
        // the password prompt must still be the first INTERACTION.
        const needsRoot =
            (op === "install" || op === "remove") &&
            names.some((n) =>
                op === "remove" || !targetPkgInstalled({ pkgMgr, name: n }));
        if (needsRoot && !dry && !(await sudoPreauth(
            `${op}ing ${names.length} package(s) (${names.join(", ")}) needs root — ${pkgMgr} ${op}`,
            dry,
        ))) {
            // [FLUSH-CLASS: exit] refusal report — exit code carries severity
            say("sudo: credentials not granted (refused, or no tty to prompt on) — run `sudo -v` first, or --dry-run");
            process.exit(1);
        }
        // [FLUSH-CLASS: buffered] the per-name verdicts ride an Out whose
        // value is the failure count; exec boundaries below flush it so
        // the transcript keeps its order around the inherited-stdio
        // package-manager children
        let out: Out<number> = pure(0);

        for (const name of names) {
            if (op === "installed") {
                const on = targetPkgInstalled({ pkgMgr, name });
                out = bind(out, (f) => pure(f + (on ? 0 : 1),
                    `  ${name.padEnd(20)} ${on ? "installed" : "MISSING"}`,
                ));
                continue;
            }
            if (op === "search") {
                const res = await resolvePackage(target, name);
                out = res.ok
                    ? bind(out, (f) => pure(f, `  ${name.padEnd(20)} -> ${res.pkg}`))
                    : bind(out, (f) => pure(f + 1, `  ${name.padEnd(20)} UNRESOLVED`));
                continue;
            }
            // install | remove: skip already-satisfied state on install
            if (PKG_OP.install === op && targetPkgInstalled({ pkgMgr, name })) {
                out = bind(out, (f) => pure(f, `  ${name.padEnd(20)} already installed`));
                continue;
            }
            out = bind(out, (f) => pure(f, `  ${name.padEnd(20)} ${op}`));
            // [FLUSH-CLASS: exec] the echo lands NOW — targetPkg spawns
            // sudo/the package manager with inherited stdio; queued
            // lines would interleave out of order
            const failedSoFar = flush(out);
            out = pure(failedSoFar);
            const code = await targetPkg({
                pkgMgr, op: op as PkgOpKind, names: [name], dry,
            });
            if (code !== 0) {
                out = bind(out, (f) => pure(f + 1, `  ${name.padEnd(20)} FAILED (exit ${code})`));
                continue;
            }
            if (op === "install" && !dry) {
                const on = targetPkgInstalled({ pkgMgr, name });
                out = bind(out, (f) => pure(f + (on ? 0 : 1),
                    `  ${name.padEnd(20)} ${on ? "installed" : "STILL MISSING"}`,
                ));
            }
        }
        // [FLUSH-CLASS: exit] the buffered verdicts flush here — after
        // this point only the exit code speaks
        const failed = flush(out);
        if (failed > 0) {
            say(`pkg: ${failed} name(s) failed '${op}'`);
            process.exit(1);
        }
    },
});
