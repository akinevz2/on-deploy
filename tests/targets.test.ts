// tests/targets.test.ts — the deploy target resolution + generic step
// composition (pure functions; no WM, no package manager, no fs).

import { describe, expect, test } from "bun:test";
import { targetSteps, resolveTarget } from "../src/lib/targets";
import type { Profile } from "../src/lib/profile";

const p = (over: Partial<Profile> = {}): Profile => ({
    features: [], session: "wsl-systemd", units: [], env: [], ...over,
});

describe("resolveTarget", () => {
    test("wsl-systemd session -> debian-wsl, x server EXTERNAL (apt family)", () => {
        expect(resolveTarget("ubuntu", "wsl-systemd")).toEqual({
            key: "debian-wsl", externalXServer: true, pkgMgr: "apt",
        });
        expect(resolveTarget("debian", "wsl-systemd").key).toBe("debian-wsl");
    });

    test("managed session + apt family -> debian", () => {
        for (const session of ["greetd", "xinit", "nested"] as const) {
            const pl = resolveTarget("ubuntu", session);
            expect(pl).toEqual({ key: "debian", externalXServer: false, pkgMgr: "apt" });
        }
    });

    test("managed session + arch family -> archlinux (pacman)", () => {
        for (const t of ["arch", "manjaro"]) {
            expect(resolveTarget(t, "greetd")).toEqual({
                key: "archlinux", externalXServer: false, pkgMgr: "pacman",
            });
        }
    });

    test("arch + wsl -> archlinux with the external-X flag (edge)", () => {
        const pl = resolveTarget("arch", "wsl-systemd");
        expect(pl.key).toBe("archlinux");
        expect(pl.externalXServer).toBe(true);
    });

    test("unsupported target -> throws", () => {
        expect(() => resolveTarget("fedora", "greetd")).toThrow(/no deploy target implementation/);
    });
});

describe("targetSteps (generic only — no package groups)", () => {
    test("wsl deploy target: env + vcxsrv + wsl-session + units", () => {
        const prof = p({ units: ["herbst"], env: ["DISPLAY=:0"] });
        const steps = targetSteps(resolveTarget("ubuntu", "wsl-systemd"), prof, false);
        expect(steps.map((s) => s.name)).toEqual(["env", "vcxsrv", "wsl-session", "units"]);
    });

    test("managed deploy target: env + units — NO xserver/greeter/nested/xrdp steps", () => {
        const prof = p({
            session: "greetd",
            features: ["greeter", "nested", "xrdp"],
            units: ["dunst"],
        });
        const steps = targetSteps(resolveTarget("arch", "greetd"), prof, false);
        expect(steps.map((s) => s.name)).toEqual(["env", "units"]);
    });

    test("no units/env -> no steps on a managed deploy target", () => {
        const steps = targetSteps(resolveTarget("debian", "greetd"), p({ session: "greetd" }), false);
        expect(steps).toEqual([]);
    });

    test("empty profile units on wsl -> vcxsrv only (no unit to verify)", () => {
        const steps = targetSteps(resolveTarget("ubuntu", "wsl-systemd"), p(), false);
        expect(steps.map((s) => s.name)).toEqual(["vcxsrv"]);
    });
});
