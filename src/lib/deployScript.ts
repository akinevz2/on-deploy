// src/lib/deployScript.ts — the platform deploy-script contract:
//   <target>.deploy <binary>          -> prints the providing package
//   <target>.deploy install <binary>  -> prints the install COMMAND
// (stdout, trimmed; the CALLER executes the command).

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { INSTALL_BIN_DIR } from "./dots";

export function scriptPath(target: string): string {
    return join(INSTALL_BIN_DIR, `${target}.deploy`);
}

export function scriptExists(target: string): boolean {
    const p = scriptPath(target);
    return Bun.file(p).size >= 0; // existence via stat
}

export interface Resolve {
    ok: boolean;
    pkg?: string;
    problem?: string;
}

/** `<target>.deploy <binary>` -> the providing package name. */
export async function resolvePackage(target: string, binary: string): Promise<Resolve> {
    const p = scriptPath(target);
    const proc = Bun.spawn([p, binary], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    const out = (await new Response(proc.stdout).text()).trim();
    if (code !== 0 || !out) {
        return {
            ok: false,
            problem: `${target}.deploy could not resolve '${binary}' (exit ${code})`,
        };
    }
    return { ok: true, pkg: out.split("\n")[0] };
}

export interface InstallResult {
    ok: boolean;
    command: string;
    problem?: string;
}

/**
 * `<target>.deploy install <binary>` -> the install command; run it
 * with inherited stdio (sudo may prompt). The caller re-verifies the
 * binary afterwards.
 */
export async function runInstall(target: string, binary: string): Promise<InstallResult> {
    const p = scriptPath(target);
    const proc = Bun.spawn([p, "install", binary], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    const cmd = (await new Response(proc.stdout).text()).trim();
    if (code !== 0 || !cmd) {
        return { ok: false, command: "", problem: `${target}.deploy install gave no command for '${binary}'` };
    }
    const run = Bun.spawn(["sh", "-c", cmd], { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
    const exit = await run.exited;
    if (exit !== 0) {
        return { ok: false, command: cmd, problem: `install command exited ${exit}` };
    }
    return { ok: true, command: cmd };
}

/** is the binary on PATH now? */
export function installed(binary: string): boolean {
    return spawnSync("sh", ["-c", `command -v ${JSON.stringify(binary)} >/dev/null`]).status === 0;
}
