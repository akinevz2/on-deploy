// src/commands/preserve.ts — resolve stow conflicts for the named
// packages before (re)stowing, keeping the user's pre-existing bytes
// recoverable.
//
//	on-deploy preserve <pkg> [pkg2 ...]
//   on-deploy preserve --only "pkg1 pkg2"
//	non-interactive (falls back automatically when the flags pick
//	a branch), or when no conflicts exist: the ARCHIVE-FIRST
//         flow ("dots wins") — conflicts are copied into
//	~/.local/share/doftiles/preserve/<pkg>/, removed from $HOME,
//         then `stow -R` deploys the dots version. TTY interactive
//	per-package prompts offer restore-or-keep (default keep);
//	non-TTY defaults to keep without blocking.
//	on-deploy preserve	(TTY, no branch flags)
//	the CONFLICT RESOLVER UI: a bunli-native (opentui) checklist of
//	packages with conflicts → per package, each conflicting file
//	gets its own decision prompt — view the INLINE diff, open the
//	full-screen SIDE-BY-SIDE diff viewer (TSX), keep the dots
//	version, or adopt MY version into the repo. Files the user
//	adopts land in the package tree (manifest records the
//	decisions; committing the adoption stays a manual step —
//	never auto-committed).
//	on-deploy preserve <pkg> --adopt
//       whole-package adopt-flow ("mine wins"): `stow -R --adopt`
//	moves $HOME contents into the package tree. A clean worktree
//	is REQUIRED (clean HEAD = the restore point).
//	flags: --dry-run --yes/-y --keep --restore --store <dir>
//
// The store is XDG state (see lib/preserve.ts for the layout), outside
// the repo. Nothing here is per-package: all behaviors are keyed off
// the names GIVEN (same shape as archive/stow).

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { checkDotsEnv, DOTS_DIR } from "../lib/dots";
import { stowPackages } from "../lib/pkgops";
import { confirm , say } from "../lib/lines";
import { preservePackage, scanConflicts, type Conflict, type PreserveOptions } from "../lib/preserve";
import { showDiffView } from "../lib/diffview";
import { tuiChecklist, tuiSelect } from "../lib/tui";

/** the unified diff text (git diff --no-index, exit code 1 = DIFFERS) */
function unifiedDiff(repoPath: string, homePath: string): string[] {
    const p = spawnSync(
        "git", ["diff", "--no-index", "--unified=3", repoPath, homePath],
        { encoding: "utf8", cwd: DOTS_DIR },
    );
    const out = p.stdout ?? "";
    return out.split("\n").filter((l) => l !== "");
}

/** the per-file diff data for BOTH views, AT ONCE (the TSX viewer
 * toggles between them without recomputation) */
function diffViews(repoPath: string, homePath: string) {
    const cols = Math.max(80, process.stdout.columns ?? 100);
    const page = Math.max(40, Math.floor(cols / 2) - 3);
    const p = spawnSync(
        "diff", ["-y", "--width", String(page), repoPath, homePath],
        { encoding: "utf8" },
    );
    const side: { left: string; right: string }[] = [];
    for (const row of (p.stdout ?? "").split("\n")) {
        if (row === "") continue;
        // `diff -y` puts its cset gutter (| < >) right after the width;
        // split there so each half is a clean cell
        const left = row.slice(0, page).trimEnd();
        const right = row.slice(page + 1).trimEnd();
        side.push({ left, right });
    }
    return { side, unified: unifiedDiff(repoPath, homePath) };
}

/** interactive conflict resolution — per package, per file */
async function resolveInteractive(pkgs: string[], opts: PreserveOptions): Promise<number> {
    const known = stowPackages();
    const unknown = pkgs.filter((p) => !known.includes(p));
    for (const p of unknown) console.log(`preserve: not a dots package: ${p}`);
    const targets = pkgs.filter((p) => known.includes(p));
    if (targets.length === 0 && unknown.length > 0) process.exit(2);

    // 1. scan everything first so the checklist can show counts
    interface Group { pkg: string; hard: Conflict[]; conflicts: Conflict[] }
    const groups: Group[] = [];
    for (const pkg of targets) {
        const scan = scanConflicts(DOTS_DIR, process.env.HOME!, pkg);
        if (scan.hard.length > 0 || scan.conflicts.length > 0) {
            groups.push({ pkg, hard: scan.hard, conflicts: scan.conflicts });
        }
    }
    const noConflict = targets.filter((t) => !groups.some((g) => g.pkg === t));

    console.log(`preserve: scanning ${targets.length} package(s); ${groups.length} with conflicts, ${noConflict.length} clean`);
    console.log(`preserve: deploying the clean ones`);
    for (const pkg of noConflict) {
        const r = await preservePackage(pkg, { ...opts, yes: true, keep: true });
        for (const l of r.lines) console.log(l);
    }

    let worst = 0;
    if (groups.length === 0) return 0;

    // 2. package-level checklist
    const chosen = await tuiChecklist<string>(
        "preserve — packages with conflicts; select the ones to resolve now:",
        groups.map((g) => ({
            label: g.pkg,
            value: g.pkg,
            hint: g.hard.length > 0
                ? `${g.hard.length} HARD (directories; skip and fix by hand)`
                : `${g.conflicts.length} file(s)`,
        })),
        { preselect: groups.map((g) => g.pkg) },
    );
    if (chosen === null) {
        console.log("preserve: cancelled — nothing staged; deploying the clean packages only");
        return worst;
    }

    // 3. per-file resolutions
    for (const pkg of chosen) {
        const group = groups.find((g) => g.pkg === pkg)!;
        if (group.hard.length > 0) {
            console.log(`preserve ${pkg}: hard conflicts skipped (resolve by hand):`);
            for (const c of group.hard) console.log(`  ${c.homePath} (directory where the package needs a file)`);
            worst = Math.max(worst, 1);
        }
        const resolvable = group.conflicts;
        if (resolvable.length === 0) continue;
        const dotsWins: Conflict[] = [];
        const mineWins: Conflict[] = [];
        for (const c of resolvable) {
            const kind = c.kind === "file" ? `${c.bytes ?? "?"}B` : c.kind;
            // build both diff texts ONCE per file (the TSX viewer and
            // the inline fallback share them)
            let viewer: { side: { left: string; right: string }[]; unified: string[] } | null = null;
            const repoPath = join(DOTS_DIR, pkg, c.rel);
            for (;;) {
                const a = await tuiSelect<string>(`${c.rel} (${kind}) — resolve how?`, [
                    { label: "keep the DOTS version (mine goes to the XDG store)", value: "dots", hint: "default (enter)" },
                    { label: "adopt MY version into the repo (deploy keeps using it)", value: "mine" },
                    { label: "view side-by-side diff (full screen)", value: "side" },
                    { label: "view inline diff", value: "inline" },
                    { label: "cancel — skip this file and the rest of the package", value: "cancel" },
                ]);
                if (a === null) break; // cancel: skip the whole package
                if (a === "side" || a === "inline") {
                    if (!viewer) viewer = diffViews(repoPath, c.homePath);
                    try {
                        await showDiffView({ rel: c.rel, side: viewer.side, unified: viewer.unified });
                    } catch (err) {
                        // fallback: inline (unified colors are re-colored by flag, so plain)
                        console.log(
                            `--- ${c.rel}\n${viewer.unified.join("\n")}`,
                        );
                        console.log(`preserve: diff rendering failed (${(err as Error).message}); unified diff printed above`);
                    }
                    continue; // decision loop resumes
                }
                if (a === "dots") { dotsWins.push(c); break; }
                if (a === "mine") { mineWins.push(c); break; }
                break; // cancel: leave the rest unresolved
            }
        }
        if (dotsWins.length === 0 && mineWins.length === 0) {
            console.log(`preserve ${pkg}: no decisions — left untouched`);
            continue;
        }
        const r = await preservePackage(pkg, { ...opts, yes: true, keep: true, dotsWins, mineWins });
        for (const l of r.lines) console.log(l);
        if (r.code > worst) worst = r.code;
    }
    return worst;
}

export default defineCommand({
    name: "preserve",
    description: "Resolve stow conflicts",
    options: {
        "dry-run": option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "print the plan per package, change nothing",
        }),
        yes: option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "assume yes (non-interactive; default is keep)",
            short: "y",
        }),
        only: option(z.string().optional(), {
            description: "comma/space-separated packages (skips the TUI checklist)",
        }),
        adopt: option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "adopt-flow: stow --adopt the pre-existing $HOME files into the repo and report git diff (mine wins)",
        }),
        keep: option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "skip the prompt; keep the deployed content",
        }),
        restore: option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "skip the prompt; restore stored user content (or revert to dots in --adopt mode)",
        }),
        store: option(z.string().optional(), {
            description: "override the store root (default ~/.local/share/doftiles/preserve)",
        }),
    },
    handler: async ({ flags, positional }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            say(`on-deploy: ${env.problem}`);
            process.exit(2);
        }

        let pkgs = positional.filter(Boolean);
        if (flags.only) pkgs = flags.only.split(/[,\s]+/).filter(Boolean);
        if (pkgs.length === 0) {
            if (!process.stdin.isTTY) {
                say("preserve: no packages and no tty");
                say("preserve: usage: on-deploy preserve <pkg>|--only <pkgs> [--adopt] [--restore] [--keep] [--dry-run]");
                process.exit(2);
            }
            const all = stowPackages();
            const sel = await tuiChecklist<string>(
                "preserve — select packages",
                all.map((l) => ({ label: l, value: l })),
            );
            if (sel === null) {
                console.log("preserve: cancelled");
                process.exit(130);
            }
            pkgs = sel;
        }

        const opts: PreserveOptions = {
            dryRun: !!flags["dry-run"],
            yes: !!flags.yes,
            keep: !!flags.keep,
            restore: !!flags.restore,
            adopt: !!flags.adopt,
            store: flags.store,
        };

        // THE RESOLVER: interactive TTY, no branch flags picked, not a
        // dry run — per-package checklist + per-file diff/decision UI
        const interactive =
            process.stdin.isTTY &&
            process.stdout.isTTY &&
            !flags.yes && !flags.keep && !flags.restore && !flags.adopt && !flags["dry-run"];
        let worst = 0;
        if (interactive) {
            worst = await resolveInteractive(pkgs, opts);
            process.exit(worst);
        }
        console.log(
            "preserve: no TTY on this invocation " +
            "(stdin/stdout piped — e.g. running under make from a captured shell) — " +
            "the resolver UI needs a real terminal; taking the archive-first keep flow instead",
        );

        // branch-flag or non-TTY flow (archive-first default per pkg)
        const known = stowPackages();
        const unknown = pkgs.filter((p) => !known.includes(p));
        for (const p of unknown) say(`preserve: not a dots package: ${p}`);
        const targets = pkgs.filter((p) => known.includes(p));
        if (unknown.length > 0 && targets.length === 0) process.exit(2);
        const isTTY = !!process.stdin.isTTY;
        for (const pkg of targets) {
            const result = await preservePackage(pkg, opts, {
                ask: async () => {
                    if (!isTTY) return false; // default: keep
                    const ok = await confirm(
                        `preserve ${pkg}: restore your stored files over the deployed version? [y/N] `,
                    );
                    if (ok === "abort") {
                        say("preserve: EOF (ctrl-d) — stopped");
                        process.exit(130);
                    }
                    return ok === "yes";
                },
            }, DOTS_DIR);
            for (const l of result.lines) console.log(l);
            if (result.code > worst) worst = result.code;
        }
        process.exit(worst);
    },
});

