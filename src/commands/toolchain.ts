// src/commands/toolchain.ts — LANGUAGE TOOLCHAIN management. The
// per-package Makefiles (dots/<pkg>/.local/state/depends/<pkg>.Makefile)
// own the build/install steps; the LANGUAGE they build with is a
// system concern: on-deploy installs + verifies it here.
//
//   on-deploy toolchain --bun [--check|--dry-run|-y]
//   on-deploy toolchain --rustup [--check|--dry-run|-y]
//
// Behavior:
//   present            -> report the version, done. For rustup a
//                         present-but-toolchain-less state (no cargo)
//                         resolves through `rustup default stable`.
//   --check            -> verify ONLY: absent/broken = fast failure
//                         with the "toolchain missing" message (for
//                         contexts that must install nothing).
//   --dry-run          -> resolve + report what would run, change nothing
//   otherwise          -> install through the platform: the deploy
//                         target's <target>.deploy package scripts;
//                         bun falls back to `npm install --global bun`
//                         when the platform cannot provide it.
//                         Re-verify after; still absent = hard failure.
//
// Exit codes: 0 present/installed, 2 env/precondition (usage / --check
// miss), 1 operational failure (install ran, toolchain still missing).

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { readRequires } from "../lib/dots";
import { resolvePackage, runInstall, scriptExists, installed } from "../lib/deployScript";
import { confirm } from "../lib/lines";

interface Toolchain {
    /** the single binary that identifies the toolchain */
    probe: string;
    /** candidate names for the deploy target's package resolution */
    packages: string[];
    /** further binaries that make the toolchain USABLE (rustup's rustc/cargo) */
    post: string[];
    /** how to make the post binaries appear once the manager exists */
    postFix: string;
}

const TOOLCHAINS: Record<string, Toolchain> = {
    bun: {
        probe: "bun",
        packages: ["bun", "bun-bin"],
        post: [],
        postFix: "",
    },
    rustup: {
        probe: "rustup",
        packages: ["rustup"],
        post: ["rustc", "cargo"],
        postFix: "rustup default stable  # install toolchain",
    },
};

const isInteractive = (): boolean => process.stdin.isTTY === true;

/** resolve through the deploy scripts + run with the confirm and
 *  non-interactive guards; "" cmd = nothing ran */
async function platformInstall(
    target: string, toolchain: Toolchain, dryRun: boolean, yes: boolean,
): Promise<string> {
    if (!scriptExists(target)) return "";
    for (const pkg of toolchain.packages) {
        const res = await resolvePackage(target, pkg);
        if (!res.ok) continue;
        if (dryRun) {
            console.log(`    [dry-run] ${target}.deploy install ${pkg}`);
            return `(<dry-run>)`;
        }
        if (!yes && !isInteractive()) {
            console.error(
                `toolchain: the install of '${pkg}' may prompt (sudo).` +
                `toolchain: Re-run with --yes (or interactively).`,
            );
            process.exit(1);
        }
        if (!yes) {
            const ok = await confirm(`\tinstall ${toolchain.probe} via ${res.pkg}? [Y/n] `);
            if (ok === "abort") {
                console.error("         EOF (ctrl-d): stopped");
                process.exit(130);
            }
            if (ok === "no") return "";
        }
        const inst = await runInstall(target, pkg);
        return inst.ok ? inst.command : "";
    }
    return "";
}

/** rustup present but no usable toolchain -> `rustup default stable`.
 *  Returns 0 ok, 1 failed/skipped. */
async function rustupPost(
    toolchain: Toolchain, dryRun: boolean, yes: boolean,
): Promise<number> {
    const absent = toolchain.post.filter((b) => !installed(b));
    if (absent.length === 0) return 0;
    if (dryRun) {
        console.log(`    [dry-run] ${toolchain.postFix} (for: ${absent.join(", ")})`);
        return 0;
    }
    if (!yes && !isInteractive()) {
        console.error(
            `toolchain: rustup present but ${absent.join("/")} absent, and the fix ` +
            `(\`${toolchain.postFix}\`) downloads a toolchain — run it manually or re-run with --yes.`,
        );
        return 1;
    }
    if (!yes) {
        const ok = await confirm(`         ${toolchain.postFix}\n         proceed? [Y/n] `);
        if (ok === "abort") {
            console.error("         EOF (ctrl-d): stopped");
            process.exit(130);
        }
        if (ok === "no") {
            console.error(`         skipped — ${absent.join(", ")} stay missing`);
            return 1;
        }
    }
    const run = Bun.spawn(["sh", "-c", "rustup default stable"], {
        stdout: "inherit", stderr: "inherit", stdin: "inherit",
    });
    const exit = await run.exited;
    if (exit !== 0 || !installed("cargo")) {
        console.error(`         FAILED: no usable rust toolchain (rustup default stable exited ${exit})`);
        return 1;
    }
    return 0;
}

async function ensure(
    key: string, toolchain: Toolchain, check: boolean, dryRun: boolean, yes: boolean,
): Promise<void> {
    // a) present?
    if (installed(toolchain.probe)) {
        const ver = Bun.spawnSync([toolchain.probe, "--version"], { stdout: "pipe" });
        console.log(`  ${toolchain.probe.padEnd(10)} present (${`${ver.stdout ?? ""}`.trim().split("\n")[0] ?? ""})`);
        if (toolchain.post.length === 0) return;
        const missing = toolchain.post.filter((b) => !installed(b));
        if (missing.length === 0) return;
        if (check) {
            console.error(`toolchain missing: ${key} — ${toolchain.probe} present but ` +
                `${missing.join("/")} absent; run \`${toolchain.postFix}\` first`);
            process.exit(2);
        }
        process.exit(await rustupPost(toolchain, dryRun, yes));
    }

    // b) absent: --check is the fail-fast contract
    if (check) {
        console.error(`toolchain missing: ${key} — install it via \`on-deploy toolchain --${key}\``);
        process.exit(2);
    }

    // c) install through the deploy target's package scripts
    const { target } = await readRequires();
    const cmd = await platformInstall(target, toolchain, dryRun, yes);

    // d) re-verify: the platform path ran; the toolchain must exist now
    if (installed(toolchain.probe)) {
        console.log(`  ${toolchain.probe.padEnd(10)} installed (${cmd || "<platform>"})`);
        if (toolchain.post.length > 0) process.exit(await rustupPost(toolchain, dryRun, yes));
        return;
    }

    // e) bun fallback: npm (the node toolchain's own manager) carries bun
    if (key === "bun" && installed("npm")) {
        console.log("  bun          platform resolution failed — falling back to npm");
        if (!dryRun) {
            const run = Bun.spawn(["npm", "install", "--global", "bun"], {
                stdout: "inherit", stderr: "inherit", stdin: "inherit",
            });
            const exit = await run.exited;
            if (exit === 0 && installed("bun")) {
                console.log("  bun          installed (npm install --global bun)");
                return;
            }
            console.error(`  bun          FAILED (npm exited ${exit})`);
        }
    }

    console.error(`toolchain missing: ${key} — ` +
        (scriptExists(target)
            ? "the platform install did not provide it (resolution failed or declined)"
            : `no <target>.deploy script for '${target}' — install ${toolchain.probe} manually`
        ));
    process.exit(1);
}

export default defineCommand({
    name: "toolchain",
    description:
        "Install/verify a language toolchain the per-package Makefiles build with (--bun | --rustup); --check fail-fasts",
    options: {
        bun: option(z.boolean().optional(), {
            argumentKind: "flag" as const,
            description: "ensure the bun toolchain (bunli/bun builds)",
        }),
        rustup: option(z.boolean().optional(), {
            argumentKind: "flag" as const,
            description: "ensure the rust toolchain manager (rustc/cargo via rustup)",
        }),
        check: option(z.boolean().optional(), {
            argumentKind: "flag" as const,
            description: "verify only — absent toolchain fails fast, installs NOTHING",
            short: "c",
        }),
        yes: option(z.boolean().optional(), {
            argumentKind: "flag" as const,
            description: "no confirmations (non-interactive)",
            short: "y",
        }),
        "dry-run": option(z.boolean().optional(), {
            argumentKind: "flag" as const,
            description: "resolve + report, run nothing",
        }),
    },
    handler: async ({ flags }) => {
        const f = flags as Record<string, unknown>;
        const keys = Object.keys(TOOLCHAINS).filter((k) => f[k]);
        if (keys.length !== 1) {
            console.error("toolchain: usage: on-deploy toolchain --bun|--rustup [--check|--dry-run|-y]");
            process.exit(2);
        }
        const key = keys[0];
        await ensure(key, TOOLCHAINS[key], !!flags.check, !!flags["dry-run"], !!flags.yes);
    },
});
