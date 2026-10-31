// src/commands/apply.ts — apply the configured deployment: resolve the
// deploy target (debian-wsl | debian | archlinux) from the
// wm.requires manifest and run its GENERIC step list. Package-group
// setup (xserver, nested, xrdp, greeter, xinitrc) is NOT here — those
// are special steps in the package Makefiles, driven by
// `on-deploy packages <rule>` or the dots `make install` flow.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { runApply } from "../lib/applyCore";

export default defineCommand({
    name: "apply",
    description:
        "Apply the configured deployment: resolve the deploy target (debian-wsl | debian | archlinux), run its generic step list",
    options: {
        "dry-run": option(z.boolean().optional(), {
            description: "print what would run",
        }),
    },
    handler: async ({ flags }) => {
        const failed = await runApply({ dryRun: !!flags["dry-run"] });
        if (failed > 0) {
            console.error(`apply: ${failed} step(s) failed`);
            process.exit(1);
        }
        console.log("apply: complete");
    },
});
