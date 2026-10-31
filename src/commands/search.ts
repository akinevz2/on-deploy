// src/commands/search.ts — verb (b): resolve the PROVIDING PACKAGE of
// each required binary in the target's repositories. Read-only: no
// installs, no state changes. Resolution goes through the platform
// deploy script contract:
//
//   <target>.deploy <binary>  ->  the package name (stdout, line 1)
//
// (ubuntu.deploy resolves via the apt file lists, arch/manjaro via
// pacman -Fs — the repo search itself is platform-specific and lives
// in those scripts; see depends/.local/bin/install/.)

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { checkDotsEnv, readRequires, missing } from "../lib/dots";
import { resolvePackage } from "../lib/deployScript";

export default defineCommand({
    name: "search",
    description:
        "Resolve the providing package of required binaries in the target repositories (read-only)",
    options: {
        only: option(z.string().optional(), {
            description: "comma/space-separated subset of binaries to search",
        }),
        all: option(z.boolean().optional(), {
            description: "search EVERY binary, including installed ones",
            short: "a",
        }),
    },
    handler: async ({ flags }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const requires = await readRequires();
        const wanted = flags.only?.length
            ? requires.binaries.filter((b) => flags.only!.split(/[,\s]+/).filter(Boolean).includes(b))
            : requires.binaries;
        console.log(`search: target=${requires.target} binaries=${wanted.length}`);
        let failed = 0;
        for (const binary of wanted) {
            const installedNow = !missing([binary]).length;
            if (installedNow && !flags.all) {
                console.log(`  ${binary.padEnd(20)} installed (--all to resolve anyway)`);
                continue;
            }
            const res = await resolvePackage(requires.target, binary);
            if (res.ok) {
                console.log(`  ${binary.padEnd(20)} -> ${res.pkg}`);
            } else {
                console.log(`  ${binary.padEnd(20)} UNRESOLVED`);
                console.log(`  ${" ".repeat(20)} ${res.problem ?? ""}`);
                failed += 1;
            }
        }
        if (failed > 0) {
            console.error(`search: ${failed} binary/b unresolved`);
            process.exit(1);
        }
    },
});
