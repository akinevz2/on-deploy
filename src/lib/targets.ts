// src/lib/targets.ts — deploy target resolution + step composition.
//
// apply resolves a DEPLOY TARGET from the wm.required manifest (the
// single deployment manifest: binaries line, optional
// `session = <model>` line, target line) and runs that target's
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
// (the depends Makefile, bash), which defer to
// `on-deploy pkg ...` for the package-manager operations.

import { ensureVcxsrv, verifyWslSession, type Step } from "./provisioners";

export type TargetKey = "debian-wsl" | "debian" | "archlinux";

export interface DeployTarget {
    key: TargetKey;
    /** true: the X server lives OUTSIDE this machine (WSL/VcXsrv) */
    externalXServer: boolean;
    pkgMgr: "apt" | "pacman";
}

const ARCH_FAMILY = new Set(["arch", "manjaro"]);
const APT_FAMILY = new Set(["ubuntu", "debian"]);

const SESSIONS = new Set(["greetd", "wsl-systemd", "xinit", "nested"]);

export function resolveTarget(target: string, session: string): DeployTarget {
    if (!SESSIONS.has(session)) {
        throw new Error(
            `unknown session model '${session}' ` +
            `(supported: ${[...SESSIONS].join(", ")})`,
        );
    }
    const arch = ARCH_FAMILY.has(target);
    if (session === "wsl-systemd") {
        // WSL: the X server is the Windows app — never installed here.
        return { key: arch ? "archlinux" : "debian-wsl", externalXServer: true, pkgMgr: arch ? "pacman" : "apt" };
    }
    if (arch) return { key: "archlinux", externalXServer: false, pkgMgr: "pacman" };
    if (!APT_FAMILY.has(target)) {
        throw new Error(
            `no deploy target implementation for '${target}' ` +
            `(supported: ubuntu, debian, arch, manjaro)`,
        );
    }
    return { key: "debian", externalXServer: false, pkgMgr: "apt" };
}

export interface TargetStep {
    name: string;
    run: () => Promise<Step>;
}

/** The ordered GENERIC step list for the deploy target: (wsl:
 *  vcxsrv + session verify). Package-group setup is NOT here — it
 *  lives in the package Makefiles; unit enabling belongs to the dots
 *  services flow (services.required / package Makefiles). */
export function targetSteps(p: DeployTarget, dry: boolean): TargetStep[] {
    const steps: TargetStep[] = [];
    if (p.externalXServer) {
        steps.push({ name: "vcxsrv", run: () => ensureVcxsrv(true, dry) });
        steps.push({ name: "wsl-session", run: async () => verifyWslSession() });
    }
    return steps;
}
