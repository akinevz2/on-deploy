// src/commands/disable.ts — the disable TUI verb: pick packages (args, else a
// whiptail checklist), run disable per package (output captured), print
// the blocks sequentially after the TUI closes. Makefile packages
// defer to their own disable rule; others use their stowed user units.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { checkDotsEnv } from "../lib/dots";
import { pkgOpTui } from "./tuiRunner";

export default defineCommand({
    name: "disable",
    description: "Disable packages (TUI or explicit list) — disable",
    options: {
        only: option(z.string().optional(), {
            description: "comma/space-separated packages (skips the TUI)",
        }),
    },
    handler: async ({ flags }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        await pkgOpTui("disable", flags.only?.split(/[,\s]+/).filter(Boolean) ?? []);
    },
});
