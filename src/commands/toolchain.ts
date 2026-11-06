// src/commands/toolchain.ts — LANGUAGE TOOLCHAIN management. The
// per-package Makefiles (dots/<pkg>/.local/state/depends/<pkg>.Makefile)
// own the build/install steps; the LANGUAGE they build with is a
// system concern: on-deploy installs + verifies it here.
//
//   on-deploy toolchain --bun [--check|--dry-run|-y]
//   on-deploy toolchain --rustup [--check|--dry-run|-y]
//
// Behavior:
//   present	-> report the version, done. For rustup a
//		present-but-toolchain-less state (no cargo)
//		resolves through `rustup default stable`.
//   --check	-> verify ONLY: absent/broken = fast failure
//		with the "toolchain missing" message (for
//		contexts that must install nothing).
//   --dry-run	-> resolve + report what would run, change nothing
//   otherwise	-> install through the platform: the deploy
//		target's <target>.deploy package scripts;
//		bun falls back to `npm install --global bun`
//		when the platform cannot provide it.
//		Re-verify after; still absent = hard failure.
//
// Exit codes: 0 present/installed, 2 env/precondition (usage / --check
// miss), 1 operational failure (install ran, toolchain still missing).
//
// ERROR MESSAGE LAYOUT (per rewording doctrine):
//   line 1: the solution (terse, no braces or hyphens)
//   line 2: the cause (absent name, exit code, the resolution state)
//   line 3+: the description, terse, multiline only when elaboration
//	    is really necessary
// All indentation is TABS: any multi-whitespace was folded to \t.

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
	/** the fix command that makes the post binaries appear */
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
		postFix: "rustup default stable",
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
			console.log(`\t[dry-run]\t${target}.deploy install ${pkg}`);
			return "(<dry-run>)";
		}
		if (!yes && !isInteractive()) {
			console.error("toolchain: re-run with --force, or run interactively");
			console.error(`absent:\t${res.pkg} (not yet on the system)`);
			console.error("the platform install may prompt for the root password");
			process.exit(1);
		}
		if (!yes) {
			const ok = await confirm(`\tinstall ${toolchain.probe} via ${res.pkg}? [Y/n]\t`);
			if (ok === "abort") {
				console.error("\tEOF (ctrl-d):\tstopped");
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
		console.log(`\t[dry-run]\t${toolchain.postFix} (for:\t${absent.join("\t")})`);
		return 0;
	}
	if (!yes && !isInteractive()) {
		console.error("toolchain: run the fix interactively, or re-run with --force");
		console.error(`absent:\t${absent.join("\t")}`);
		console.error("the fix downloads a full rust toolchain");
		return 1;
	}
	if (!yes) {
		const ok = await confirm(`\t${toolchain.postFix}\tproceed? [Y/n]\t`);
		if (ok === "abort") {
			console.error("\tEOF (ctrl-d):\tstopped");
			process.exit(130);
		}
		if (ok === "no") {
			console.error(`\tskipped:\t${absent.join("\t")} stay absent`);
			return 1;
		}
	}
	const run = Bun.spawn(["sh", "-c", "rustup default stable"], {
		stdout: "inherit", stderr: "inherit", stdin: "inherit",
	});
	const exit = await run.exited;
	if (exit !== 0 || !installed("cargo")) {
		console.error("toolchain: install the rust toolchain through another channel");
		console.error(`absent:\tcargo (the fix exited ${exit})`);
		console.error("rustup default stable did not yield a usable toolchain");
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
		console.log(`\t${toolchain.probe}\tpresent (${`${ver.stdout ?? ""}`.trim().split("\n")[0] ?? ""})`);
		if (toolchain.post.length === 0) return;
		const missing = toolchain.post.filter((b) => !installed(b));
		if (missing.length === 0) return;
		if (check) {
			console.error("toolchain: run the fix");
			console.error(`absent:\t${missing.join("\t")} (${toolchain.probe} present)`);
			console.error(`the fix:\t${toolchain.postFix}`);
			process.exit(2);
		}
		process.exit(await rustupPost(toolchain, dryRun, yes));
	}

	// b) absent: --check is the fail-fast contract
	if (check) {
		console.error("toolchain: install it");
		console.error(`absent:\t${key}`);
		console.error(`the command:\ton-deploy toolchain --${key}`);
		process.exit(2);
	}

	// c) install through the deploy target's package scripts
	const { target } = await readRequires();
	const cmd = await platformInstall(target, toolchain, dryRun, yes);

	// d) re-verify: the platform path ran; the toolchain must exist now
	if (installed(toolchain.probe)) {
		console.log(`\t${toolchain.probe}\tinstalled (${cmd || "<platform>"})`);
		if (toolchain.post.length > 0) process.exit(await rustupPost(toolchain, dryRun, yes));
		return;
	}

	// e) bun fallback: npm (the node toolchain's own manager) carries bun
	if (key === "bun" && installed("npm")) {
		console.log("\tbun\tthe platform resolution failed");
		console.log("\tbun\tfalling back to npm");
		if (!dryRun) {
			const run = Bun.spawn(["npm", "install", "--global", "bun"], {
				stdout: "inherit", stderr: "inherit", stdin: "inherit",
			});
			const exit = await run.exited;
			if (exit === 0 && installed("bun")) {
				console.log("\tbun\tinstalled (npm install --global bun)");
				return;
			}
			console.error("toolchain: try another transport or install bun manually");
			console.error(`absent:\tbun (npm install --global bun exited ${exit})`);
			console.error("the npm fallback also failed");
		}
	}

	console.error(`toolchain: install ${toolchain.probe} manually`);
	console.error(`absent:\t${toolchain.probe}`);
	console.error(`the deploy target '${target}' ${scriptExists(target)
		? "did not provide it (the resolution failed or was declined)"
		: "does not ship the resolution (no <target>.deploy script)"}`);
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
		force: option(z.boolean().optional(), {
			argumentKind: "flag" as const,
			description: "no confirmations (non-interactive)",
			short: "f",
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
		await ensure(key, TOOLCHAINS[key], !!flags.check, !!flags["dry-run"], !!flags.force);
	},
});
