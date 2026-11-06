// src/commands/unarchive.ts — restore the defaults/ backups of a stow
// package back into $HOME (the uninstall-time counterpart of archive).
// Never clobbers a dots-owned (deployed) file. The package Makefiles
// call this from their uninstall rules; on-deploy stays generic.

import { defineCommand, option } from "@bunli/core";
import { say } from "../lib/lines";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkDotsEnv, DOTS_DIR } from "../lib/dots";
import { unarchivePackage } from "../lib/defaults";

export default defineCommand({
    name: "unarchive",
    description:
        "Restore a stow package's defaults/ backups into $HOME (skips dots-owned paths)",
    options: {
        "dry-run": option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "list what would be restored, copy nothing",
        }),
    },
    handler: async ({ flags, positional }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            say(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const pkg = positional[0] ?? "";
        if (!pkg || !existsSync(join(DOTS_DIR, pkg, ".local"))) {
            say(`unarchive: not a stow package: ${pkg}`);
            say("unarchive: usage: on-deploy unarchive <pkg>");
            process.exit(2);
        }
        const rels = unarchivePackage(DOTS_DIR, pkg, !!flags["dry-run"]);
        if (rels.length === 0) {
            console.log(`unarchive ${pkg}: nothing to restore (no backups)`);
            return;
        }
        console.log(`unarchive ${pkg}: ${rels.length} item(s) ${flags["dry-run"] ? "would be restored" : "restored"}:`);
        for (const rel of rels) console.log(`  ${rel}`);
    },
});
