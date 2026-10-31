// src/commands/toolchain.ts — the `make install` assurance steps.
//
// These USED to be four separate Makefile recipes (bun-toolchain,
// bun-trust, on-deploy-ensure, herbctl-ensure). They are not user
// choices — they are assurances the user gets when calling
// `make install`, so they live here as one command and the Makefile
// bootstrap just execs it.
//
// Steps (each idempotent, fail-soft where a failure has a clear
// self-service fix):
//   bun       bun missing but npm present -> `npm install --global bun`
//             neither -> hard fail with the platform hint
//   trust     trust the global bun packages' lifecycle scripts (bun's
//             default policy keeps postinstall blocked — herbstutil's
//             `bunli generate`, quirk 17). Untrusted set parsed from
//             `bun pm untrusted -g`; already-trusted / no-scripts /
//             not-installed are noted, never attempted.
//   herbctl   build + install ~/.local/bin/herbctl from the
//             depends/.local/share/herbctl checkout when missing
//             (--force rebuilds; the freshness flow is `make update`
//             + `toolchain --force`). The WM get-* keybinds exec it.
//   self      on-deploy itself is RUNNING this command, so it is by
//             definition installed — noted, never rebuilt here.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { checkDotsEnv, DOTS_DIR } from "../lib/dots";
import { existsSync } from "node:fs";
import { join } from "node:path";

const TRUST_PKGS = ["polyframes", "herbctl", "herbstutil", "@opencode/cli", "bun"];

function sh(cmd: string, args: string[]): { code: number; out: string } {
    const p = Bun.spawnSync([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? 1, out: (p.stdout ?? "").toString().trim() };
}

function run(cmd: string, args: string[]): number {
    const p = Bun.spawnSync([cmd, ...args], {
        stdout: "inherit", stderr: "inherit", stdin: "inherit",
    });
    return p.exitCode ?? 1;
}

/** Build + install a bunli binary from a submodule checkout. */
function buildBunli(submod: string, name: string, bin: string, dryRun: boolean): number {
    if (dryRun) {
        console.log(`    [dry-run] cd ${submod} && bun install && bun x bunli build --targets linux-x64 --minify`);
        console.log(`    [dry-run] install dist/${name} -> ${bin}`);
        return 0;
    }
    if (run("sh", ["-c", `cd "${submod}" && bun install`]) !== 0) return 1;
    if (run("sh", ["-c", `cd "${submod}" && bun x bunli build --targets linux-x64 --minify`]) !== 0) return 1;
    const distIndex = join(submod, "dist", "index");
    const distBin = join(submod, "dist", name);
    Bun.spawnSync(["mv", "-f", distIndex, distBin]);
    Bun.spawnSync(["rm", "-f", join(submod, "dist", "index.map")]);
    Bun.spawnSync(["mkdir", "-p", join(process.env.HOME!, ".local", "bin")]);
    const r = Bun.spawnSync(["install", "-m", "755", distBin, bin]);
    return r.exitCode ?? 1;
}

export default defineCommand({
    name: "toolchain",
    description:
        "make install assurance steps: bun toolchain, bun trust, herbctl binary (bun/ensure formerly separate Makefile recipes)",
    options: {
        yes: option(z.boolean().optional(), {
            description: "assume yes (non-interactive; no prompts here yet)",
            short: "y",
        }),
        "dry-run": option(z.boolean().optional(), {
            description: "print what would be done, change nothing",
        }),
        force: option(z.boolean().optional(), {
            description: "rebuild the ensured binaries even when installed",
            short: "f",
        }),
    },
    handler: async ({ flags }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const dry = !!flags["dry-run"];
        const force = !!flags.force;
        let failed = 0;
        const step = (name: string, ok: boolean, detail: string, problem?: string) => {
            console.log(`  ${name.padEnd(8)} ${ok ? "ok" : "FAILED"} — ${detail}${problem ? ` (${problem})` : ""}`);
            if (!ok) failed += 1;
        };

        // --- bun ------------------------------------------------------
        const hasBun = sh("which", ["bun"]).code === 0;
        if (hasBun) {
            step("bun", true, `${sh("bun", ["--version"]).out} ready`);
        } else {
            const hasNpm = sh("which", ["npm"]).code === 0;
            if (!hasNpm) {
                step("bun", false, "neither bun nor npm found", "install node/npm first (arch: pacman -S npm)");
            } else if (dry) {
                step("bun", true, "[dry-run] npm install --global bun");
            } else {
                const code = run("npm", ["install", "--global", "bun"]);
                step("bun", code === 0, code === 0 ? "installed through npm" : "npm install --global bun failed");
            }
        }
        if (failed > 0 && !hasBun) {
            process.exit(1); // everything downstream needs bun
        }

        // --- trust ----------------------------------------------------
        const untrusted = sh("bun", ["pm", "untrusted", "-g"]);
        for (const pkg of TRUST_PKGS) {
            if (untrusted.out.includes(`./node_modules/${pkg}`)) {
                if (dry) {
                    step("trust", true, `[dry-run] bun pm trust -g ${pkg}`);
                    continue;
                }
                const code = sh("bun", ["pm", "trust", "-g", pkg]).code;
                if (code === 0) step("trust", true, `trusted ${pkg} (postinstall scripts ran)`);
                else step("trust", false, `${pkg} postinstall blocked`, "fix the script, re-run 'on-deploy toolchain'");
            } else {
                step("trust", true, `${pkg} — trusted already or no blocked scripts`);
            }
        }

        // --- herbctl --------------------------------------------------
        const HERBCTL_SUBMOD = join(DOTS_DIR, "depends", ".local/share/herbctl");
        const HERBCTL_BIN = join(process.env.HOME!, ".local", "bin", "herbctl");
        const herbctlMissing = !existsSync(HERBCTL_BIN);
        if (herbctlMissing || force) {
            if (!existsSync(join(HERBCTL_SUBMOD, "src", "index.ts"))) {
                step("herbctl", false, "submodule checkout missing", "run 'make submodules' first");
            } else if (!hasBun) {
                step("herbctl", false, "bun not found", "arch: pacman -S bun, or npm i -g github:akinevz2/herbctl");
            } else {
                const code = buildBunli(HERBCTL_SUBMOD, "herbctl", HERBCTL_BIN, dry);
                step("herbctl", code === 0, code === 0 ? `installed ${HERBCTL_BIN}` : "build failed", code === 0 ? undefined : "bun install / bunli build output above");
            }
        } else {
            step("herbctl", true, `${HERBCTL_BIN} deployed already — skipping (--force rebuilds)`);
        }

        // --- self -----------------------------------------------------
        step("self", true, "on-deploy is running — installed by definition");

        process.exit(failed > 0 ? 1 : 0);
    },
});
