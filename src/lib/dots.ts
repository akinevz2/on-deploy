// src/lib/dots.ts — the environment contract: the repo, its origin,
// and the wm.requires manifest.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

export const DOTS_DIR = join(process.env.HOME!, "dots");
export const INSTALL_BIN_DIR = join(process.env.HOME!, ".local/bin/install");

export interface EnvCheck {
    ok: boolean;
    /** human-readable failure reason when !ok */
    problem?: string;
}

function sh(cmd: string, args: string[], cwd?: string): { code: number; out: string } {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
    return { code: r.status ?? 1, out: (r.stdout ?? "").trim() };
}

/** a) the process must run inside ~/dots (walk-up: any SUBDIRECTORY of
 *  the repo is accepted — package Makefiles `make -C` into
 *  dots/<pkg>/.local/share/<pkg> and still call on-deploy); b) origin
 *  must be doftiles. */
export function checkDotsEnv(): EnvCheck {
    let cwd = process.cwd();
    if (cwd !== DOTS_DIR) {
        // walk up from the cwd looking for the repo root (wm.requires
        // marker) — accepts subdirectories, rejects unrelated dirs
        let dir = cwd;
        let found = "";
        for (let i = 0; i < 8 && dir !== "/" && dir !== ""; i += 1) {
            if (existsSync(join(dir, "wm.requires"))) { found = dir; break; }
            dir = dirname(dir);
        }
        if (!found || join(found) !== DOTS_DIR) {
            return { ok: false, problem: `must run inside ${DOTS_DIR} or a subdirectory of it (cwd: ${cwd})` };
        }
        cwd = DOTS_DIR;
        process.chdir(DOTS_DIR);
    }
    const remote = sh("git", ["remote", "get-url", "origin"], DOTS_DIR);
    if (remote.code !== 0 || !remote.out) {
        return { ok: false, problem: "not a git repository (or no origin)" };
    }
    if (!/akinevz2\/doftiles/.test(remote.out)) {
        return { ok: false, problem: `origin is not akinevz2/doftiles (${remote.out})` };
    }
    return { ok: true };
}

export interface Requires {
    /** line 1: space-separated required binary names */
    binaries: string[];
    /** last non-comment line: the deploy target ("ubuntu" -> ubuntu.deploy) */
    target: string;
}

/**
 * Parse wm.requires. Line 1 = the required binaries (whitespace-
 * separated); the LAST non-comment line = the deploy target name.
 * Anything else is a structural error.
 */
export async function readRequires(file = "wm.requires"): Promise<Requires> {
    const raw = Bun.file(join(DOTS_DIR, file));
    return raw.text().then((text) => {
        const lines = text
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#"));
        if (lines.length < 2) {
            throw new Error(
                `${file}: expected >=2 non-comment lines (binaries line + deploy target), got ${lines.length}`,
            );
        }
        const binaries = lines[0].split(/\s+/).filter(Boolean);
        if (binaries.length === 0) {
            throw new Error(`${file}: the first line lists no binaries`);
        }
        return { binaries, target: lines[lines.length - 1] };
    });
}

/** Which binaries are already on PATH. */
export function missing(binaries: string[]): string[] {
    return binaries.filter(
        (b) => spawnSync("sh", ["-c", `command -v ${JSON.stringify(b)} >/dev/null`]).status !== 0,
    );
}
