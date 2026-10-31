// src/commands/pkg.ts — GENERIC package operations, keyed entirely by
// the names the CALLER passes. Zero hardcoded package names; the
// platform resolution (apt | pacman) is the only intelligence here.
//
//   on-deploy pkg installed <name>...   exit 0 when ALL are installed
//   on-deploy pkg search <name>...      resolve the providing package
//                                       (binary names go through the
//                                       <target>.deploy protocol)
//   on-deploy pkg install <name>...     platform package manager
//   on-deploy pkg remove <name>...      platform package manager
//
// The package Makefiles defer here for the platform work; on-deploy
// never associates behavior to a specific name.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { checkDotsEnv, readRequires } from "../lib/dots";
import { resolvePackage } from "../lib/deployScript";
import { platformPkg, platformPkgInstalled } from "../lib/provisioners";

type Op = "installed" | "search" | "install" | "remove";

export default defineCommand({
    name: "pkg",
    description:
        "Generic package operations on the given names (installed|search|install|remove) via the platform package manager",
    options: {
        yes: option(z.boolean().optional(), {
            description: "no confirmations (non-interactive)",
            short: "y",
        }),
        "dry-run": option(z.boolean().optional(), {
            description: "print what would run",
        }),
    },
    handler: async ({ flags, positional }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const [op, ...names] = positional;
        const OPS: Op[] = ["installed", "search", "install", "remove"];
        if (!op || !OPS.includes(op as Op) || names.length === 0) {
            console.error(`pkg: usage: on-deploy pkg <${OPS.join("|")}> <name>...`);
            process.exit(2);
        }
        const { target } = await readRequires();
        const pkgMgr = target === "arch" || target === "manjaro" ? "pacman" : "apt";
        const dry = !!flags["dry-run"];
        let failed = 0;

        for (const name of names) {
            if (op === "installed") {
                const on = platformPkgInstalled(pkgMgr, name);
                console.log(`  ${name.padEnd(20)} ${on ? "installed" : "MISSING"}`);
                if (!on) failed += 1;
                continue;
            }
            if (op === "search") {
                const res = await resolvePackage(target, name);
                if (res.ok) console.log(`  ${name.padEnd(20)} -> ${res.pkg}`);
                else {
                    console.log(`  ${name.padEnd(20)} UNRESOLVED`);
                    failed += 1;
                }
                continue;
            }
            // install | remove: skip already-satisfied state on install
            if (op === "install" && platformPkgInstalled(pkgMgr, name)) {
                console.log(`  ${name.padEnd(20)} already installed`);
                continue;
            }
            console.log(`  ${name.padEnd(20)} ${op}`);
            const code = await platformPkg(pkgMgr, op as "install" | "remove", [name], !!flags.yes, dry);
            if (code !== 0) {
                console.error(`  ${name.padEnd(20)} FAILED (exit ${code})`);
                failed += 1;
                continue;
            }
            if (op === "install" && !dry) {
                const on = platformPkgInstalled(pkgMgr, name);
                console.log(`  ${name.padEnd(20)} ${on ? "installed" : "STILL MISSING"}`);
                if (!on) failed += 1;
            }
        }
        if (failed > 0) {
            console.error(`pkg: ${failed} name(s) failed '${op}'`);
            process.exit(1);
        }
    },
});
