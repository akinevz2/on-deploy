// src/lib/platforms.ts — platform resolution + step composition.
//
// provision resolves a PLATFORM from the deploy target (wm.requires
// last line) and the profile session model, then runs that platform's
// GENERIC step list. The three stabilized implementations:
//
//   debian-wsl   x server EXTERNAL (the Windows-side VcXsrv app);
//                hlwm runs as the systemd user unit herbst.service —
//                provision verifies, never installs an X server
//   debian       x server MANAGED (apt)
//   archlinux    x server MANAGED (pacman)
//
// NO package names and NO per-package behavior live here (or anywhere
// in on-deploy): the package GROUPS (X server stack, nested stack,
// xrdp, greeter) are implemented in the package Makefiles
// (dots/<pkg>/.local/share/<pkg>/Makefile, bash), which defer to
// `on-deploy pkg ...` for the platform package-manager operations.
// The profile's `features =` line stays DECLARATIVE metadata the
// Makefiles read for their guards.

import type { Profile, SessionModel } from "./profile";
import { enableUnits, ensureVcxsrv, verifyWslSession, writeProfileEnv, type Step } from "./provisioners";

export type PlatformKey = "debian-wsl" | "debian" | "archlinux";

export interface Platform {
    key: PlatformKey;
    /** true: the X server lives OUTSIDE this machine (WSL/VcXsrv) */
    externalXServer: boolean;
    pkgMgr: "apt" | "pacman";
}

const ARCH_FAMILY = new Set(["arch", "manjaro"]);
const APT_FAMILY = new Set(["ubuntu", "debian"]);

export function resolvePlatform(target: string, session: SessionModel): Platform {
    const arch = ARCH_FAMILY.has(target);
    if (session === "wsl-systemd") {
        // WSL: the X server is the Windows app — never installed here.
        return { key: arch ? "archlinux" : "debian-wsl", externalXServer: true, pkgMgr: arch ? "pacman" : "apt" };
    }
    if (arch) return { key: "archlinux", externalXServer: false, pkgMgr: "pacman" };
    if (!APT_FAMILY.has(target)) {
        throw new Error(
            `no platform implementation for target '${target}' ` +
            `(supported: ubuntu, debian, arch, manjaro)`,
        );
    }
    return { key: "debian", externalXServer: false, pkgMgr: "apt" };
}

export interface PlatformStep {
    name: string;
    run: () => Promise<Step>;
}

/** The ordered GENERIC step list for the platform:
 *  env -> (wsl: vcxsrv + session verify) -> units. Package-group
 *  setup is NOT here — it lives in the package Makefiles. */
export function platformSteps(
    p: Platform, profile: Profile, dry: boolean,
): PlatformStep[] {
    const steps: PlatformStep[] = [];

    // profile env file first: the units read DISPLAY etc. via
    // EnvironmentFile (absent file = the units' hardcoded WSL defaults)
    if (profile.env.length > 0 || profile.units.length > 0) {
        steps.push({ name: "env", run: async () => writeProfileEnv(profile.env, dry) });
    }

    if (p.externalXServer) {
        steps.push({ name: "vcxsrv", run: () => ensureVcxsrv(true, dry) });
        // verify the WM unit — only when the profile actually names one
        const wmUnit = profile.units.find((u) => /herbst|wm/i.test(u));
        if (wmUnit) {
            steps.push({ name: "wsl-session", run: async () => verifyWslSession(wmUnit) });
        }
    }

    // units last: enable the profile's systemd user units
    if (profile.units.length > 0) {
        steps.push({ name: "units", run: async () => enableUnits(profile.units, dry) });
    }

    return steps;
}
