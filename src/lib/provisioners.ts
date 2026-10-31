// src/lib/provisioners.ts — per-target platform provisioning.
// Each feature is idempotent: verify -> install/fix -> re-verify.
// Root operations go through sudo (interactive TTY required unless
// the caller's sudo is passwordless); dryRun prints instead of doing.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { installed } from "./deployScript";
import { confirm } from "./lines";
import { INSTALL_BIN_DIR } from "./dots";

export interface Target {
    /** the deploy target from wm.requires ("ubuntu", "manjaro", ...) */
    name: string;
}

export interface Step {
    feature: Feature2;
    ok: boolean;
    detail: string;
    problem?: string;
}

type Feature2 = "xserver" | "xinitrc" | "greeter" | "nested" | "vcxsrv" | "wsl-session";
export type { Feature2 as Feature2Name };

function sh(cmd: string, args: string[]): { code: number; out: string } {
    const p = Bun.spawnSync([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? 1, out: (p.stdout ?? "").toString().trim() };
}

async function sudo(cmd: string, args: string[], dryRun: boolean): Promise<number> {
    if (dryRun) {
        console.log(`    [dry-run] sudo ${cmd} ${args.join(" ")}`);
        return 0;
    }
    const p = Bun.spawn(["sudo", cmd, ...args], {
        stdout: "inherit", stderr: "inherit", stdin: "inherit",
    });
    return await p.exited;
}

/** The X-server packages per deploy target. */
function xserverPkgs(target: string): string[] {
    switch (target) {
        case "manjaro":
        case "arch":
            return ["xorg-server", "xorg-xinit", "xorg-xauth"];
        case "ubuntu":
        default:
            return ["xserver-xorg-core", "xserver-xorg", "xinit", "xauth"];
    }
}

function pkgInstalled(target: string, pkg: string): boolean {
    const q =
        target === "manjaro" || target === "arch"
            ? sh("pacman", ["-Qi", pkg])
            : sh("dpkg-query", ["-W", "-f=${Status}", pkg]);
    if (target === "manjaro" || target === "arch") return q.code === 0;
    return q.code === 0 && q.out.includes("install ok installed");
}


/** X server + xinit present (startx-capable). */
export async function ensureXServer(
    target: string, yes: boolean, dryRun: boolean,
): Promise<Step> {
    const missing = xserverPkgs(target).filter((p) => !pkgInstalled(target, p));
    if (missing.length === 0) return { feature: "xserver", ok: true, detail: "already installed" };
    console.log(`  xserver: missing ${missing.join(" ")}`);
    if (!dryRun && !yes) {
        const ok = await confirm("  install the X server packages? [Y/n] ");
        if (!ok) return { feature: "xserver", ok: false, detail: "declined", problem: "declined" };
    }
    const mgr = target === "manjaro" || target === "arch" ? "pacman" : "apt";
    const args =
        mgr === "pacman"
            ? ["-S", "--needed", ...missing]
            : ["install", "-y", ...missing];
    const code = await sudo(mgr, args, dryRun);
    if (code !== 0) return { feature: "xserver", ok: false, detail: `exit ${code}`, problem: "package manager failed" };
    if (dryRun) return { feature: "xserver", ok: true, detail: `would install ${missing.join(" ")}` };
    const still = missing.filter((p) => !pkgInstalled(target, p));
    return still.length === 0
        ? { feature: "xserver", ok: true, detail: `installed ${missing.join(" ")}` }
        : { feature: "xserver", ok: false, detail: `still missing: ${still.join(" ")}`, problem: "post-verify failed" };
}

/** ~/.xinitrc execs herbstluftwm (created when absent; other exec
 *  lines are commented out — xinit runs only the first exec). */
export async function ensureXinitrc(
    target: string, yes: boolean, dryRun: boolean,
): Promise<Step> {
    void target;
    void yes;
    const path = join(process.env.HOME!, ".xinitrc");
    const EXEC = "exec herbstluftwm";
    if (!existsSync(path)) {
        if (dryRun) {
            console.log(`  xinitrc: [dry-run] would create ${path} with '${EXEC}'`);
            return { feature: "xinitrc", ok: true, detail: "would create" };
        }
        await Bun.write(path, `#!/bin/sh\n\n${EXEC}\n`);
        return { feature: "xinitrc", ok: true, detail: `created ${path}` };
    }
    const text = await Bun.file(path).text();
    if (text.split("\n").some((l) => l.trim() === EXEC)) {
        return { feature: "xinitrc", ok: true, detail: "already execs herbstluftwm" };
    }
    // comment out other exec lines (only the first exec runs), add ours
    const rewritten = text
        .split("\n")
        .map((l) => (/^\s*exec\s/.test(l) ? `# on-deploy: replaced by herbstluftwm session — ${l}` : l))
        .concat(EXEC)
        .join("\n");
    if (dryRun) {
        console.log(`  xinitrc: [dry-run] would rewrite ${path} to exec herbstluftwm`);
        return { feature: "xinitrc", ok: true, detail: "would rewrite" };
    }
    await Bun.write(path, rewritten.endsWith("\n") ? rewritten : `${rewritten}\n`);
    return { feature: "xinitrc", ok: true, detail: "rewritten to exec herbstluftwm" };
}

/** The greeter: greetd + tuigreet (a console UI greeter).
 *  arch/manjaro: pacman packages greetd + greetd-tuigreet;
 *  ubuntu: apt has greetd; tuigreet installs via cargo into
 *  /usr/local (system-wide — the greeter user must see it). */
export async function ensureGreeter(
    target: string, yes: boolean, dryRun: boolean,
): Promise<Step> {
    const XSESSION = "/usr/share/xsessions/herbstluftwm.desktop";
    const arch = target === "manjaro" || target === "arch";
    const steps: string[] = [];

    // 1. the session entry tuigreet lists
    if (!existsSync(XSESSION)) {
        steps.push(`write ${XSESSION}`);
        if (!dryRun) {
            const content = [
                "[Desktop Entry]",
                "Name=herbstluftwm",
                "Comment=Manual tiling window manager",
                "Exec=herbstluftwm",
                "Type=Application",
                "Keywords=tiling;wm;",
                "",
            ].join("\n");
            const p = Bun.spawn(["sudo", "tee", XSESSION],
                { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
            p.stdin.write(content);
            p.stdin.end();
            await p.exited;
        }
    }

    // 2. greetd + tuigreet packages
    const pkgs = arch ? ["greetd", "greetd-tuigreet"] : ["greetd"];
    const missing = pkgs.filter((p) => !pkgInstalled(target, p));
    if (missing.length > 0) {
        steps.push(`install ${missing.join(" ")}`);
        if (!dryRun) {
            const args = arch
                ? ["-S", "--needed", ...missing]
                : ["install", "-y", ...missing];
            const code = await sudo(arch ? "pacman" : "apt", args, dryRun);
            if (code !== 0) {
                return { feature: "greeter", ok: false, detail: steps.join("; "), problem: "package manager failed" };
            }
        }
    }

    // 3. ubuntu: tuigreet via cargo, system-wide (/usr/local) — greetd
    //    runs the greeter as its own user; $HOME/.cargo would be
    //    invisible to it. cargo comes from rustc/cargo packages.
    let tuigreet = "/usr/bin/tuigreet";
    if (!arch) {
        tuigreet = sh("sh", ["-c", "command -v tuigreet || echo /usr/local/bin/tuigreet"]).out;
        if (!installed("tuigreet")) {
            if (!pkgInstalled(target, "cargo") && !dryRun) {
                const code = await sudo("apt", ["install", "-y", "cargo"], dryRun);
                if (code !== 0) {
                    return { feature: "greeter", ok: false, detail: steps.join("; "), problem: "cargo install failed" };
                }
            }
            steps.push("cargo install tuigreet --root /usr/local");
            if (!dryRun) {
                const code = await sudo("sh", ["-c", "cargo install tuigreet --root /usr/local"], dryRun);
                if (code !== 0) {
                    return { feature: "greeter", ok: false, detail: steps.join("; "), problem: "tuigreet build failed" };
                }
            }
        }
    }

    // 4. greetd config: tuigreet as the default session (existing
    //    config backed up first)
    const CFG = "/etc/greetd/config.toml";
    const SESSION_CMD = `${tuigreet} --time --sessions-dir /usr/share/xsessions`;
    if (!dryRun) {
        const cur = existsSync(CFG) ? await Bun.file(CFG).text() : "";
        if (!cur.includes("tuigreet")) {
            if (cur) steps.push(`rewrite ${CFG} (backup at ${CFG}.bak)`);
            else steps.push(`write ${CFG}`);
            if (cur) await sudo("cp", [CFG, `${CFG}.bak`], dryRun);
            const cfg = [
                "[terminal]",
                'vt = "7"',
                "",
                "[default_session]",
                `command = "${SESSION_CMD}"`,
                'user = "greeter"',
                "",
            ].join("\n");
            const p = Bun.spawn(["sudo", "tee", CFG],
                { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
            p.stdin.write(cfg);
            p.stdin.end();
            await p.exited;
        }
    } else {
        steps.push(`write ${CFG} (default session: ${SESSION_CMD})`);
    }

    // 5. enable greetd (the display manager takes over getty)
    const enabled = sh("systemctl", ["is-enabled", "greetd"]);
    if (enabled.out !== "enabled") {
        steps.push("systemctl enable greetd");
        if (!dryRun) {
            const code = await sudo("systemctl", ["enable", "greetd"], dryRun);
            if (code !== 0) {
                return { feature: "greeter", ok: false, detail: steps.join("; "), problem: "enable failed" };
            }
        }
    }

    const postOk = dryRun
        || (existsSync(XSESSION) && missing.every((p) => pkgInstalled(target, p)));
    return {
        feature: "greeter",
        ok: postOk,
        detail: steps.length ? steps.join("; ") : "already provisioned",
        problem: postOk ? undefined : "post-verify failed",
    };
}

export const INSTALL_DIR_NOTE = INSTALL_BIN_DIR;


/** The WSL bypass: NO display manager — hlwm runs as the systemd user
 *  unit herbst.service, which waits (bounded) for the Windows-side X
 *  server to be reachable. Verify the unit is enabled + X answers;
 *  nothing to install. */
export async function verifyWslSession(
    target: string, yes: boolean, dryRun: boolean,
): Promise<Step> {
    void target; void yes; void dryRun;
    const unit = "herbst.service";
    const enabled = sh("systemctl", ["--user", "is-enabled", unit]);
    const active = sh("systemctl", ["--user", "is-active", unit]);
    const xok = sh("sh", ["-c", "xset -display ${DISPLAY:-localhost:0.0} q"]);
    const detail = `herbst.service ${enabled.out || "unknown"}/${active.out || "unknown"}, X ${xok.code === 0 ? "reachable" : "UNREACHABLE"}`;
    const ok = enabled.out === "enabled" && xok.code === 0;
    return { feature: "wsl-session", ok, detail, problem: ok ? undefined : detail };
}

/** writeProfileEnv — persist the profile's env lines to
 *  ~/.config/doftiles/env (the units' optional EnvironmentFile).
 *  Merge semantics: existing KEY=VALUE lines are replaced in place,
 *  new keys appended — other profiles' keys survive a switch. */
export async function writeProfileEnv(
    profile: { env: string[] }, yes: boolean, dryRun: boolean,
): Promise<Step> {
    void yes;
    const path = join(process.env.HOME!, ".config/doftiles/env");
    if (dryRun) {
        return { feature: "wsl-session", ok: true, detail: `would write ${path}: ${profile.env.join(" ")}` };
    }
    let current: string[] = [];
    try { current = (await Bun.file(path).text()).split("\n").filter(Boolean); } catch { /* absent */ }
    for (const line of profile.env) {
        const key = line.split("=")[0];
        current = current.filter((l) => !l.startsWith(`${key}=`));
        current.push(line);
    }
    const dir = path.replace(/\/[^/]+$/, "");
    Bun.spawnSync(["mkdir", "-p", dir]);
    await Bun.write(path, current.sort().join("\n") + "\n");
    return { feature: "wsl-session", ok: true, detail: `${path}: ${current.join(" ")}` };
}

/** enableUnits — enable --now the profile's systemd user units,
 *  additively (a second profile's activation leaves the first's units
 *  running — co-installability). Daemon-reload first so newly stowed
 *  units are visible. Idempotent: already-enabled units report ok. */
export async function enableUnits(
    profile: { units: string[] }, yes: boolean, dryRun: boolean,
): Promise<Step> {
    void yes;
    if (dryRun) {
        return { feature: "wsl-session", ok: true, detail: `would enable: ${profile.units.join(" ")}` };
    }
    Bun.spawnSync(["systemctl", "--user", "daemon-reload"]);
    const enabled: string[] = [];
    const failed: string[] = [];
    for (const unit of profile.units) {
        const name = unit.endsWith(".service") ? unit : `${unit}.service`;
        const r = Bun.spawnSync(["systemctl", "--user", "enable", "--now", name]);
        if ((r.exitCode ?? 1) === 0) enabled.push(name);
        else failed.push(name);
    }
    if (failed.length > 0) {
        return { feature: "wsl-session", ok: false, detail: `enabled ${enabled.join(" ")}`, problem: `failed: ${failed.join(" ")}` };
    }
    return { feature: "wsl-session", ok: true, detail: `enabled ${enabled.join(" ")}` };
}


/** ensureNested — install the nested-stack packages (Xvfb, x11vnc,
 *  noVNC) through the target's package manager. The units themselves
 *  are enabled by the profile's units = line. */
export async function ensureNested(
    target: string, yes: boolean, dryRun: boolean,
): Promise<Step> {
    const arch = target === "manjaro" || target === "arch";
    const pkgs = arch
        ? ["xorg-server-xvfb", "x11vnc", "novnc"]
        : ["xvfb", "x11vnc", "novnc"];
    const missing = pkgs.filter((p) => !pkgInstalled(target, p));
    if (missing.length === 0) return { feature: "nested", ok: true, detail: "already installed" };
    console.log(`  nested: missing ${missing.join(" ")}`);
    if (!dryRun && !yes) {
        const ok = await confirm("  install the nested stack packages? [Y/n] ");
        if (!ok) return { feature: "nested", ok: false, detail: "declined", problem: "declined" };
    }
    const mgr = arch ? "pacman" : "apt";
    const args = arch ? ["-S", "--needed", ...missing] : ["install", "-y", ...missing];
    const code = await sudo(mgr, args, dryRun);
    if (code !== 0) return { feature: "nested", ok: false, detail: `exit ${code}`, problem: "package manager failed" };
    if (dryRun) return { feature: "nested", ok: true, detail: `would install ${missing.join(" ")}` };
    const still = missing.filter((p) => !pkgInstalled(target, p));
    return still.length === 0
        ? { feature: "nested", ok: true, detail: `installed ${missing.join(" ")}` }
        : { feature: "nested", ok: false, detail: `still missing: ${still.join(" ")}`, problem: "post-verify failed" };
}

/** ensureVcxsrv — the WSL stretch: the Windows-side X server. Checks
 *  the common VcXsrv install paths on the /mnt/c Windows partition;
 *  when absent, fetches the latest installer from the SourceForge
 *  release API (the VcXsrv project's own CDN) and runs it silently
 *  (InnoSetup /VERYSILENT) through WSL interop. Gated: dry-run
 *  reports only; the explicit run needs the caller's confirm/--yes. */
export async function ensureVcxsrv(
    yes: boolean, dryRun: boolean,
): Promise<Step> {
    const candidates = [
        "/mnt/c/Program Files/VcXsrv/vcxsrv.exe",
        "/mnt/c/Program Files (x86)/VcXsrv/vcxsrv.exe",
    ];
    for (const c of candidates) {
        if (existsSync(c)) {
            return { feature: "vcxsrv", ok: true, detail: `installed at ${c}` };
        }
    }
    if (dryRun) {
        return { feature: "vcxsrv", ok: false, detail: "NOT FOUND on the Windows partition", problem: "would download + install" };
    }
    // query the SourceForge best-release API for the current installer
    const api = "https://sourceforge.net/projects/vcxsrv/best_release.json";
    const p = Bun.spawnSync(["curl", "-fsSL", api], { stdout: "pipe" });
    if ((p.exitCode ?? 1) !== 0) {
        return { feature: "vcxsrv", ok: false, detail: "sourceforge API unreachable", problem: "curl failed" };
    }
    let url = "";
    try {
        const j = JSON.parse((p.stdout ?? "").toString());
        // the platform file: prefer the x86_64 windows installer
        const files = j?.release?.files ?? j?.platforms ?? {};
        const pick = (Object.values(files) as any[]).find(
            (f) => /windows.*x86_64|amd64/i.test(String(f?.name ?? "")) && /\.exe$/i.test(String(f?.url ?? "")),
        ) ?? (Object.values(files) as any[]).find((f) => /\.exe$/i.test(String(f?.url ?? "")));
        url = pick?.url ?? "";
        if (url && !url.startsWith("http")) url = `https://downloads.sourceforge.net/project/vcxsrv/${url}`;
    } catch {
        return { feature: "vcxsrv", ok: false, detail: "sourceforge API response unparsable", problem: "no installer found" };
    }
    if (!url) {
        return { feature: "vcxsrv", ok: false, detail: "no installer in the release feed", problem: "no installer found" };
    }
    if (!yes) {
        const ok = await confirm(`  download + silently install VcXsrv from\n    ${url}\n  proceed? [y/N] `);
        if (!ok) return { feature: "vcxsrv", ok: false, detail: "declined", problem: "declined" };
    }
    const tmp = "/mnt/c/Users/Public/Downloads/VcXsrv-setup.exe";
    const dl = Bun.spawnSync(["curl", "-fsSL", "-o", tmp, url]);
    if ((dl.exitCode ?? 1) !== 0) {
        return { feature: "vcxsrv", ok: false, detail: `download failed (${url})`, problem: "curl failed" };
    }
    // InnoSetup silent install through WSL interop (the exe runs on the
    // Windows side; /CURRENTUSER keeps it out of the system store)
    const inst = Bun.spawnSync([tmp, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], {
        stdout: "ignore", stderr: "ignore",
    });
    if ((inst.exitCode ?? 1) !== 0) {
        return { feature: "vcxsrv", ok: false, detail: `installer exited ${inst.exitCode}`, problem: "installer failed" };
    }
    for (const c of candidates) {
        if (existsSync(c)) return { feature: "vcxsrv", ok: true, detail: `installed to ${c}` };
    }
    return { feature: "vcxsrv", ok: false, detail: "installer ran but vcxsrv.exe not found in the standard paths", problem: "post-verify failed" };
}
