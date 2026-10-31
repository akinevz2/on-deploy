// tests/platforms.test.ts — the platform resolution + generic step
// composition (pure functions; no WM, no package manager, no fs).

import { describe, expect, test } from "bun:test";
import { platformSteps, resolvePlatform } from "../src/lib/platforms";
import type { Profile } from "../src/lib/profile";

const p = (over: Partial<Profile> = {}): Profile => ({
    features: [], session: "wsl-systemd", units: [], env: [], ...over,
});

describe("resolvePlatform", () => {
    test("wsl-systemd session -> debian-wsl, x server EXTERNAL (apt family)", () => {
        expect(resolvePlatform("ubuntu", "wsl-systemd")).toEqual({
            key: "debian-wsl", externalXServer: true, pkgMgr: "apt",
        });
        expect(resolvePlatform("debian", "wsl-systemd").key).toBe("debian-wsl");
    });

    test("managed session + apt family -> debian", () => {
        for (const session of ["greetd", "xinit", "nested"] as const) {
            const pl = resolvePlatform("ubuntu", session);
            expect(pl).toEqual({ key: "debian", externalXServer: false, pkgMgr: "apt" });
        }
    });

    test("managed session + arch family -> archlinux (pacman)", () => {
        for (const t of ["arch", "manjaro"]) {
            expect(resolvePlatform(t, "greetd")).toEqual({
                key: "archlinux", externalXServer: false, pkgMgr: "pacman",
            });
        }
    });

    test("arch + wsl -> archlinux with the external-X flag (edge)", () => {
        const pl = resolvePlatform("arch", "wsl-systemd");
        expect(pl.key).toBe("archlinux");
        expect(pl.externalXServer).toBe(true);
    });

    test("unsupported target -> throws", () => {
        expect(() => resolvePlatform("fedora", "greetd")).toThrow(/no platform implementation/);
    });
});

describe("platformSteps (generic only — no package groups)", () => {
    test("wsl platform: env + vcxsrv + wsl-session + units", () => {
        const prof = p({ units: ["herbst"], env: ["DISPLAY=:0"] });
        const steps = platformSteps(resolvePlatform("ubuntu", "wsl-systemd"), prof, false);
        expect(steps.map((s) => s.name)).toEqual(["env", "vcxsrv", "wsl-session", "units"]);
    });

    test("managed platform: env + units — NO xserver/greeter/nested/xrdp steps", () => {
        const prof = p({
            session: "greetd",
            features: ["greeter", "nested", "xrdp"],
            units: ["dunst"],
        });
        const steps = platformSteps(resolvePlatform("arch", "greetd"), prof, false);
        expect(steps.map((s) => s.name)).toEqual(["env", "units"]);
    });

    test("no units/env -> no steps on a managed platform", () => {
        const steps = platformSteps(resolvePlatform("debian", "greetd"), p({ session: "greetd" }), false);
        expect(steps).toEqual([]);
    });

    test("empty profile units on wsl -> vcxsrv only (no unit to verify)", () => {
        const steps = platformSteps(resolvePlatform("ubuntu", "wsl-systemd"), p(), false);
        expect(steps.map((s) => s.name)).toEqual(["vcxsrv"]);
    });
});
