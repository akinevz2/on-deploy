// src/lib/defaults.ts — the ARCHIVE store: ~/dots/defaults/, a stow-
// shaped package holding the pre-deployment copies of user files that
// a package install would overwrite. The per-package SPECIAL STEPS
// (which files matter) live in the package Makefiles (bash); on-deploy
// provides the generic archive/unarchive mechanics only — no
// per-package code here.
//
//	archive <pkg>	copy $HOME/<rel> (when NOT dots-owned) into
//	defaults/<rel> for every file of package <pkg>
//	unarchive <pkg>	copy defaults/<rel> back into $HOME (restore),
//	never overwriting a dots-owned file
//
// rel is relative to the PACKAGE (stow mirrors $HOME); the defaults/
// package is NOT stowed by install.

import {
    readdirSync, statSync, readlinkSync, mkdirSync, copyFileSync,
    existsSync, realpathSync,
} from "node:fs";
import { join, relative } from "node:path";

const HOME = process.env.HOME!;
export const DEFAULTS_DIR_NAME = "defaults";

/** every file of one stow package, as [<rel-to-package>, <abs-src>] */
export function packageFiles(pkgDir: string): string[][] {
    const out: string[][] = [];
    const SKIP = new Set(["node_modules", "dist", ".git", "target", ".bunli", "build"]);
    const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.name === ".stow-local-ignore" || SKIP.has(e.name)) continue;
            const full = join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else out.push([relative(pkgDir, full), full]);
        }
    };
    walk(pkgDir);
    return out;
}

/** is $HOME/<rel> already owned by dots (resolves into the repo)? */
export function isDotsOwned(homePath: string, dots: string): boolean {
    try {
        return realpathSync(homePath).startsWith(dots + "/");
    } catch {
        return false; // dangling or absent
    }
}

export interface ArchiveRow { rel: string; kind: string }

/** ARCHIVE: copy the not-dots-owned $HOME versions of the package's
 * files into defaults/. Returns the collected rows. */
export function archivePackage(dots: string, pkg: string, dryRun: boolean): ArchiveRow[] {
    const pkgDir = join(dots, pkg);
    const defaults = join(dots, DEFAULTS_DIR_NAME);
    const collected: ArchiveRow[] = [];
    for (const [rel] of packageFiles(pkgDir)) {
        const homePath = join(HOME, rel);
        if (!existsSync(homePath)) continue;
        if (statSync(homePath).isDirectory()) continue;
        if (isDotsOwned(homePath, dots)) continue;
        let kind = "file";
        try { kind = `symlink -> ${readlinkSync(homePath)}`; } catch { /* regular */ }
        collected.push({ rel, kind });
        if (!dryRun) {
            const dest = join(defaults, rel);
            mkdirSync(join(dest, ".."), { recursive: true });
            copyFileSync(homePath, dest);
        }
    }
    return collected;
}

/** UNARCHIVE: restore defaults/<rel> back into $HOME — only where the
 * live path is NOT dots-owned (never clobber a deployed file).
 * Returns the restored rels. */
export function unarchivePackage(dots: string, pkg: string, dryRun: boolean): string[] {
    const pkgDir = join(dots, pkg);
    const defaults = join(dots, DEFAULTS_DIR_NAME);
    const restored: string[] = [];
    for (const [rel] of packageFiles(pkgDir)) {
        const backup = join(defaults, rel);
        if (!existsSync(backup) || statSync(backup).isDirectory()) continue;
        const homePath = join(HOME, rel);
        if (existsSync(homePath) && isDotsOwned(homePath, dots)) continue;
        restored.push(rel);
        if (!dryRun) {
            mkdirSync(join(homePath, ".."), { recursive: true });
            copyFileSync(backup, homePath);
        }
    }
    return restored;
}
