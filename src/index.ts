#!/usr/bin/env bun
// src/index.ts — on-deploy CLI (bunli 0.8.x + Bun).
//
// Bare invocation is the dots Makefile's contract: `~/.local/bin/on.deploy`
// is called with NO arguments and must run the interactive requirement
// walk. That branch bypasses bunli's arg parsing (which would print
// help on empty argv).
//
// `apply` was FOLDED into `configure` (configure applies itself);
// `toolchain` + `deps` MOVED OUT to the depends stow package
// (depends/.local/bin/components — installing components is a package
// concern, and herbctl/polyframes builds do not belong in on-deploy).

import { createCLI } from "@bunli/core";
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

const argv = process.argv.slice(2);
if (argv.length === 0) {
    // bare: check + interactive deploy (the on.deploy contract)
    const failed = await walk(false, false);
    process.exit(failed > 0 ? 1 : 0);
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
    name: "on-deploy",
    version: "1.1.0",
    description:
        "Rigorous dotfiles requirement deployer: verify wm.requires binaries, install the missing ones via the platform deploy script.",
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

if (compiled) process.chdir(origCwd);

await cli.run();
