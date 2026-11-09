// src/commands/check.ts — report requirement state, install nothing.

import { defineCommand, option } from "@bunli/core";
import { say } from "../lib/lines";
import { flush, tell } from "../lib/out";
import { z } from "zod";
import { checkDotsEnv, readRequires, missing, DOTS_DIR } from "../lib/dots";
import { resolvePackage } from "../lib/deployScript";

/**
 * The distro package version for an installed binary, queried via the
 * package manager — NEVER by spawning the binary itself: GUI binaries
 * (rofi) initialize their display backend on a --version probe and
 * flash a window on screen. dpkg (ubuntu) / pacman (manjaro).
 */
function pkgVersion(target: string, binary: string): string {
    const q = target === "manjaro"
        ? Bun.spawnSync(["pacman", "-Q", binary])
        : Bun.spawnSync(["dpkg-query", "-W", "-f=${Version}", binary]);
    if (q.exitCode !== 0) return "";
    return q.stdout.toString().trim();
}

export interface CheckRow {
    binary: string;
    installed: boolean;
    /** the binary's own --version answer (semantic version extracted) */
    version?: string;
    pkg?: string;
    problem?: string;
}

export async function collect(): Promise<{ rows: CheckRow[]; target: string }> {
    const requires = await readRequires();
    const gone = missing(requires.binaries);
    // PARALLEL: each binary's resolve+version probe spawns the deploy
    // script (apt-cache search ~0.8s) — sequential was ~10s for 13
    // binaries, twice per `make install` (status step). The display is
    // worth keeping; the wall time is not.
    const rows = await Promise.all(
        requires.binaries.map(async (binary): Promise<CheckRow> => {
            if (!gone.includes(binary)) {
                // FAST PATH: the package manager's own file DB answers
                // "which installed package owns this binary + its
                // version" in milliseconds; the deploy-script
                // resolution (apt-cache search) costs ~0.8s PER BINARY
                // (the pre-parallel check spent ~10s here, twice per
                // `make install`). Fallback: the deploy script —
                // non-dpkg targets and exotic binary→package mappings
                // (notify-send → libnotify) still resolve through it.
                const where = Bun.spawnSync(
                    ["sh", "-c", `command -v ${JSON.stringify(binary)}`],
                    { stdout: "pipe" },
                );
                const binPath = (where.stdout ?? "").toString().trim();
                if (binPath) {
                    // dpkg-query -S ignores -f: two steps — the owner
                    // from dpkg -S ("pkg, pkg2: /path"), the version
                    // from dpkg-query -W
                    const owner = Bun.spawnSync(["dpkg", "-S", binPath], {
                        stdout: "pipe", stderr: "ignore",
                    });
                    if (owner.exitCode === 0) {
                        const first = (owner.stdout ?? "").toString().split("\n")[0] ?? "";
                        const pkg = first.slice(0, Math.max(0, first.indexOf(":"))).trim();
                        if (pkg) {
                            const ver = Bun.spawnSync(
                                ["dpkg-query", "-W", "-f", "${Version}", pkg],
                                { stdout: "pipe", stderr: "ignore" },
                            );
                            const version = (ver.stdout ?? "").toString().trim();
                            if (version) return { binary, installed: true, version };
                        }
                    }
                }
                const res = await resolvePackage(requires.target, binary);
                const version = res.ok && res.pkg ? pkgVersion(requires.target, res.pkg) : "";
                return { binary, installed: true, version };
            }
            const res = await resolvePackage(requires.target, binary);
            if (res.ok) {
                // ONE deploy-script spawn per missing binary: the
                // resolution. The would-be install command is NOT
                // previewed through a second spawn — the walk
                // (commands/install.ts) resolves the command itself
                // when it actually installs; here the pkg name is the
                // display's whole need. The script costs ~0.6s per
                // call (apt-cache search) — doubled spawns were the
                // dominant `make status` cost.
                return { binary, installed: false, pkg: res.pkg };
            }
            return { binary, installed: false, problem: res.problem };
        }),
    );
    return { rows, target: requires.target };
}

export default defineCommand({
    name: "check",
    description: "Verify env + requirements",
    options: {
        json: option(z.boolean().optional(), { argumentKind: "flag" as const, description: "machine-readable output" }),
    },
    handler: async ({ flags }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            // [FLUSH-CLASS: exit] precondition failure — the problem
            // line is the whole transcript; exit code carries severity
            say(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const { rows, target } = await collect();
        // [FLUSH-CLASS: buffered] the report is built as an Out — no
        // spawn with inherited stdio runs after collect()
        const lines: string[] = [];
        if (flags.json) {
            lines.push(JSON.stringify({ target, rows }, null, 2));
        } else {
            lines.push(`deploy target: ${target}`);
            for (const r of rows) {
                const state = r.installed
                    ? (r.version ? `installed ${r.version}` : "installed")
                    : r.problem
                        ? `MISSING (${r.problem})`
                        : `MISSING -> ${r.pkg}`;
                lines.push(`  ${r.binary.padEnd(20)} ${state}`);
            }
        }
        // [FLUSH-CLASS: exit] the buffered report flushes here — after
        // this point only the exit code speaks
        flush(tell(...lines));
        process.exit(rows.some((r) => !r.installed) ? 1 : 0);
    },
});
