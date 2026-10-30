// src/commands/provision.ts — platform provisioning from deploy.profile:
// xserver packages, the ~/.xinitrc session line, a lightdm greeter.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { checkDotsEnv, readRequires } from "../lib/dots";
import { readProfile, type Profile } from "../lib/profile";
import { ensureXServer, ensureXinitrc, ensureGreeter, verifyWslSession, writeProfileEnv, enableUnits } from "../lib/provisioners";

export default defineCommand({
    name: "provision",
    description:
        "Platform provisioning per deploy.profile: xserver packages, ~/.xinitrc session, greeter",
    options: {
        yes: option(z.boolean().optional(), {
            description: "assume yes for every step (non-interactive)",
            short: "y",
        }),
        "dry-run": option(z.boolean().optional(), {
            description: "print what would be done, change nothing",
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
        const { target } = await readRequires();
        let profile: Profile;
        try {
            profile = await readProfile(flags.profile ?? "deploy.profile");
        } catch (err) {
            console.error(`on-deploy: ${(err as Error).message}`);
            process.exit(2);
        }
        console.log(
            `provision: target=${target} session=${profile.session}` +
            ` features=${profile.features.join(",") || "none"}` +
            ` units=${profile.units.join(",") || "none"}`,
        );

        let failed = 0;
        const runStep = async (
            f: string,
            run: () => Promise<{ ok: boolean; detail: string; problem?: string }>,
        ) => {
            const step = await run();
            const mark = step.ok ? "ok" : "FAILED";
            console.log(`  ${f.padEnd(10)} ${mark} — ${step.detail}${step.problem ? ` (${step.problem})` : ""}`);
            if (!step.ok) failed += 1;
        };

        // the profile env file: units read DISPLAY etc. via
        // EnvironmentFile (absent file = the units' hardcoded WSL
        // defaults stand)
        if (profile.env.length > 0 || profile.units.length > 0) {
            await runStep("env", () => writeProfileEnv(profile, !!flags.yes, !!flags["dry-run"]));
        }
        if (profile.session === "wsl-systemd") {
            await runStep("wsl-session", () => verifyWslSession(target, !!flags.yes, !!flags["dry-run"]));
        }
        for (const f of profile.features) {
            const step =
                f === "xserver"
                    ? await ensureXServer(target, !!flags.yes, !!flags["dry-run"])
                    : f === "xinitrc"
                        ? await ensureXinitrc(target, !!flags.yes, !!flags["dry-run"])
                        : await ensureGreeter(target, !!flags.yes, !!flags["dry-run"]);
            const mark = step.ok ? "ok" : "FAILED";
            console.log(`  ${f.padEnd(10)} ${mark} — ${step.detail}${step.problem ? ` (${step.problem})` : ""}`);
            if (!step.ok) failed += 1;
        }
        if (profile.units.length > 0) {
            await runStep("units", () => enableUnits(profile, !!flags.yes, !!flags["dry-run"]));
        }
        if (failed > 0) {
            console.error(`provision: ${failed} step(s) failed`);
            process.exit(1);
        }
        console.log("provision: complete");
    },
});
