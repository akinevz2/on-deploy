// src/commands/apply.ts — apply the configured deployment to the
// platform: resolve the deploy target (debian-wsl | debian | archlinux) and
// run its GENERIC step list (env, wsl verify, units). Package-group
// setup (xserver, nested, xrdp, greeter, xinitrc) is NOT here — those
// are special steps in the package Makefiles, driven by
// `on-deploy packages <rule>` or the dots `make install` flow.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { checkDotsEnv } from "../lib/dots";
import { runApply } from "../lib/applyCore";

export default defineCommand({
    name: "apply",
    description:
        "Apply the configured deployment: resolve the deploy target (debian-wsl | debian | archlinux), run its generic step list",
    options: {
        "dry-run": option(z.boolean().optional(), {
            description: "print what would run",
        }),
        profile: option(z.string().optional(), {
            description: "profile file name inside ~/dots (default deploy.profile)",
        }),
    },
    handler: async ({ flags }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const failed = await runApply({
            dryRun: !!flags["dry-run"], profile: flags.profile,
        });
        if (failed > 0) {
            console.error(`apply: ${failed} step(s) failed`);
            process.exit(1);
        }
        console.log("apply: complete");
    },
});
