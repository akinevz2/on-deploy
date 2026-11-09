// src/commands/archive.ts — back up the $HOME versions of a package's
// files into ~/dots/defaults/ BEFORE the package's install would
// overwrite them. The package Makefiles (bash) decide WHEN to call
// this (their install rule) and on-deploy stays generic: one argument,
// the package name — no per-package code.

import { defineCommand, option } from "@bunli/core";
import { say } from "../lib/lines";
import { flush, tell } from "../lib/out";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkDotsEnv, DOTS_DIR } from "../lib/dots";
import { archivePackage } from "../lib/defaults";

export default defineCommand({
    name: "archive",
    description: "Back up non-dots files",
    options: {
        "dry-run": option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "list what would be collected, copy nothing",
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
            say(`archive: not a stow package: ${pkg}`);
            say("archive: usage: on-deploy archive <pkg>");
            process.exit(2);
        }
        // [FLUSH-CLASS: buffered] the collected report is built as an
        // Out — archivePackage touches only the filesystem
        const rows = archivePackage(DOTS_DIR, pkg, !!flags["dry-run"]);
        const lines: string[] = [];
        if (rows.length === 0) {
            lines.push(`archive ${pkg}: nothing to back up (dots-owned or absent)`);
        } else {
            lines.push(`archive ${pkg}: ${rows.length} item(s) ${flags["dry-run"] ? "would be collected" : "collected"}:`);
            for (const r of rows) lines.push(`  ${r.rel} (${r.kind})`);
            if (!flags["dry-run"]) {
                lines.push(`archive ${pkg}: restore: on-deploy unarchive ${pkg}`);
            }
        }
        // [FLUSH-CLASS: exit] the buffered report flushes here — after
        // this point only the exit code speaks
        flush(tell(...lines));
    },
});
