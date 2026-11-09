// src/commands/stow.ts — the stow TUI verb: pick packages (args, else a
// whiptail checklist), run stow per package (output captured), print
// the blocks sequentially after the TUI closes. Makefile packages
// defer to their own stow rule; others use their stowed user units.

import { defineCommand, option } from "@bunli/core";
import { say } from "../lib/lines";
import { z } from "zod";
import { checkDotsEnv } from "../lib/dots";
import { pkgOpTui } from "./tuiRunner";

export default defineCommand({
    name: "stow",
    description: "Stow packages",
    options: {
        only: option(z.string().optional(), {
            description: "comma/space-separated packages (skips the TUI)",
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
        await pkgOpTui("stow", flags.only?.split(/[,\s]+/).filter(Boolean) ?? []);
    },
});
