// src/lib/provisioners.ts — GENERIC deploy target operations. No package
// names, no service names, no per-package behavior: every operation
// takes its target as an argument. The package Makefiles (bash) own
// the special steps and call `on-deploy pkg ...` for the deploy target
// package-manager work.
//
// Root operations go through sudo (interactive TTY required unless
// the caller's sudo is passwordless); dryRun prints instead of doing.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { confirm } from "./lines";

export function sh(cmd: string, args: string[]): { code: number; out: string } {
    const r = Bun.spawnSync([cmd, ...args], { stdout: "pipe" });
    return { code: r.exitCode ?? 1, out: (r.stdout ?? "").toString().trim() };
}

export async function sudo(cmd: string, args: string[], dryRun: boolean): Promise<number> {
    if (dryRun) {
        console.log(`    [dry-run] sudo ${cmd} ${args.join(" ")}`);
        return 0;
    }
    const p = Bun.spawn(["sudo", cmd, ...args], {
        stdout: "inherit", stderr: "inherit", stdin: "inherit",
    });
    return await p.exited;
}

export interface Step {
    name: string;
    ok: boolean;
    detail: string;
    problem?: string;
}

/** is the deploy target package `<pkg>` installed? (dpkg-query | pacman -Qi
 *  — resolved by the target family the CALLER passes; no package names
 *  live here) */
export function targetPkgInstalled(pkgMgr: "apt" | "pacman", pkg: string): boolean {
    if (pkgMgr === "pacman") return sh("pacman", ["-Qi", pkg]).code === 0;
    const q = sh("dpkg-query", ["-W", "-f=${Status}", pkg]);
    return q.code === 0 && q.out.includes("install ok installed");
}

/** the deploy target package-manager install/remove invocation for the
 *  NAMES the caller passes */
export async function targetPkg(
    pkgMgr: "apt" | "pacman", op: "install" | "remove",
    names: string[], yes: boolean, dryRun: boolean,
): Promise<number> {
    if (names.length === 0) return 0;
    if (op === "install") {
        const args = pkgMgr === "pacman"
            ? ["-S", "--needed", ...names]
            : ["install", "-y", ...names];
        return sudo(pkgMgr, args, dryRun);
    }
    const args = pkgMgr === "pacman" ? ["-R", ...names] : ["remove", "-y", ...names];
    return sudo(pkgMgr, args, dryRun);
}

/** verifyWslSession — the WSL session verify: the external X server
 *  reachable on the DISPLAY the units use. Unit enablement belongs to
 *  the dots services flow (service.order / package Makefiles). */
export function verifyWslSession(): Step {
    const xok = sh("sh", ["-c", 'xset -display "$1" q >/dev/null 2>&1', "-", detectDisplay().display]);
    const ok = xok.code === 0;
    return {
        name: "wsl-session", ok,
        detail: `X ${ok ? "reachable" : "UNREACHABLE"} (${process.env.DISPLAY ?? "localhost:0.0"})`,
        problem: ok ? undefined : "X server unreachable",
    };
}

/** detectDisplay — probe a REACHABLE X display and export it into the
 *  process env for every child on-deploy spawns (hooks, package
 *  Makefiles, service units depend on it).
 *
 *  WHY: the WSL2 stack has seen more than one display number
 *  (localhost:0.0 exclusively, then :1.0 from VcXsrv multiwindow
 *  re-parenting) — an inherited DEAD $DISPLAY makes X clients HANG
 *  instead of failing fast (seen with reload_theme "Cannot open
 *  display"/hung xset under `on-deploy packages install`). A stale
 *  inherited value is re-tested and discarded like any other probe.
 *
 *  Order: $DISPLAY if it answers, then localhost:0.0, localhost:1.0,
 *  :0, :1; each probe is bounded at 2s. Success rewrites
 *  process.env.DISPLAY; failure leaves the env untouched and reports
 *  ok:false — callers treat X-touching steps as unavailable, not
 *  fatally (headless targets must keep deploying). */
export function detectDisplay(): { display: string; ok: boolean; probed: string[] } {
    const xset = sh("sh", ["-c", "command -v xset"]).out;
    if (!xset) {
        return { display: process.env.DISPLAY ?? "localhost:0.0", ok: false, probed: [] };
    }
    const cands = [
        ...(process.env.DISPLAY ? [process.env.DISPLAY] : []),
        "localhost:0.0", "localhost:1.0", ":0", ":1",
    ];
    const probed: string[] = [];
    for (const d of cands) {
        probed.push(d);
        // timeout 2 guards a half-open connection (VcXsrv restart
        // mid-session) that would otherwise hang xset forever
        const r = sh("timeout", ["2", xset, "q", "-display", d]);
        if (r.code === 0) {
            process.env.DISPLAY = d;
            return { display: d, ok: true, probed };
        }
    }
    return { display: process.env.DISPLAY ?? "localhost:0.0", ok: false, probed };
}

/** ensureVcxsrv — the WSL stretch: the Windows-side X server. Checks
 *  the common VcXsrv install paths on the /mnt/c Windows partition;
 *  when absent, fetches the latest installer from the SourceForge
 *  release API and runs it silently (InnoSetup /VERYSILENT) through
 *  WSL interop. Gated: dry-run reports only; the explicit run needs
 *  the caller's confirm/--yes. deploy target code (the external X server
 *  of the wsl-systemd deployment model), not package management. */
export async function ensureVcxsrv(
    yes: boolean, dryRun: boolean,
): Promise<Step> {
    const candidates = [
        "/mnt/c/Program Files/VcXsrv/vcxsrv.exe",
        "/mnt/c/Program Files (x86)/VcXsrv/vcxsrv.exe",
    ];
    for (const c of candidates) {
        if (existsSync(c)) {
            return { name: "vcxsrv", ok: true, detail: `installed at ${c}` };
        }
    }
    // no usable Windows partition: not a WSL-interop host (automount
    // disabled leaves an empty /mnt/c mountpoint; devcontainer, nested
    // stack, bare linux have nothing there at all) — nothing to do
    let hasC = false;
    try { hasC = readdirSync("/mnt/c").length > 0; } catch { hasC = false; }
    if (!hasC) {
        return { name: "vcxsrv", ok: true, detail: "empty /mnt/c — not a WSL-interop host, skipped" };
    }
    if (dryRun) {
        return { name: "vcxsrv", ok: false, detail: "NOT FOUND on the Windows partition", problem: "would download + install" };
    }
    // query the SourceForge best-release API for the current installer
    const api = "https://sourceforge.net/projects/vcxsrv/best_release.json";
    const p = Bun.spawnSync(["curl", "-fsSL", api], { stdout: "pipe" });
    if ((p.exitCode ?? 1) !== 0) {
        return { name: "vcxsrv", ok: false, detail: "sourceforge API unreachable", problem: "curl failed" };
    }
    let url = "";
    try {
        const j = JSON.parse((p.stdout ?? "").toString());
        const files = j?.release?.files ?? j?.platforms ?? {};
        const pick = (Object.values(files) as any[]).find(
            (f) => /windows.*x86_64|amd64/i.test(String(f?.name ?? "")) && /\.exe$/i.test(String(f?.url ?? "")),
        ) ?? (Object.values(files) as any[]).find((f) => /\.exe$/i.test(String(f?.url ?? "")));
        url = pick?.url ?? "";
        if (url && !url.startsWith("http")) url = `https://downloads.sourceforge.net/project/vcxsrv/${url}`;
    } catch {
        return { name: "vcxsrv", ok: false, detail: "sourceforge API response unparsable", problem: "no installer found" };
    }
    if (!url) {
        return { name: "vcxsrv", ok: false, detail: "no installer in the release feed", problem: "no installer found" };
    }
    if (!yes) {
        const ok = await confirm(`  download + silently install VcXsrv from\n    ${url}\n  proceed? [y/N] `);
        if (ok === "abort") {
            console.error("  EOF (ctrl-d): provision stopped");
            process.exit(130);
        }
        if (ok !== "yes") return { name: "vcxsrv", ok: false, detail: "declined", problem: "declined" };
    }
    const tmp = "/mnt/c/Users/Public/Downloads/VcXsrv-setup.exe";
    const dl = Bun.spawnSync(["curl", "-fsSL", "-o", tmp, url]);
    if ((dl.exitCode ?? 1) !== 0) {
        return { name: "vcxsrv", ok: false, detail: `download failed (${url})`, problem: "curl failed" };
    }
    // InnoSetup silent install through WSL interop (the exe runs on the
    // Windows side; /CURRENTUSER keeps it out of the system store)
    const inst = Bun.spawnSync([tmp, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], {
        stdout: "ignore", stderr: "ignore",
    });
    if ((inst.exitCode ?? 1) !== 0) {
        return { name: "vcxsrv", ok: false, detail: `installer exited ${inst.exitCode}`, problem: "installer failed" };
    }
    for (const c of candidates) {
        if (existsSync(c)) return { name: "vcxsrv", ok: true, detail: `installed to ${c}` };
    }
    return { name: "vcxsrv", ok: false, detail: "installer ran but vcxsrv.exe not found in the standard paths", problem: "post-verify failed" };
}
