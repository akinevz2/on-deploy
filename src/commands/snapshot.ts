// src/commands/snapshot.ts — collect the target machine's PRE-EXISTING
// user configuration into ~/dots/defaults/ (a stow-shaped package)
// BEFORE the first deploy overwrites anything. "Restorable defaults":
//
//   on-deploy snapshot            scan + copy (skips already-dots files)
//   on-deploy snapshot --dry-run  list what would be collected
//
// Universe: every stow package (a top-level directory with .config or
// .local content, mirroring $HOME). For each file <pkg>/<rel>, if
// $HOME/<rel> exists and is NOT a symlink into ~/dots, it is copied to
// defaults/<rel>. The defaults/ package is NOT auto-stowed — restoring
// is `make restore-defaults` (or stow defaults), and the copies live in
// git so the machine's prior state is versioned from day one.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { readdirSync, statSync, readlinkSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { realpathSync } from "node:fs";
import { checkDotsEnv } from "../lib/dots";

const HOME = process.env.HOME!;

/** every file of every stow package, mirroring $HOME */
function packageFiles(dots: string): string[][] {
    const out: string[][] = [];
    for (const name of readdirSync(dots, { withFileTypes: true })) {
        if (!name.isDirectory()) continue;
        if (name.name.startsWith(".") || name.name === "defaults") continue;
        if (name.name.startsWith("system-")) continue;
        const pkg = join(dots, name.name);
        // stow package = a directory with .config or .local content
        const isPkg = [".config", ".local"].some((m) => existsSync(join(pkg, m)));
        if (!isPkg) continue;
        const SKIP = new Set(["node_modules", "dist", ".git", "target", ".bunli", "build"]);
        const walk = (dir: string): void => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                if (e.name === ".stow-local-ignore" || SKIP.has(e.name)) continue;
                const full = join(dir, e.name);
                if (e.isDirectory()) walk(full);
                // rel is relative to the PACKAGE (stow mirrors $HOME),
                // NOT to the repo root — the package name must not leak
                // into the $HOME path
                else out.push([relative(pkg, full), full]);
            }
        };
        walk(pkg);
    }
    return out;
}

/** is $HOME/<rel> already owned by dots (resolves into the repo)? */
function isDotsOwned(homePath: string, dots: string): boolean {
    try {
        return realpathSync(homePath).startsWith(dots + "/");
    } catch {
        return false; // dangling or absent
    }
}

export default defineCommand({
    name: "snapshot",
    description:
        "Collect pre-existing user config into ~/dots/defaults/ (restorable; run before the first deploy)",
    options: {
        "dry-run": option(z.boolean().optional(), {
            description: "list what would be collected, copy nothing",
        }),
    },
    handler: async ({ flags }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const dots = process.cwd();
        const defaults = join(dots, "defaults");
        const files = packageFiles(dots);

        const collect: string[][] = [];
        let dotsOwned = 0;
        let absent = 0;
        for (const [rel, src] of files) {
            const homePath = join(HOME, rel);
            if (!existsSync(homePath)) { absent += 1; continue; }
            if (statSync(homePath).isDirectory()) continue;
            // a real file behind the path: dots-owned when its realpath
            // resolves into the repo (covers folded stow dirs)
            if (isDotsOwned(homePath, dots)) { dotsOwned += 1; continue; }
            let kind = "file";
            try { kind = `symlink -> ${readlinkSync(homePath)}`; } catch { /* regular */ }
            collect.push([rel, src, kind]);
        }

        if (collect.length === 0) {
            console.log(
                `snapshot: nothing to collect — ${dotsOwned} path(s) already dots-owned, ` +
                `${absent} not present on this machine`,
            );
            return;
        }

        if (flags["dry-run"]) {
            console.log(`snapshot: would collect ${collect.length} item(s) into defaults/:`);
            for (const [rel] of collect) console.log(`  ${rel}`);
            console.log(`(skipped: ${dotsOwned} dots-owned, ${absent} absent)`);
            return;
        }

        let copied = 0;
        for (const [rel, src] of collect) {
            const dest = join(defaults, rel);
            mkdirSync(join(dest, ".."), { recursive: true });
            copyFileSync(src, dest);
            copied += 1;
        }
        console.log(`snapshot: collected ${copied} item(s) into ${defaults}`);
        console.log("snapshot: the defaults/ package is NOT stowed by install —");
        console.log("snapshot: restore with 'make restore-defaults' (or stow defaults)");
        console.log("snapshot: commit it so the machine's prior state is versioned");
    },
});
