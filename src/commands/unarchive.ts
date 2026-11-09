// src/commands/unarchive.ts — restore the defaults/ backups of a stow
// package back into $HOME (the uninstall-time counterpart of archive).
// Never clobbers a dots-owned (deployed) file. The package Makefiles
// call this from their uninstall rules; on-deploy stays generic.

import { defineCommand, option } from "@bunli/core";
import { say } from "../lib/lines";
import { flush, tell } from "../lib/out";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkDotsEnv, DOTS_DIR } from "../lib/dots";
import { unarchivePackage } from "../lib/defaults";

export default defineCommand({
    name: "unarchive",
    description: "Restore archived files",
    options: {
        "dry-run": option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "list what would be restored, copy nothing",
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
        const pkg = positional[0] ?? "";
        if (!pkg || !existsSync(join(DOTS_DIR, pkg, ".local"))) {
            // [FLUSH-CLASS: exit] usage report — exit code carries severity
            say(`unarchive: not a stow package: ${pkg}`);
            say("unarchive: usage: on-deploy unarchive <pkg>");
            process.exit(2);
        }
        // [FLUSH-CLASS: buffered] the restored report is built as an
        // Out — unarchivePackage touches only the filesystem
        const rels = unarchivePackage(DOTS_DIR, pkg, !!flags["dry-run"]);
        const lines: string[] = [];
        if (rels.length === 0) {
            lines.push(`unarchive ${pkg}: nothing to restore (no backups)`);
        } else {
            lines.push(`unarchive ${pkg}: ${rels.length} item(s) ${flags["dry-run"] ? "would be restored" : "restored"}:`);
            for (const rel of rels) lines.push(`  ${rel}`);
        }
        // [FLUSH-CLASS: exit] the buffered report flushes here — after
        // this point only the exit code speaks
        flush(tell(...lines));
    },
});
