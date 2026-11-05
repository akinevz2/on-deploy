// src/commands/packages.ts — GROUP OPERATIONS over the stow packages'
// dependency Makefiles (the depends scheme
// dots/<pkg>/.local/state/depends/<pkg>.Makefile, with the legacy
// dots/<pkg>/.local/share/<pkg>/Makefile hook as fallback).
//
//   on-deploy packages <rule> [pkg...]     run a rule on some packages
//   on-deploy packages <rule>              run it on EVERY package
//                                          that has the Makefile
//   on-deploy packages list                which packages have one
//
// Rules are the standard set the package Makefiles implement:
//   install | start | stop | uninstall | status | disable | enable
// plus whatever extra rules a package defines (archive/unarchive
// helpers from on-deploy may be called by those rules — on-deploy
// itself carries NO per-package code, only per-target code; the
// special steps live in the Makefiles' bash).

import { defineCommand } from "@bunli/core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkDotsEnv, DOTS_DIR } from "../lib/dots";
import { printResults, runRule, type PkgResult } from "../lib/pkgops";
import { readWmPackages } from "../lib/dots";
import { tuiChecklist, tuiSelect } from "../lib/tui";


export const STANDARD_RULES = [
    "install", "start", "stop", "uninstall", "status", "disable", "enable",
] as const;

/** every package that ships a dependency Makefile (the depends scheme
 *  dots/<pkg>/.local/state/depends/<pkg>.Makefile preferred; the legacy
 *  dots/<pkg>/.local/share/<pkg>/Makefile hook as fallback) */
export function packagesWithMakefiles(dots: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dots, { withFileTypes: true })) {
        if (!name.isDirectory() || name.name.startsWith(".") || name.name === "defaults") continue;
        const stateFile = join(dots, name.name, ".local", "state", "depends", `${name.name}.Makefile`);
        const shareFile = join(dots, name.name, ".local", "share", name.name, "Makefile");
        if (existsSync(stateFile) || existsSync(shareFile)) {
            out.push(name.name);
        }
    }
    return out.sort();
}


export default defineCommand({
    name: "packages",
    description:
        "Group operations on the stow packages' dependency Makefiles (install/start/stop/uninstall/status/disable/enable); bare = TUI",
    handler: async ({ positional }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const [rule, ...rest] = positional;
        const available = packagesWithMakefiles(DOTS_DIR);

        // TUI mode: bare + interactive -> rule menu + package checklist;
        // the Makefiles' output is CAPTURED per package and printed
        // sequentially after the TUI closes
        if (!rule && process.stdin.isTTY) {
            const pick = await tuiSelect<string>(
                "rule", [...STANDARD_RULES, "list"].map((r) => ({
                    label: r === "list" ? "list — print packages with Makefiles" : r,
                    value: r,
                })),
            );
            if (pick === null) {
                console.log("packages: cancelled");
                return;
            }
            if (pick === "list") {
                console.log(`packages: ${available.join(" ")}`);
                return;
            }
            const sel = await tuiChecklist<string>(
                `packages for '${pick}'`,
                available.map((p) => ({ label: p, value: p })),
                { preselect: available },
            );
            if (sel === null) {
                console.log("packages: cancelled");
                return;
            }
            const results: PkgResult[] = [];
            for (const pkg of sel) results.push(runRule(pkg, pick));
            printResults(results);
            if (results.some((r) => !r.ok)) process.exit(1);
            return;
        }

        if (!rule || rule === "list") {
            console.log(`packages: ${available.join(" ") || "(none)"}`);
            console.log(`packages: rules: ${STANDARD_RULES.join(" ")}`);
            return;
        }
        const wanted = rest.length ? rest : available;
        let targets = wanted.filter((p) => available.includes(p));
        // A BARE sweep (no explicit names) is scoped to the wm.packages
        // manifest: the individually deployable packages
        // (novnc/x11vnc/xrdp/xvfb…) must NOT be swept by bootstrap — their
        // unstowed user units make every rule fail after installing.
        // Explicit names always win: `on-deploy packages install novnc`
        // remains the documented on-demand path.
        const manifest = readWmPackages();
        const spared = rule === "install" && !rest.length
            ? targets.filter((t) => !manifest.includes(t))
            : [];
        if (spared.length > 0) {
            console.log(
                `packages: skipped (not in wm.packages; install on demand): ${spared.join(" ")}`,
            );
            targets = targets.filter((t) => manifest.includes(t));
        }
        const unknown = wanted.filter((p) => !available.includes(p));
        for (const p of unknown) {
            console.log(`packages: ${p}: no Makefile`);
        }
        // mutating rules get a PURPOSE notice BEFORE running: the rule
        // bodies live in the package Makefiles and may invoke the
        // platform package manager — sudo prompts need their context
        // (also: what the package's rule is about to do)
        if (rule === "install" || rule === "uninstall" || rule === "enable" || rule === "disable" || rule === "start" || rule === "stop") {
            const what: Record<string, string> = {
                install: "deploy the package's binary dependencies (its Makefile may invoke the platform package manager — sudo may ask for your password)",
                uninstall: "remove the package's deployed artifacts",
                enable: "enable the package's services",
                disable: "disable the package's services",
                start: "start the package's services",
                stop: "stop the package's services",
            };
            console.log(
                `packages: ${rule} on ${targets.join(" ") || "(none)"} — ` +
                `${what[rule] ?? "run the package's rule"}`,
            );
        }
        const results: PkgResult[] = [];
        for (const pkg of targets) {
            results.push(runRule(pkg, rule));
        }
        printResults(results);
        if (results.some((r) => !r.ok)) process.exit(1);
        console.log(`packages: ${rule} done on ${targets.length} package(s)`);
    },
});
