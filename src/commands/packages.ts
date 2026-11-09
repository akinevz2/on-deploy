// src/commands/packages.ts — GROUP OPERATIONS over the stow packages'
// dependency Makefiles (the depends scheme
// dots/<pkg>/.local/share/depends/<pkg>/Makefile).
//
//	on-deploy packages <rule> [pkg...]	run a rule on some packages
//	on-deploy packages <rule>	run it on EVERY package
//	that has the Makefile
//	on-deploy packages list	which packages have one
//
// Rules are the standard set the package Makefiles implement:
//	install | start | stop | uninstall | status | disable | enable
// plus whatever extra rules a package defines (archive/unarchive
// helpers from on-deploy may be called by those rules — on-deploy
// itself carries NO per-package code, only per-target code; the
// special steps live in the Makefiles' bash).

import { defineCommand } from "@bunli/core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
    checkDotsEnv, DOTS_DIR, readWmPackages,
} from "../lib/dots";
import { say } from "../lib/lines";
import { pkgMakefile, runMakeSpun, type PkgResult } from "../lib/pkgops";
import { releaseTui, tuiChecklist, tuiSelect } from "../lib/tui";
import { bind, flush, map, pure, tell, type Out } from "../lib/out";


export const STANDARD_RULES = [
    "install", "start", "stop", "uninstall", "status", "disable", "enable",
] as const;

/** every package that ships a dependency Makefile (the depends scheme
 * dots/<pkg>/.local/share/depends/<pkg>/Makefile) */
export function packagesWithMakefiles(dots: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dots, { withFileTypes: true })) {
        if (!name.isDirectory() || name.name.startsWith(".") || name.name === "defaults") continue;
        if (existsSync(join(dots, name.name, ".local", "share", "depends", name.name, "Makefile"))) {
            out.push(name.name);
        }
    }
    return out.sort();
}

/** the collected per-package results as buffered Out lines — the
 * printResults rendering, riding the walk instead of printing
 * [FLUSH-CLASS: buffered] */
function resultsOut(results: PkgResult[]): Out<number> {
    let out: Out<number> = pure(0);
    for (const r of results) {
        out = bind(out, (w) => pure(w, 
            `==${r.pkg} ${r.ok ? "SUCCESS" : "FAILURE"}`,
            ...r.lines.map((l) => `  ${l}`),
        ));
    }
    if (results.some((r) => !r.ok)) out = map(out, () => 1);
    return out;
}

async function walk(rule: string | undefined, rest: string[]): Promise<Out<number>> {
    const available = packagesWithMakefiles(DOTS_DIR);

    // TUI mode: bare + interactive -> rule menu + package checklist;
    // the Makefiles' output is CAPTURED per package and printed
    // sequentially after the TUI closes
    if (!rule && process.stdin.isTTY) {
        // [FLUSH-CLASS: prompt] the TUI below owns the terminal until
        // releaseTui — nothing may print mid-selection
        const pick = await tuiSelect<string>(
            "rule", [...STANDARD_RULES, "list"].map((r) => ({
                label: r === "list" ? "list — print packages with Makefiles" : r,
                value: r,
            })),
        );
        if (pick === null) {
            await releaseTui();
            return pure(0, "packages: cancelled");
        }
        if (pick === "list") {
            await releaseTui();
            return pure(0, `packages: ${available.join(" ")}`);
        }
        // [FLUSH-CLASS: prompt] second TUI gate, same ownership
        const sel = await tuiChecklist<string>(
            `packages for '${pick}'`,
            available.map((p) => ({ label: p, value: p })),
            { preselect: available },
        );
        if (sel === null) {
            await releaseTui();
            return pure(0, "packages: cancelled");
        }
        // prompt phase over: hand the terminal back to the CLI before
        // actioning (see tuiRunner.ts — same broken-screen class)
        await releaseTui();
        const results: PkgResult[] = [];
        for (const pkg of sel) {
            const mf = pkgMakefile(pkg);
            if (!mf) { results.push({ pkg, ok: false, lines: ["no Makefile"] }); continue; }
            const r = await runMakeSpun(mf.dir, mf.file, [], pick, `${pkg}:${pick}`);
            results.push({ pkg, ok: r.ok, lines: r.lines });
        }
        return resultsOut(results);
    }


    if (!rule || rule === "list") {
        return pure(0,
            `packages: ${available.join(" ") || "(none)"}`,
            `packages: rules: ${STANDARD_RULES.join(" ")}`,
            "packages:\thelp\ton-deploy packages help",
        );
    }
    const wanted = rest.length ? rest : available;
    let targets = wanted.filter((p) => available.includes(p));
    // A BARE sweep (no explicit names) is scoped to the stow.depends
    // manifest: the individually deployable packages
    // (novnc/x11vnc/xrdp/xvfb…) must NOT be swept by bootstrap — their
    // unstowed user units make every rule fail after installing.
    // Explicit names always win: `on-deploy packages install novnc`
    // remains the documented on-demand path.
    const manifest = readWmPackages();
    const spared = rule === "install" && !rest.length
        ? targets.filter((t) => !manifest.includes(t))
        : [];
    let out: Out<number> = pure(0);
    if (spared.length > 0) {
        out = bind(out, (w) => pure(w, 
            `packages: skipped (not in wm.depends; install on demand): ${spared.join(" ")}`,
        ));
        targets = targets.filter((t) => manifest.includes(t));
    }
    const unknown = wanted.filter((p) => !available.includes(p));
    for (const p of unknown) {
        out = bind(out, (w) => pure(w, `packages: ${p}: no Makefile`));
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
        out = bind(out, (w) => pure(w, 
            `packages: ${rule} on ${targets.join(" ") || "(none)"} — ` +
            `${what[rule] ?? "run the package's rule"}`,
        ));
    }
    // [FLUSH-CLASS: exec] the spun make children below CAPTURE their
    // output, but their spinner writes live on stderr — the notices
    // must land before the first label ticks
    flush(out);
    out = pure(0);
    const results: PkgResult[] = [];
    for (const pkg of targets) {
        const mf = pkgMakefile(pkg);
        if (!mf) { results.push({ pkg, ok: false, lines: ["no Makefile"] }); continue; }
        const r = await runMakeSpun(mf.dir, mf.file, [], rule, `${pkg}:${rule}`);
        results.push({ pkg, ok: r.ok, lines: r.lines });
    }
    const res = resultsOut(results);
    if (res.value !== 0) return res;
    return bind(res, () => pure(0, `packages: ${rule} done on ${targets.length} package(s)`));
}

export default defineCommand({
    name: "packages",
    description: "Group ops over Makefiles",
    handler: async ({ positional }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            // [FLUSH-CLASS: exit] precondition failure — the problem
            // line is the whole transcript; exit code carries severity
            say(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const [rule, ...rest] = positional;
        // [FLUSH-CLASS: exit] the walk's buffered lines flush here —
        // after this point only the exit code speaks
        const code = flush(await walk(rule, rest));
        if (code !== 0) process.exit(code);
    },
});
