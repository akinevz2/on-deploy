// src/lib/preserve.ts — the preserve mechanics (see src/commands/preserve.ts):
// resolve stow conflicts for a package, keeping the user's pre-existing
// bytes recoverable.
//
// Two flows (the command's --adopt flag picks the second):
//
//   DEFAULT (archive-first, "dots wins"):
//     1. scan: $HOME/<rel> exists, is NOT dots-owned, is not a directory
//     2. copy every conflict into the store (all-or-nothing: NOTHING is
//        removed until every copy succeeded)
//     3. remove the conflict files from $HOME
//     4. stow -R (no --adopt; the conflicts are gone)
//     5. deployed = the dots version; the user's bytes sit in the store
//        until the user asks for --restore
//
//   --adopt (adopt-flow, "mine wins" — absorb live configs into the repo):
//     1. git-clean is BLOCKING (clean HEAD is the only restore point)
//     2. stow -R --adopt (moves $HOME contents into the package tree,
//        overwriting the distributed files; deployed = the user's bytes)
//     3. snapshot the adopted (user) content into the store as insurance
//        decoupled from the worktree diff
//     4. user reviews via git diff; keep (suggested git add/commit, never
//        auto-committed) or revert via `git checkout HEAD -- <pkg>`
//
// The store lives at ~/.local/state/doftiles/preserve/<pkg>/ — XDG state,
// outside the repo (zero commit/push risk), next to the existing
// ~/.local/state/doftiles/stowed. Storage layout mirrors the package's
// relpaths, plus a PRESERVE.json manifest per package. Pure functions take
// `home` explicitly (better testability than defaults.ts' module-level
// HOME); the stow/git spawns are injectable via explicit args so the
// logic is testable without the real stow/git binaries.

import {
    readdirSync, lstatSync, readlinkSync, mkdirSync, copyFileSync,
    existsSync, rmSync, statSync, writeFileSync, readFileSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { DOTS_DIR } from "./dots";
import { packageFiles, isDotsOwned } from "./defaults";
import { stowPkg } from "./pkgops";

export const PRESERVE_STORE_NAME = "preserve";

export type PreserveMode = "default" | "adopt" | "mixed";

export interface Conflict {
    /** path relative to the package (and, via stow, to $HOME) */
    rel: string;
    /** "file" | "symlink" | "symlink-dangling" | "directory" */
    kind: string;
    /** absolute $HOME path */
    homePath: string;
    /** byte size when copyable */
    bytes?: number;
    /** link target when a symlink */
    linkTarget?: string;
}

export interface ScanResult {
    /** copyable conflicts (files and live symlinks) */
    conflicts: Conflict[];
    /** directory-type mismatches: stow cannot resolve these, not even
     *  with --adopt — the package is aborted before any write */
    hard: Conflict[];
}

// ---------------------------------------------------------------------------
// store layout
// ---------------------------------------------------------------------------

/** the preserve store root: ~/.local/state/doftiles/preserve/ */
export function storeRoot(home: string): string {
    return join(home, ".local", "state", "doftiles", PRESERVE_STORE_NAME);
}

/** one package's store dir: <root>/<pkg>/ */
export function storeDir(home: string, pkg: string): string {
    return join(storeRoot(home), pkg);
}

// ---------------------------------------------------------------------------
// conflict scan
// ---------------------------------------------------------------------------
//
// A conflict is a $HOME/<rel> (for each file of the package, rel from
// packageFiles) that exists, is NOT already dots-owned, and is a file or
// symlink. A directory where the package has a file is a HARD conflict
// (type mismatch: --adopt cannot resolve it; stow would abort atomically).
// A dangling symlink is manifest-only: its link target is recorded, no
// byte copy is attempted (the target does not exist). Symlinks are kept
// BEFORE isDotsOwned resolves them: a symlink pointing INTO the repo is
// dots-owned already (skip); a symlink to a regular file elsewhere is a
// conflict (its target's bytes get copied).

export function scanConflicts(dots: string, home: string, pkg: string): ScanResult {
    const pkgDir = join(dots, pkg);
    const conflicts: Conflict[] = [];
    const hard: Conflict[] = [];
    for (const [rel] of packageFiles(pkgDir)) {
        const homePath = join(home, rel);
        let st;
        try { st = lstatSync(homePath); } catch { continue; } // absent
        if (st.isDirectory()) {
            hard.push({ rel, kind: "directory", homePath });
            continue;
        }
        if (isDotsOwned(homePath, dots)) continue;
        if (st.isSymbolicLink()) {
            let target = "";
            try { target = readlinkSync(homePath); } catch { /* dangling */ }
            if (existsSync(homePath)) {
                let bytes: number | undefined;
                try { bytes = statSync(homePath).size; } catch { /* race */ }
                conflicts.push({ rel, kind: "symlink", homePath, bytes, linkTarget: target });
            } else {
                conflicts.push({ rel, kind: "symlink-dangling", homePath, linkTarget: target });
            }
        } else {
            conflicts.push({ rel, kind: "file", homePath, bytes: st.size });
        }
    }
    return { conflicts, hard };
}

// ---------------------------------------------------------------------------
// git state
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): { code: number; out: string } {
    const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? 1, out: `${p.stdout ?? ""}`.trim() };
}

/** tracked modifications only — true when the package tree is clean at
 *  HEAD (the blocking precondition for --adopt). Untracked files do NOT
 *  fail this check (--adopt never touches them). */
export function gitClean(dots: string, pkg: string): boolean {
    return git(["diff", "--quiet", "HEAD", "--", pkg], dots).code === 0;
}

/** human-readable dirty report (porcelain), "" when clean */
export function gitStatus(dots: string, pkg: string): string {
    return git(["status", "--porcelain", "--", pkg], dots).out;
}

/** diff stat summary of what changed in the package tree ("" = no diff) */
export function gitDiffStat(dots: string, pkg: string): string {
    return git(["diff", "--stat", "--", pkg], dots).out;
}

// ---------------------------------------------------------------------------
// store operations
// ---------------------------------------------------------------------------

function manifest(store: string, data: Record<string, unknown>): void {
    writeFileSync(join(store, "PRESERVE.json"), JSON.stringify(data, null, 2) + "\n");
}

/** Copy every conflict into the store (all-or-nothing: throws BEFORE the
 *  caller removes anything). Dangling symlinks are manifest-only.
 *  Returns the rows that were copied. */
export function copyToStore(store: string, conflicts: Conflict[]): Conflict[] {
    for (const c of conflicts) {
        if (c.kind === "symlink-dangling") continue;
        const dest = join(store, c.rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(c.homePath, dest); // also copies a live symlink's target bytes
    }
    return conflicts.filter((c) => c.kind !== "symlink-dangling");
}

/** Remove the conflict files from $HOME (called only after a successful
 *  copyToStore). Dangling symlinks are removed too (their target is
 *  recorded in the manifest). */
export function removeConflicts(conflicts: Conflict[]): void {
    for (const c of conflicts) rmSync(c.homePath, { force: true });
}

/** --restore: copy the store back into the PACKAGE TREE (so deployment
 *  flips live through the symlinks, per the repo rule "edit the repo
 *  file"). Returns the restored rels. */
export function restoreFromStore(dots: string, pkg: string, store: string): string[] {
    const pkgDir = join(dots, pkg);
    const restored: string[] = [];
    if (!existsSync(store)) return restored;
    for (const [rel] of packageFiles(pkgDir)) {
        const src = join(store, rel);
        if (!existsSync(src) || statSync(src).isDirectory()) continue;
        const dest = join(pkgDir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
        restored.push(rel);
    }
    return restored;
}

/** --adopt: snapshot the adopted (user) content — now in the package
 *  tree — into the store as insurance. Uses the caller-supplied rel list
 *  (the conflicts found by the scan, which is also the adopt set).
 *  Manifest-only for dangling entries (nothing to copy). */
export function snapshotAdopted(store: string, pkgDir: string, conflicts: Conflict[]): Conflict[] {
    for (const c of conflicts) {
        if (c.kind === "symlink-dangling") continue;
        const src = join(pkgDir, c.rel);
        if (!existsSync(src)) continue;
        const dest = join(store, c.rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
    }
    return conflicts.filter((c) => c.kind !== "symlink-dangling");
}

/** write the per-package manifest (both flows + the mixed decisions) */
export function writePreserveManifest(
    store: string, pkg: string, mode: PreserveMode, conflicts: Conflict[],
    at = new Date().toISOString(),
    decisions: { rel: string; decision: "dots" | "mine" }[] = [],
): void {
    mkdirSync(store, { recursive: true });
    manifest(store, {
        app: "on-deploy preserve",
        pkg,
        mode,
        at,
        decisions,
        conflicts: conflicts.map((c) => ({
            rel: c.rel, kind: c.kind, bytes: c.bytes ?? null, linkTarget: c.linkTarget ?? null,
        })),
    });
}

// ---------------------------------------------------------------------------
// stow
// ---------------------------------------------------------------------------

/** stow -R [-–adopt] -t $HOME <pkg> (cwd ~/dots); records the remembered
 *  set exactly like stowPkg. Returns the raw output lines. */
export function stowWithAdopt(pkg: string, adopt: boolean, home: string, dots: string): { ok: boolean; lines: string[] } {
    const args = ["-R", ...(adopt ? ["--adopt"] : []), "-t", home, pkg];
    const p = Bun.spawnSync(["stow", ...args], {
        cwd: dots, stdout: "pipe", stderr: "pipe",
    });
    const lines = [`${p.stdout ?? ""}`.trim(), `${p.stderr ?? ""}`.trim()].filter(Boolean);
    const ok = (p.exitCode ?? 1) === 0;
    if (ok) {
        // record the remembered set, mirroring stowPkg
        try {
            const state = join(home, ".local", "state", "doftiles", "stowed");
            const cur = existsSync(state)
                ? readFileSync(state, "utf8").split("\n").filter(Boolean)
                : [];
            if (!cur.includes(pkg)) cur.push(pkg);
            mkdirSync(dirname(state), { recursive: true });
            writeFileSync(state, cur.sort().join("\n") + "\n");
        } catch { /* state is best-effort */ }
    }
    return { ok, lines };
}

// ---------------------------------------------------------------------------
// per-package orchestration (injectable side-effect seams for tests)
// ---------------------------------------------------------------------------

export interface PreserveSeams {
    /** stow operation; defaults to stowWithAdopt */
    stow: (pkg: string, adopt: boolean) => { ok: boolean; lines: string[] };
    /** prompt for keep/restore; defaults to the lines.ts confirm */
    ask: (pkg: string) => Promise<boolean>;
}

export interface PreserveOptions {
    dryRun: boolean;
    /** -y/--yes: skip prompts, apply the default (keep) branch */
    yes: boolean;
    /** skip prompt, keep the deployed content */
    keep: boolean;
    /** skip prompt, restore stored user content (default flow, post-stow) */
    restore: boolean;
    /** --adopt flow ("mine wins") instead of the default ("dots wins") */
    adopt: boolean;
    /** override store root (default: ~/.local/state/doftiles/preserve) */
    store?: string;
    /** per-file decisions from the interactive resolver (mixed mode):
     *  archive+remove the dots-wins files (default semantics), copy the
     *  mine-wins bytes into the package tree (per-file adopt), then
     *  stow -R once. Supersessions adopt/keep/restore prompts. */
    dotsWins?: Conflict[];
    mineWins?: Conflict[];
}

export interface PreserveResult {
    pkg: string;
    /** "ok" | "noop" | "dry-run" | "hard-conflict" | "dirty-abort" | "failed" */
    status: "ok" | "noop" | "dry-run" | "hard-conflict" | "dirty-abort" | "failed";
    /** exit-code bucket for this package (2 = precondition, 1 = operational) */
    code: 0 | 1 | 2;
    lines: string[];
}

export async function preservePackage(
    pkg: string,
    opts: PreserveOptions,
    seams: Partial<PreserveSeams> = {},
    dots: string = DOTS_DIR,
    home: string = process.env.HOME!,
): Promise<PreserveResult> {
    const lines: string[] = [];
    const store = opts.store ? join(opts.store, pkg) : storeDir(home, pkg);
    const mode: PreserveMode = opts.adopt ? "adopt" : "default";
    const scan = scanConflicts(dots, home, pkg);

    // --- hard conflicts: never fixable, abort before any write ---------
    if (scan.hard.length > 0) {
        lines.push(`preserve ${pkg}: ${scan.hard.length} hard conflict(s) — directory where the package has a file:`);
        for (const c of scan.hard) lines.push(`  ${c.homePath} (directory)`);
        lines.push("  → stow cannot resolve these (not even --adopt); resolve by hand, then re-run");
        return { pkg, status: "hard-conflict", code: 1, lines };
    }

    // --- worktree state -----------------------------------------------
    const dirty = gitStatus(dots, pkg);
    if (dirty) {
        if (opts.adopt) {
            lines.push(`preserve ${pkg}: worktree dirty — commit or stash before --adopt:`);
            for (const l of dirty.split("\n")) lines.push(`  ${l}`);
            lines.push("  → a clean HEAD is the restore point --adopt depends on; nothing was changed");
            return { pkg, status: "dirty-abort", code: 2, lines };
        }
        lines.push(`preserve ${pkg}: worktree dirty (non-blocking for the default flow):`);
        for (const l of dirty.split("\n")) lines.push(`  ${l}`);
    }

    const conflicts = scan.conflicts;

    // --- dry run -------------------------------------------------------
    if (opts.dryRun) {
        if (conflicts.length === 0) {
            lines.push(`preserve ${pkg}: nothing to preserve (dots-owned or absent)`);
        } else {
            lines.push(`preserve ${pkg}: ${conflicts.length} conflict(s) would be preserved (mode=${mode}):`);
            for (const c of conflicts) lines.push(`  ${c.rel} (${c.kind})`);
            lines.push(`  store: ${store}`);
            if (!opts.adopt) {
                for (const c of conflicts) lines.push(`  [dry-run] remove ${c.homePath}`);
            }
            lines.push(`  [dry-run] stow ${opts.adopt ? "-R --adopt" : "-R"} -t ${home} ${pkg}`);
        }
        return { pkg, status: "dry-run", code: 0, lines };
    }

    // --- no conflicts: preserve is a safe no-op, stow anyway ---------
    if (conflicts.length === 0) {
        lines.push(`preserve ${pkg}: nothing to preserve (dots-owned or absent)`);
        const r = seams.stow ? seams.stow(pkg, false) : stowWithAdopt(pkg, false, home, dots);
        if (!r.ok) {
            lines.push(...r.lines, `  stow FAILED for ${pkg}`);
            return { pkg, status: "failed", code: 1, lines };
        }
        lines.push(`preserve ${pkg}: stowed ${pkg} (no conflicts)`);
        return { pkg, status: "noop", code: 0, lines };
    }

    // --- mixed mode: per-file decisions from the interactive resolver --
    if (opts.dotsWins !== undefined || opts.mineWins !== undefined) {
        const dotsWins = opts.dotsWins ?? [];
        const mineWins = opts.mineWins ?? [];
        const decisions: { rel: string; decision: "dots" | "mine" }[] = [
            ...dotsWins.map((c) => ({ rel: c.rel, decision: "dots" as const })),
            ...mineWins.map((c) => ({ rel: c.rel, decision: "mine" as const })),
        ];
        if (dotsWins.length > 0) copyToStore(store, dotsWins);
        writePreserveManifest(store, pkg, "mixed", conflicts, undefined, decisions);
        removeConflicts(dotsWins);
        for (const c of mineWins) {
            if (c.kind === "symlink-dangling") continue;
            const dest = join(dots, pkg, c.rel);
            mkdirSync(dirname(dest), { recursive: true });
            copyFileSync(c.homePath, dest);
        }
        lines.push(
            `preserve ${pkg}: ${dotsWins.length} archived to the store, ` +
            `${mineWins.length} adopted into the repo:`,
        );
        for (const d of decisions) {
            const c = conflicts.find((x) => x.rel === d.rel);
            lines.push(`  ${d.rel} (${c?.kind ?? "?"}) -> ${d.decision === "mine" ? "ADOPTED (you may want to commit it)" : "dots version (mine is in the store)"}`);
        }
        const r = seams.stow ? seams.stow(pkg, false) : stowWithAdopt(pkg, false, home, dots);
        if (!r.ok) {
            lines.push(...r.lines, `  stow FAILED for ${pkg} after resolving — see store`);
            return { pkg, status: "failed", code: 1, lines };
        }
        lines.push(`preserve ${pkg}: stowed (mixed resolution)`);
        return { pkg, status: "ok", code: 0, lines };
    }

    // --- default flow (archive-first, "dots wins") ---------------------
    if (!opts.adopt) {
        const copied = copyToStore(store, conflicts); // throws before any removal on failure
        writePreserveManifest(store, pkg, mode, conflicts);
        removeConflicts(conflicts);
        lines.push(`preserve ${pkg}: ${copied.length} conflict(s) preserved to ${store}:`);
        for (const c of conflicts) lines.push(`  ${c.rel} (${c.kind})`);
        const r = seams.stow ? seams.stow(pkg, false) : stowWithAdopt(pkg, false, home, dots);
        if (!r.ok) {
            lines.push(...r.lines, `  stow FAILED for ${pkg} after preserving — see store`);
            return { pkg, status: "failed", code: 1, lines };
        }
        lines.push(`preserve ${pkg}: deployed the dots version; user bytes safe in ${store}`);

        // restore-or-keep prompt
        let restore = opts.restore;
        if (!opts.keep && !opts.restore && !opts.yes) {
            if (seams.ask) restore = await seams.ask(pkg);
            else {
                // non-TTY: never block; default is keep-the-dots-version
                if (!process.stdin.isTTY) {
                    lines.push("  (non-tty — keeping the dots version; restore later: on-deploy preserve " + pkg + " --restore)");
                }
            }
        }
        if (restore) {
            lines.push(`preserve ${pkg}: restoring the stored user content…`);
            const restored = restoreFromStore(dots, pkg, store);
            for (const rel of restored) lines.push(`  restored ${rel}`);
            const r2 = seams.stow ? seams.stow(pkg, false) : stowWithAdopt(pkg, false, home, dots);
            if (!r2.ok) lines.push(...r2.lines, `  stow FAILED after restore`);
            const stat = gitDiffStat(dots, pkg);
            if (stat) {
                lines.push(`  git diff --stat for ${pkg} (your content is now in the worktree):`);
                for (const l of stat.split("\n")) lines.push(`    ${l}`);
            }
            lines.push(`  keep: git add -- <paths> && git commit (never auto-committed)`);
            lines.push(`  or revert: git -C ~/dots checkout HEAD -- ${pkg}`);
        } else {
            lines.push(`  restore later: on-deploy preserve ${pkg} --restore`);
        }
        return { pkg, status: "ok", code: 0, lines };
    }

    // --- adopt flow ("mine wins") --------------------------------------
    const r = seams.stow ? seams.stow(pkg, true) : stowWithAdopt(pkg, true, home, dots);
    if (!r.ok) {
        lines.push(...r.lines, `  stow --adopt FAILED for ${pkg}`);
        return { pkg, status: "failed", code: 1, lines };
    }
    const snap = snapshotAdopted(store, join(dots, pkg), conflicts);
    writePreserveManifest(store, pkg, mode, conflicts);
    lines.push(`preserve ${pkg}: adopted ${conflicts.length} file(s) into the repo; deployed = your content (snapshot in ${store}):`);
    for (const c of conflicts) lines.push(`  ${c.rel} (${c.kind})`);
    const stat = gitDiffStat(dots, pkg);
    if (stat) {
        lines.push(`  git diff --stat for ${pkg}:`);
        for (const l of stat.split("\n")) lines.push(`    ${l}`);
    }
    let doRestore = opts.restore;
    // In the adopt flow "restore" means revert to HEAD (dots) content.
    if (!opts.keep && !opts.restore && !opts.yes) {
        if (seams.ask) doRestore = !(await seams.ask(pkg)); // ask = keep-mine?
        else {
            if (!process.stdin.isTTY) {
                lines.push("  (non-tty — keeping your adopted content; revert later: git -C ~/dots checkout HEAD -- " + pkg);
            }
        }
    }
    if (doRestore) {
        // revert: the deployed symlinks flip to dots content immediately
        const p = Bun.spawnSync(["git", "-C", dots, "checkout", "HEAD", "--", pkg], {
            stdout: "pipe", stderr: "pipe",
        });
        if ((p.exitCode ?? 1) === 0) {
            lines.push(`preserve ${pkg}: reverted to the dots version (git checkout HEAD -- ${pkg})`);
            const r2 = seams.stow ? seams.stow(pkg, false) : stowWithAdopt(pkg, false, home, dots);
            if (!r2.ok) lines.push(...r2.lines, `  stow FAILED after revert`);
        } else {
            lines.push(`  git checkout FAILED: ${`${p.stderr ?? ""}`.trim()}`);
            lines.push(`  recovery: git -C ~/dots checkout HEAD -- ${pkg} (your content is also in ${store})`);
            return { pkg, status: "failed", code: 1, lines };
        }
    } else {
        lines.push(`preserve ${pkg}: keeping your content — review: git -C ~/dots diff -- ${pkg}`);
        lines.push(`  keep: git add -- <paths> && git commit -m "adopt ${pkg} user files" (never auto-committed)`);
        void snap;
    }
    return { pkg, status: "ok", code: 0, lines };
}
