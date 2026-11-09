#!/usr/bin/env bun
// src/index.ts — on-deploy CLI (bunli 0.8.x + Bun).
//
// Bare invocation is the dots Makefile's contract: `~/.local/bin/on.deploy`
// is called with NO arguments and must run the interactive requirement
// walk. That branch bypasses bunli's arg parsing (which would print
// help on empty argv).
//
// `apply` was FOLDED into `configure` (configure applies itself);
// `deps` was REMOVED in favor of the depends verb (see below), and
// `toolchain` CAME BACK as a language-toolchain verb (system-level
// bun/rustup management) — the per-package Makefiles call it; the
// builds themselves stay in the Makefiles.
//
// NEW (2026-11):
//	toolchain — language toolchains (--bun/--rustup; --check fail-fast)
//	depends	— sync the dots submodules + drive the per-package
//	dots/<pkg>/.local/share/depends/<pkg>/Makefile rules
//	(build/install depth).
//	detect-server — the shared X display probe; --persist-to-systemd
//	exports DISPLAY to the systemd user manager (the
//	single place DISPLAY is decided — no unit hardcodes it).

import { createCLI } from "@bunli/core";
import { say } from "./lib/lines";
import { flush } from "./lib/out";
import pkg from "../package.json";
import installCommand, { walk } from "./commands/install";
import checkCommand from "./commands/check";
import searchCommand from "./commands/search";
import pkgCommand from "./commands/pkg";
import stowCommand from "./commands/stow";
import unstowCommand from "./commands/unstow";
import enableCommand from "./commands/enable";
import disableCommand from "./commands/disable";
import configureCommand from "./commands/configure";
import archiveCommand from "./commands/archive";
import unarchiveCommand from "./commands/unarchive";
import packagesCommand from "./commands/packages";
import preserveCommand from "./commands/preserve";
import servicesCommand from "./commands/services";
import toolchainCommand from "./commands/toolchain";
import dependsCommand from "./commands/depends";
import detectServerCommand from "./commands/detect-server";
import managedCommand from "./commands/managed";
import supportsCommand from "./commands/supports";

const argv = process.argv.slice(2);
if (argv.length === 0) {
    // bare: check + interactive deploy (the on.deploy contract)
    // [FLUSH-CLASS: exit] the walk's buffered verdict flushes before
    // the exit code is chosen — nothing prints after this
    const failed = flush(await walk(false, false));
    process.exit(failed > 0 ? 1 : 0);
}

// `help` rewrites argv to bunli's own help surface (the herbstutil
// simplicity: bunli renders, nothing is hand-printed here):
//   help        -> --help
//   help <cmd>  -> <cmd> --help
//   <cmd> help  -> <cmd> --help   (the verb's own group keeps this shape)
//   --help/-h   -> handled by bunli
if (argv[0] === "help" && argv.length > 1) {
    const rest = argv.slice(1);
    process.argv = [process.argv[0], process.argv[1], ...rest, "--help"];
} else if (argv[0] === "help") {
    process.argv = [process.argv[0], process.argv[1], "--help"];
} else if (argv.length === 2 && argv[1] === "help") {
    process.argv = [process.argv[0], process.argv[1], argv[0], "--help"];
}

// bunli's createCLI() auto-imports bunli.config.ts from the cwd; a
// compiled binary cannot runtime-resolve the config's @bunli/core
// import (node_modules are not carried in the executable). chdir out
// for the createCLI/parse phase, then BACK: on-deploy's contract is
// the cwd (the ~/dots check), so the handlers must see the real one.
const compiled = !/(^|\/)bun(\.[a-z0-9]+)?$/.test(process.execPath ?? "");
const origCwd = process.cwd();
if (compiled) process.chdir("/");

const cli = await createCLI({
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
});

cli.command(installCommand);
cli.command(checkCommand);
cli.command(searchCommand);
cli.command(pkgCommand);
cli.command(stowCommand);
cli.command(unstowCommand);
cli.command(enableCommand);
cli.command(disableCommand);
cli.command(configureCommand);
cli.command(archiveCommand);
cli.command(unarchiveCommand);
cli.command(packagesCommand);
cli.command(preserveCommand);
cli.command(servicesCommand);
cli.command(toolchainCommand);
cli.command(dependsCommand);
cli.command(detectServerCommand);
cli.command(managedCommand);
cli.command(supportsCommand);

// Auto-detect a reachable X display BEFORE any command runs: every
// child this CLI spawns (package hooks, preserve, service apply)
// inherits DISPLAY from the process env. A stale inherited :X would
// otherwise hang x-bounded hooks for minutes. Failure is silent —
// headless invocations proceed as before.
import { detectDisplay } from "./lib/provisioners";
const inherited = process.env.DISPLAY;
const _d = detectDisplay();
if (_d.ok && _d.display !== inherited && process.env.ONDEPLOY_DEBUG) {
    say(`on-deploy: DISPLAY ${inherited ?? "(unset)"} dead? -> ${_d.display}`);
}

if (compiled) process.chdir(origCwd);

await cli.run();
