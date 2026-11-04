// src/commands/unstow.ts — the unstow TUI verb: pick packages (args, else a
// whiptail checklist), run unstow per package (output captured), print
// the blocks sequentially after the TUI closes. Makefile packages
// defer to their own unstow rule; others use their stowed user units.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { checkDotsEnv } from "../lib/dots";
import { pkgOpTui } from "./tuiRunner";

export default defineCommand({
    name: "unstow",
    description: "Unstow packages (TUI or explicit list) — unstow",
    options: {
        only: option(z.string().optional(), {
            description: "comma/space-separated packages (skips the TUI)",
        }),
    },
    handler: async ({ flags, prompt }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        await pkgOpTui("unstow", flags.only?.split(/[,\s]+/).filter(Boolean) ?? [], prompt);
    },
});
