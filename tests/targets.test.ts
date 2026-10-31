// tests/targets.test.ts — the deploy target resolution + generic step
// composition (pure functions; no WM, no package manager, no fs).

import { describe, expect, test } from "bun:test";
import { resolveTarget, targetSteps } from "../src/lib/targets";

describe("resolveTarget", () => {
    test("wsl-systemd session -> debian-wsl, x server EXTERNAL (apt family)", () => {
        expect(resolveTarget("ubuntu", "wsl-systemd")).toEqual({
            key: "debian-wsl", externalXServer: true, pkgMgr: "apt",
        });
        expect(resolveTarget("debian", "wsl-systemd").key).toBe("debian-wsl");
    });

    test("managed session + apt family -> debian", () => {
        for (const session of ["greetd", "xinit", "nested"] as const) {
            const t = resolveTarget("ubuntu", session);
            expect(t).toEqual({ key: "debian", externalXServer: false, pkgMgr: "apt" });
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
        const t = resolveTarget("arch", "wsl-systemd");
        expect(t.key).toBe("archlinux");
        expect(t.externalXServer).toBe(true);
    });

    test("unsupported target -> throws", () => {
        expect(() => resolveTarget("fedora", "greetd")).toThrow(/no deploy target implementation/);
    });
});

describe("targetSteps (generic only — no package groups)", () => {
    test("wsl platform: vcxsrv + wsl-session", () => {
        const steps = targetSteps(resolveTarget("ubuntu", "wsl-systemd"), false);
        expect(steps.map((s) => s.name)).toEqual(["vcxsrv", "wsl-session"]);
    });

    test("managed platform: NO steps", () => {
        const steps = targetSteps(resolveTarget("arch", "greetd"), false);
        expect(steps).toEqual([]);
    });
});
