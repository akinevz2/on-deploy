#!/usr/bin/env bun
// src/index.ts — on-deploy CLI (bunli 0.8.x + Bun).
//
// Bare invocation is the dots Makefile's contract: `~/.local/bin/on.deploy`
// is called with NO arguments and must run the interactive requirement
// walk. That branch bypasses bunli's arg parsing (which would print
// help on empty argv).

import { createCLI } from "@bunli/core";
import deployCommand, { walk } from "./commands/deploy";
import checkCommand from "./commands/check";
import snapshotCommand from "./commands/snapshot";
import configureCommand from "./commands/configure";
import provisionCommand from "./commands/provision";

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
    version: "1.0.0",
    description:
        "Rigorous dotfiles requirement deployer: verify wm.requires binaries, install the missing ones via the platform deploy script.",
});

cli.command(deployCommand);
cli.command(checkCommand);
cli.command(snapshotCommand);
cli.command(configureCommand);
cli.command(provisionCommand);

if (compiled) process.chdir(origCwd);

await cli.run();
