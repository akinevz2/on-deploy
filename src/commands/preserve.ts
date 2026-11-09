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
//	the CONFLICT RESOLVER: plain terminal I/O, bare minimum — per
//	package, per conflicting file, the INLINE unified diff is
//	printed and ONE accept/reject line decides: y = adopt MY
//	version into the repo (deploy keeps using it), enter/N = keep
//	the dots version (mine is archived to the store). No TUI: the
//	opentui event layer broke on submenu navigation (listener
//	overriding); a printed diff + one prompt cannot break. Adopted
//	files land in the package tree (the manifest records the
//	decisions; committing the adoption stays a manual step —
//	never auto-committed).
//	on-deploy preserve <pkg> --adopt
//       whole-package adopt-flow ("mine wins"): `stow -R --adopt`
//	moves $HOME contents into the package tree. A clean worktree
//	is REQUIRED (clean HEAD = the restore point).
//	flags: --dry-run --yes/-y --keep --restore --store <dir>
//
// The store lives outside the repo under ~/.local/share/doftiles
// (see lib/preserve.ts for the layout). Nothing here is per-package:
// all behaviors are keyed off the names GIVEN (same shape as
// archive/stow).

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { checkDotsEnv, DOTS_DIR } from "../lib/dots";
import { stowPackages } from "../lib/pkgops";
import { confirm, readLine, say } from "../lib/lines";
import { preservePackage, scanConflicts, type Conflict, type PreserveOptions } from "../lib/preserve";
import { bind, flush, map, pure, tell, type Out } from "../lib/out";

/** the unified diff text (git diff --no-index, exit code 1 = DIFFERS) */
function unifiedDiff(repoPath: string, homePath: string): string[] {
    const p = spawnSync(
        "git", ["diff", "--no-index", "--unified=3", repoPath, homePath],
        { encoding: "utf8", cwd: DOTS_DIR },
    );
    const out = p.stdout ?? "";
    return out.split("\n").filter((l) => l !== "");
}

/** the one decision per file: y = adopt (mine wins), enter/N = keep
 * the dots version (mine archived); EOF (ctrl-d) aborts the run —
 * never an implicit answer */
async function adoptPrompt(): Promise<"adopt" | "dots" | "abort"> {
    process.stdout.write("  adopt THIS file into the dots repo? [y/N] ");
    const a = await readLine();
    if (a === null) return "abort";
    return /^(y|yes)$/i.test(a.trim()) ? "adopt" : "dots";
}

/** interactive conflict resolution — plain terminal I/O, bare minimum:
 * per package, per file, the INLINE diff is printed and one
 * accept/reject line decides. No TUI layer: the opentui event loop
 * broke on submenu navigation (egregious listener overriding); a
 * printed diff + one prompt cannot break. */
async function resolveInteractive(pkgs: string[], opts: PreserveOptions): Promise<Out<number>> {
    const known = stowPackages();
    const unknown = pkgs.filter((p) => !known.includes(p));
    let out: Out<number> = pure(0, ...unknown.map((p) => `preserve: not a dots package: ${p}`));
    const targets = pkgs.filter((p) => known.includes(p));
    if (targets.length === 0 && unknown.length > 0) return map(out, () => 2);

    // 1. scan everything first: clean packages deploy at once, the
    // conflicted ones are resolved file by file below
    interface Group { pkg: string; hard: Conflict[]; conflicts: Conflict[] }
    const groups: Group[] = [];
    for (const pkg of targets) {
        const scan = scanConflicts(DOTS_DIR, process.env.HOME!, pkg);
        if (scan.hard.length > 0 || scan.conflicts.length > 0) {
            groups.push({ pkg, hard: scan.hard, conflicts: scan.conflicts });
        }
    }
    const noConflict = targets.filter((t) => !groups.some((g) => g.pkg === t));

    out = bind(out, (w) => pure(w, 
        `preserve: scanning ${targets.length} package(s); ${groups.length} with conflicts, ${noConflict.length} clean`,
        `preserve: deploying the clean ones`,
    ));
    for (const pkg of noConflict) {
        const r = await preservePackage(pkg, { ...opts, yes: true, keep: true });
        out = bind(out, (w) => pure(w, ...r.lines));
    }

    // 2. the conflicted packages, file by file: print the inline diff,
    // one accept/reject per file
    for (const group of groups) {
        const { pkg } = group;
        if (group.hard.length > 0) {
            out = bind(out, (w) => pure(w, 
                `preserve ${pkg}: HARD conflicts skipped (a directory where the package needs a file — resolve by hand):`,
                ...group.hard.map((c) => `  ${c.homePath}`),
            ));
            out = map(out, (w) => Math.max(w, 1));
        }
        if (group.conflicts.length === 0) continue;
        const dotsWins: Conflict[] = [];
        const mineWins: Conflict[] = [];
        for (const c of group.conflicts) {
            const kind = c.kind === "file" ? `${c.bytes ?? "?"}B` : c.kind;
            const diff = unifiedDiff(join(DOTS_DIR, pkg, c.rel), c.homePath);
            const body = diff.length > 0
                ? diff
                : ["  (no textual diff — binary content or already identical)"];
            // [FLUSH-CLASS: prompt] the adopt prompt below reads stdin —
            // the diff must be on the terminal before the read
            flush(bind(out, (w) => pure(w, 
                `\n===== ${c.rel} (${kind}) — dots version vs deployed ($HOME) =====`,
                ...body,
            )));
            out = pure(out.value);
            const a = await adoptPrompt();
            if (a === "abort") {
                // [FLUSH-CLASS: prompt] abort report before exit — the
                // exit(130) must not swallow the explanation
                flush(tell("preserve: EOF (ctrl-d) — stopped; undecided files stay untouched"));
                process.exit(130);
            }
            if (a === "adopt") mineWins.push(c);
            else dotsWins.push(c);
        }
        const r = await preservePackage(pkg, { ...opts, yes: true, keep: true, dotsWins, mineWins });
        out = bind(out, (w) => pure(Math.max(w, r.code), ...r.lines));
    }
    return out;
}

/** branch-flag or non-TTY flow (archive-first default per pkg) */
async function runArchiveFlow(pkgs: string[], opts: PreserveOptions): Promise<Out<number>> {
    let out: Out<number> = pure(0,
        "preserve: no TTY on this invocation " +
        "(stdin/stdout piped — e.g. running under make from a captured shell) — " +
        "the resolver UI needs a real terminal; taking the archive-first keep flow instead",
    );
    const known = stowPackages();
    const unknown = pkgs.filter((p) => !known.includes(p));
    for (const p of unknown) out = bind(out, (w) => pure(w, `preserve: not a dots package: ${p}`));
    const targets = pkgs.filter((p) => known.includes(p));
    if (unknown.length > 0 && targets.length === 0) return map(out, () => 2);
    const isTTY = !!process.stdin.isTTY;
    for (const pkg of targets) {
        const result = await preservePackage(pkg, opts, {
            ask: async () => {
                if (!isTTY) return false; // default: keep
                // [FLUSH-CLASS: prompt] confirm() below reads stdin —
                // queued lines must be on the terminal before the read
                flush(out);
                out = pure(out.value);
                const ok = await confirm(
                    `preserve ${pkg}: restore your stored files over the deployed version? [y/N] `,
                );
                if (ok === "abort") {
                    // [FLUSH-CLASS: prompt] abort report before exit —
                    // the exit(130) must not swallow the explanation
                    flush(tell("preserve: EOF (ctrl-d) — stopped"));
                    process.exit(130);
                }
                return ok === "yes";
            },
        }, DOTS_DIR);
        out = bind(out, (w) => pure(Math.max(w, result.code), ...result.lines));
    }
    return out;
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
            // [FLUSH-CLASS: exit] precondition failure — the problem
            // line is the whole transcript; exit code carries severity
            say(`on-deploy: ${env.problem}`);
            process.exit(2);
        }

        let pkgs = positional.filter(Boolean);
        if (flags.only) pkgs = flags.only.split(/[,\s]+/).filter(Boolean);
        if (pkgs.length === 0) {
            // [FLUSH-CLASS: exit] usage failure — the lines are the
            // whole transcript; exit code carries severity
            say("preserve: no packages given — available dots packages:");
            say(`preserve:\t${stowPackages().join(" ")}`);
            say("preserve:\tusage\ton-deploy preserve <pkg>|--only <pkgs> [--adopt] [--keep] [--restore] [--dry-run]");
            process.exit(2);
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
        // dry run — per-package checklist + per-file diff/decision UI.
        // NEVER in the install chain (ONDEPLOY_INSTALL_CHAIN=1): the
        // chain runs post-sudo, and post-sudo interaction is the
        // freeze class — the chain's preserve resolves as keep (the
        // ask callback's non-tty default), deterministically.
        const interactive =
            process.env.ONDEPLOY_INSTALL_CHAIN !== "1" &&
            process.stdin.isTTY &&
            process.stdout.isTTY &&
            !flags.yes && !flags.keep && !flags.restore && !flags.adopt && !flags["dry-run"];
        if (interactive) {
            // [FLUSH-CLASS: exit] the resolver's buffered lines flush
            // here — the exit code carries the worst package result
            process.exit(flush(await resolveInteractive(pkgs, opts)));
        }
        // [FLUSH-CLASS: exit] the archive flow's buffered lines flush
        // here — the exit code carries the worst package result
        process.exit(flush(await runArchiveFlow(pkgs, opts)));
    },
});
