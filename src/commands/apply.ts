// src/commands/apply.ts — apply the configured deployment to the
// platform: resolve the platform (debian-wsl | debian | archlinux) and
// run its GENERIC step list (env, wsl verify, units). Package-group
// setup (xserver, nested, xrdp, greeter, xinitrc) is NOT here — those
// are special steps in the package Makefiles
// (dots/<pkg>/.local/share/<pkg>/Makefile), driven by
// `on-deploy packages <rule>` or the dots `make install` flow.
//
// First call: when deploy.profile does not exist, the profile TUI
// (scripts/deploy-menu.sh --profile) runs first — persistent
// configuration written to ~/dots/deploy.profile — and apply
// continues with the freshly written profile. Non-interactive first
// calls fall back to the defaults (wsl-systemd, no features) with a
// note.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkDotsEnv, DOTS_DIR, readRequires } from "../lib/dots";
import { readProfile, type Profile } from "../lib/profile";
import { platformSteps, resolvePlatform } from "../lib/platforms";

const TUI_SCRIPT = join(DOTS_DIR, "scripts", "deploy-menu.sh");

/** First-call TUI: no profile yet -> the deploy-menu profile editor
 *  runs (interactive only), writing the persistent deploy.profile. */
async function ensureProfile(file: string): Promise<void> {
    if (existsSync(join(DOTS_DIR, file))) return;
    if (process.stdin.isTTY && existsSync(TUI_SCRIPT)) {
        console.log("apply: no deploy.profile — opening the profile TUI");
        const p = Bun.spawn(["bash", TUI_SCRIPT, "--profile"], {
            stdout: "inherit", stderr: "inherit", stdin: "inherit", cwd: DOTS_DIR,
        });
        await p.exited;
    } else {
        console.log("apply: no deploy.profile, non-interactive — defaults");
    }
}

export default defineCommand({
    name: "apply",
    description:
        "Apply the configured deployment: resolve the platform (debian-wsl | debian | archlinux), run its generic step list",
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
        const file = flags.profile ?? "deploy.profile";
        await ensureProfile(file);

        let profile: Profile;
        try {
            profile = await readProfile(file);
        } catch (err) {
            console.error(`apply: ${(err as Error).message}`);
            process.exit(2);
        }
        const { target } = await readRequires();

        let platform;
        try {
            platform = resolvePlatform(target, profile.session);
        } catch (err) {
            console.error(`apply: ${(err as Error).message}`);
            process.exit(2);
        }
        console.log(
            `apply: platform=${platform.key} pkg=${platform.pkgMgr}` +
            ` xserver=${platform.externalXServer ? "external" : "managed"}`,
        );
        console.log(
            `apply: session=${profile.session}` +
            ` features=${profile.features.join(",") || "none"}` +
            ` units=${profile.units.join(",") || "none"}`,
        );

        let failed = 0;
        for (const step of platformSteps(platform, profile, !!flags["dry-run"])) {
            const s = await step.run();
            const mark = s.ok ? "ok" : "FAILED";
            console.log(`  ${step.name.padEnd(12)} ${mark} — ${s.detail}${s.problem ? ` (${s.problem})` : ""}`);
            if (!s.ok) failed += 1;
        }
        if (profile.features.length > 0) {
            console.log("apply: feature package groups are package Makefile rules");
            console.log("apply: run e.g. on-deploy packages <rule> (or the dots make install)");
        }
        if (failed > 0) {
            console.error(`apply: ${failed} step(s) failed`);
            process.exit(1);
        }
        console.log("apply: complete");
    },
});
