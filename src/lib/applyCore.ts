// src/lib/applyCore.ts — the apply engine, shared by the `apply` verb
// and the configure wizard: resolve the platform, run its GENERIC step
// list, report per step. Returns the failure count (caller exits).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DOTS_DIR, readRequires } from "./dots";
import { readProfile, type Profile } from "./profile";
import { platformSteps, resolvePlatform } from "./platforms";

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

export interface ApplyOpts {
    dryRun?: boolean;
    profile?: string;
}

/** returns the number of FAILED steps */
export async function runApply(opts: ApplyOpts = {}): Promise<number> {
    const file = opts.profile ?? "deploy.profile";
    await ensureProfile(file);

    let profile: Profile;
    try {
        profile = await readProfile(file);
    } catch (err) {
        console.error(`apply: ${(err as Error).message}`);
        return 1;
    }
    const { target } = await readRequires();

    let platform;
    try {
        platform = resolvePlatform(target, profile.session);
    } catch (err) {
        console.error(`apply: ${(err as Error).message}`);
        return 1;
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
    for (const step of platformSteps(platform, profile, !!opts.dryRun)) {
        const s = await step.run();
        const mark = s.ok ? "ok" : "FAILED";
        console.log(`  ${step.name.padEnd(12)} ${mark} — ${s.detail}${s.problem ? ` (${s.problem})` : ""}`);
        if (!s.ok) failed += 1;
    }
    if (profile.features.length > 0) {
        console.log("apply: feature groups are package Makefile rules");
        console.log("apply: run on-deploy packages <rule> to invoke them");
    }
    return failed;
}
