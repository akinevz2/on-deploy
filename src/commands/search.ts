// src/commands/search.ts — verb (b): resolve the PROVIDING PACKAGE of
// each required binary in the target's repositories. Read-only: no
// installs, no state changes. Resolution goes through the platform
// deploy script contract:
//
//	<target>.deploy <binary>	->	the package name (stdout, line 1)
//
// (ubuntu.deploy resolves via the apt file lists, arch/manjaro via
// pacman -Fs — the repo search itself is platform-specific and lives
// in those scripts; see depends/.local/bin/install/.)

import { defineCommand, option } from "@bunli/core";
import { say } from "../lib/lines";
import { bind, flush, pure, type Out } from "../lib/out";
import { z } from "zod";
import { checkDotsEnv, readRequires, missing } from "../lib/dots";
import { resolvePackage } from "../lib/deployScript";

export default defineCommand({
    name: "search",
    description: "Find a binary's package",
    options: {
        only: option(z.string().optional(), {
            description: "comma/space-separated subset of binaries to search",
        }),
        all: option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "search EVERY binary, including installed ones",
            short: "a",
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
        const requires = await readRequires();
        const wanted = flags.only?.length
            ? requires.binaries.filter((b) => flags.only!.split(/[,\s]+/).filter(Boolean).includes(b))
            : requires.binaries;
        // [FLUSH-CLASS: buffered] the header + per-binary verdicts ride
        // an Out (resolvePackage spawns are piped — nothing interleaves);
        // the handler's exit flush prints them in order
        let out: Out<number> = pure(0, `search: target=${requires.target} binaries=${wanted.length}`);
        for (const binary of wanted) {
            const installedNow = !missing([binary]).length;
            if (installedNow && !flags.all) {
                out = bind(out, (f) => pure(f, `  ${binary.padEnd(20)} installed (--all to resolve anyway)`));
                continue;
            }
            const res = await resolvePackage(requires.target, binary);
            if (res.ok) {
                out = bind(out, (f) => pure(f, `  ${binary.padEnd(20)} -> ${res.pkg}`));
            } else {
                out = bind(out, (f) => pure(f + 1,
                    `  ${binary.padEnd(20)} UNRESOLVED`,
                    `  ${" ".repeat(20)} ${res.problem ?? ""}`,
                ));
            }
        }
        // [FLUSH-CLASS: exit] the buffered verdicts flush here — after
        // this point only the exit code speaks
        const failed = flush(out);
        if (failed > 0) {
            say(`search: ${failed} binary/b unresolved`);
            process.exit(1);
        }
    },
});
