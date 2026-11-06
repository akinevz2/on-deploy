// src/commands/archive.ts — back up the $HOME versions of a package's
// files into ~/dots/defaults/ BEFORE the package's install would
// overwrite them. The package Makefiles (bash) decide WHEN to call
// this (their install rule) and on-deploy stays generic: one argument,
// the package name — no per-package code.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkDotsEnv, DOTS_DIR } from "../lib/dots";
import { archivePackage } from "../lib/defaults";

export default defineCommand({
    name: "archive",
    description:
        "Back up the your current config files\nto stow package ~/dots/defaults/",
    options: {
        "dry-run": option(z.boolean().optional(), {
            argumentKind: "flag" as const,
            description: "display collection targets, perform no-op",
        }),
    },
    handler: async ({ flags, positional }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const pkg = positional[0] ?? "";
        if (!pkg || !existsSync(join(DOTS_DIR, pkg, ".local"))) {
            console.error(`archive: not a stow package: ${pkg}`);
            console.error("archive: usage: on-deploy archive <pkg>");
            process.exit(2);
        }
        const rows = archivePackage(DOTS_DIR, pkg, !!flags["dry-run"]);
        if (rows.length === 0) {
            console.log(`archive ${pkg}: nothing to back up (dots-owned or absent)`);
            return;
        }
        console.log(`archive ${pkg}: ${rows.length} item(s) ${flags["dry-run"] ? "would be collected" : "collected"}:`);
        for (const r of rows) console.log(`  ${r.rel} (${r.kind})`);
        if (!flags["dry-run"]) {
            console.log(`archive ${pkg}: restore: on-deploy unarchive ${pkg}`);
        }
    },
});
