// src/commands/toolchain.ts — LANGUAGE TOOLCHAIN management. The
// per-package Makefiles (dots/<pkg>/.local/share/depends/<pkg>/Makefile)
// own the build/install steps; the LANGUAGE they build with is a
// system concern: on-deploy installs + verifies it here.
//
//	on-deploy toolchain --bun [--check|--dry-run|-y]
//	on-deploy toolchain --rustup [--check|--dry-run|-y]
//
// Behavior:
//	present	-> report the version, done. For rustup a
//	present-but-toolchain-less state (no cargo)
//                         resolves through `rustup default stable`.
//	--check	-> verify ONLY: absent/broken = fast failure
//                         with the "toolchain missing" message (for
//	contexts that must install nothing).
//	--dry-run	-> resolve + report what would run, change nothing
//	otherwise	-> install through the platform: the deploy
//                         target's <target>.deploy package scripts;
//                         bun falls back to `npm install --global bun`
//	when the platform cannot provide it.
//	Re-verify after; still absent = hard failure.
//
// Exit codes: 0 present/installed, 2 env/precondition (usage / --check
// miss), 1 operational failure (install ran, toolchain still missing).

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { readRequires } from "../lib/dots";
import { resolvePackage, runInstall, scriptExists, installed } from "../lib/deployScript";
import { confirm, say } from "../lib/lines";
import { bind, flush, pure, tell, type Out } from "../lib/out";

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
        postFix: "rustup default stable  # installs the default toolchain",
    },
};

const isInteractive = (): boolean => process.stdin.isTTY === true;

/** resolve through the deploy scripts + run with the confirm and
 *  non-interactive guards; "" cmd = nothing ran */
async function platformInstall(
    target: string, toolchain: Toolchain, dryRun: boolean, yes: boolean,
): Promise<Out<string>> {
    if (!scriptExists(target)) return pure("");
    for (const pkg of toolchain.packages) {
        const res = await resolvePackage(target, pkg);
        if (!res.ok) continue;
        if (dryRun) {
            return pure("(<dry-run>)", `    [dry-run] ${target}.deploy install ${pkg}`);
        }
        if (!yes && !isInteractive()) {
            // [FLUSH-CLASS: prompt] the refusal must be on the terminal
            // before exit(1) — the code alone carries no explanation
            flush(tell(
                `toolchain: non-interactive terminal without --yes — ` +
                `the install of '${pkg}' may prompt (sudo). Re-run with --yes (or interactively).`,
            ));
            process.exit(1);
        }
        if (!yes) {
            // [FLUSH-CLASS: prompt] confirm() below waits on stdin
            flush(tell());
            const ok = await confirm(`         install ${toolchain.probe} via ${res.pkg}? [Y/n] `);
            if (ok === "abort") {
                // [FLUSH-CLASS: prompt] abort report before exit — the
                // exit(130) must not swallow the explanation
                flush(tell("         EOF (ctrl-d): stopped"));
                process.exit(130);
            }
            if (ok === "no") return pure("");
        }
        const inst = await runInstall(target, pkg);
        return pure(inst.ok ? inst.command : "");
    }
    return pure("");
}

/** rustup present but no usable toolchain -> `rustup default stable`.
 * Returns 0 ok, 1 failed/skipped. */
async function rustupPost(
    toolchain: Toolchain, dryRun: boolean, yes: boolean,
): Promise<Out<number>> {
    const absent = toolchain.post.filter((b) => !installed(b));
    if (absent.length === 0) return pure(0);
    if (dryRun) {
        return pure(0, `    [dry-run] ${toolchain.postFix} (for: ${absent.join(", ")})`);
    }
    if (!yes && !isInteractive()) {
        return pure(1,
            `toolchain: rustup present but ${absent.join("/")} absent, and the fix ` +
            `(\`${toolchain.postFix}\`) downloads a toolchain — run it manually or re-run with --yes.`,
        );
    }
    if (!yes) {
        // [FLUSH-CLASS: prompt] confirm() below waits on stdin
        flush(tell());
        const ok = await confirm(`         ${toolchain.postFix}\n         proceed? [Y/n] `);
        if (ok === "abort") {
            // [FLUSH-CLASS: prompt] abort report before exit — the
            // exit(130) must not swallow the explanation
            flush(tell("         EOF (ctrl-d): stopped"));
            process.exit(130);
        }
        if (ok === "no") {
            return pure(1, `         skipped — ${absent.join(", ")} stay missing`);
        }
    }
    // [FLUSH-CLASS: exec] the rustup child below inherits stdio — its
    // download output interleaves on the real terminal
    const run = Bun.spawn(["sh", "-c", "rustup default stable"], {
        stdout: "inherit", stderr: "inherit", stdin: "inherit",
    });
    const exit = await run.exited;
    if (exit !== 0 || !installed("cargo")) {
        return pure(1, `         FAILED: no usable rust toolchain (rustup default stable exited ${exit})`);
    }
    return pure(0);
}

async function ensure(
    key: string, toolchain: Toolchain, check: boolean, dryRun: boolean, yes: boolean,
): Promise<Out<number>> {
    // a) present?
    if (installed(toolchain.probe)) {
        const ver = Bun.spawnSync([toolchain.probe, "--version"], { stdout: "pipe" });
        const present = pure(0, `  ${toolchain.probe.padEnd(10)} present (${
            `${ver.stdout ?? ""}`.trim().split("\n")[0] ?? ""})`);
        if (toolchain.post.length === 0) return present;
        const missing = toolchain.post.filter((b) => !installed(b));
        if (missing.length === 0) return present;
        if (check) {
            return bind(present, () => pure(2, `toolchain missing: ${key} — ${toolchain.probe} present but ` +
                `${missing.join("/")} absent; run \`${toolchain.postFix}\` first`));
        }
        // [FLUSH-CLASS: exec] rustupPost spawns `rustup default stable`
        // with inherited stdio — the present line must land first
        flush(present);
        return await rustupPost(toolchain, dryRun, yes);
    }

    // b) absent: --check is the fail-fast contract
    if (check) {
        return pure(2, `toolchain missing: ${key} — install it via \`on-deploy toolchain --${key}\``);
    }

    // c) install through the deploy target's package scripts
    const { target } = await readRequires();
    const plat = await platformInstall(target, toolchain, dryRun, yes);
    const cmd = plat.value;

    // d) re-verify: the platform path ran; the toolchain must exist now
    if (installed(toolchain.probe)) {
        const done = bind(plat, (c) =>
            pure(0, `  ${toolchain.probe.padEnd(10)} installed (${c || "<platform>"})`));
        if (toolchain.post.length > 0) {
            // [FLUSH-CLASS: exec] rustupPost spawns `rustup default
            // stable` with inherited stdio — the installed line first
            flush(done);
            return await rustupPost(toolchain, dryRun, yes);
        }
        return done;
    }

    // e) bun fallback: npm (the node toolchain's own manager) carries bun
    if (key === "bun" && installed("npm")) {
        let out: Out<void> = bind(plat, () =>
            tell("  bun          platform resolution failed — falling back to npm"));
        if (!dryRun) {
            // [FLUSH-CLASS: exec] the npm child below inherits stdio —
            // queued lines must land before its output interleaves
            flush(out);
            out = tell();
            const run = Bun.spawn(["npm", "install", "--global", "bun"], {
                stdout: "inherit", stderr: "inherit", stdin: "inherit",
            });
            const exit = await run.exited;
            if (exit === 0 && installed("bun")) {
                return pure(0, "  bun          installed (npm install --global bun)");
            }
            out = bind(out, () => tell(`  bun          FAILED (npm exited ${exit})`));
        }
        return bind(out, () => pure(1, `toolchain missing: ${key} — ` +
            (scriptExists(target)
                ? "the platform install did not provide it (resolution failed or declined)"
                : `no <target>.deploy script for '${target}' — install ${toolchain.probe} manually`
            )));
    }

    return bind(plat, () => pure(1, `toolchain missing: ${key} — ` +
        (scriptExists(target)
            ? "the platform install did not provide it (resolution failed or declined)"
            : `no <target>.deploy script for '${target}' — install ${toolchain.probe} manually`
        )));
}

export default defineCommand({
    name: "toolchain",
    description: "Language toolchains",
    options: {
        bun: option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "ensure the bun toolchain (bunli/bun builds)",
        }),
        rustup: option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "ensure the rust toolchain manager (rustc/cargo via rustup)",
        }),
        check: option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "verify only — absent toolchain fails fast, installs NOTHING",
            short: "c",
        }),
        yes: option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "no confirmations (non-interactive)",
            short: "y",
        }),
        "dry-run": option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "resolve + report, run nothing",
        }),
    },
    handler: async ({ flags, positional }) => {
        const f = flags as Record<string, unknown>;
        const raw = (positional ?? [])[0];
        const keys = Object.keys(TOOLCHAINS).filter((k) => f[k]);
        if (keys.length !== 1) {
            // [FLUSH-CLASS: exit] usage failure — the lines are the
            // whole transcript; the exit code carries severity
            say(`toolchain: the key ${keys[0] || "(none)"} is not a supported toolchain`);
            say("toolchain:\tusage\ton-deploy toolchain <key> [--check|--dry-run|--yes]");
            say("toolchain:\thelp\ton-deploy toolchain help");
            process.exit(2);
        }
        const key = keys[0];
        // [FLUSH-CLASS: exit] the ensure walk's buffered lines flush
        // here — after this point only the exit code speaks
        const code = flush(await ensure(key, TOOLCHAINS[key], !!f.check, !!f["dry-run"], !!f.yes));
        if (code !== 0) process.exit(code);
    },
});
