// src/commands/enable.ts — the enable TUI verb: pick packages (args, else a
// whiptail checklist), run enable per package (output captured), print
// the blocks sequentially after the TUI closes. Makefile packages
// defer to their own enable rule; others use their stowed user units.

import { defineCommand, option } from "@bunli/core";
import { say } from "../lib/lines";
import { z } from "zod";
import { checkDotsEnv } from "../lib/dots";
import { pkgOpTui } from "./tuiRunner";

export default defineCommand({
    name: "enable",
    description: "Enable packages",
    options: {
        only: option(z.string().optional(), {
            description: "comma/space-separated packages (skips the TUI)",
        }),
    },
    handler: async ({ flags }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            say(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        await pkgOpTui("enable", flags.only?.split(/[,\s]+/).filter(Boolean) ?? []);
    },
});
