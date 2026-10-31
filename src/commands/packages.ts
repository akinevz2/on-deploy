// src/commands/packages.ts — GROUP OPERATIONS over the stow packages'
// dependency Makefiles (dots/<pkg>/.local/share/<pkg>/Makefile).
//
//   on-deploy packages <rule> [pkg...]     run a rule on some packages
//   on-deploy packages <rule>              run it on EVERY package
//                                          that has the Makefile
//   on-deploy packages list                which packages have one
//
// Rules are the standard set the package Makefiles implement:
//   install | start | stop | uninstall | status | disable | enable
// plus whatever extra rules a package defines (archive/unarchive
// helpers from on-deploy may be called by those rules — on-deploy
// itself carries NO per-package code, only per-platform code; the
// special steps live in the Makefiles' bash).

import { defineCommand } from "@bunli/core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkDotsEnv, DOTS_DIR } from "../lib/dots";


export const STANDARD_RULES = [
    "install", "start", "stop", "uninstall", "status", "disable", "enable",
] as const;

/** every package that ships a dependency Makefile */
export function packagesWithMakefiles(dots: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dots, { withFileTypes: true })) {
        if (!name.isDirectory() || name.name.startsWith(".") || name.name === "defaults") continue;
        if (existsSync(join(dots, name.name, ".local", "share", name.name, "Makefile"))) {
            out.push(name.name);
        }
    }
    return out.sort();
}


export default defineCommand({
    name: "packages",
    description:
        "Group operations on the stow packages' dependency Makefiles (install/start/stop/uninstall/status/disable/enable)",
    handler: async ({ positional }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const [rule, ...rest] = positional;
        const available = packagesWithMakefiles(DOTS_DIR);
        if (!rule || rule === "list") {
            console.log(`packages: dependency Makefiles in ${available.join(" ") || "(none)"}`);
            console.log(`packages: standard rules: ${STANDARD_RULES.join(" ")}`);
            return;
        }
        const wanted = rest.length ? rest : available;
        const unknown = wanted.filter((p) => !available.includes(p));
        for (const p of unknown) {
            console.log(`packages: ${p}: no Makefile`);
        }
        const targets = wanted.filter((p) => available.includes(p));
        let failed = 0;
        for (const pkg of targets) {
            const dir = join(DOTS_DIR, pkg, ".local", "share", pkg);
            console.log(`packages: ${pkg} — make ${rule}`);
            const p = Bun.spawn(["make", "-C", dir, rule], {
                stdout: "inherit", stderr: "inherit", stdin: "inherit", cwd: DOTS_DIR,
            });
            const code = await p.exited;
            if (code !== 0) {
                console.error(`packages: ${pkg} make ${rule} FAILED (exit ${code})`);
                failed += 1;
            }
        }
        if (failed > 0) {
            console.error(`packages: ${failed} package(s) failed '${rule}'`);
            process.exit(1);
        }
        console.log(`packages: ${rule} done on ${targets.length} package(s)`);
    },
});
