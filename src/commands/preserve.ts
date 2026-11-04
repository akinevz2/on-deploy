// src/commands/preserve.ts — resolve stow conflicts for the named
// packages before (re)stowing, keeping the user's pre-existing bytes
// recoverable.
//
//   on-deploy preserve <pkg> [pkg2 ...]
//       DEFAULT (archive-first, "dots wins"): conflicts are copied into
//         ~/.local/state/doftiles/preserve/<pkg>/, removed from $HOME,
//         then `stow -R` deploys the dots version. The user's bytes stay
//         in the store until --restore asks for them. TTY interactive
//         prompts offer restore-or-keep (default: keep); non-TTY
//         defaults to keep without blocking.
//   on-deploy preserve <pkg> --adopt
//       Adopt-flow ("mine wins"): `stow -R --adopt` moves $HOME contents
//         into the package tree, overwriting the distributed files, and
//         reports git diff for review. A snapshot of the adopted (user)
//         content is kept in the store as insurance; revert is
//         `git checkout HEAD -- <pkg>`. A dirty worktree aborts the
//         package (a clean HEAD is the restore point --adopt needs).
//
// The store is XDG state (~/.local/state/doftiles/preserve/<pkg>/),
// outside the repo: user content never lands in the worktree (no
// commit/push risk), and the store's lifetime is decoupled from the
// stow topology. Nothing here is per-package: all behaviors are keyed
// off the names GIVEN (same shape as archive/stow).

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { join } from "node:path";
import { checkDotsEnv, DOTS_DIR } from "../lib/dots";
import { stowPackages, whiptailChecklist } from "../lib/pkgops";
import { confirm } from "../lib/lines";
import { preservePackage, type PreserveOptions } from "../lib/preserve";

export default defineCommand({
    name: "preserve",
    description:
        "Resolve stow conflicts for packages before (re)stowing, preserving the user's pre-existing files in the XDG state store",
    options: {
        "dry-run": option(z.boolean().optional(), {
            description: "print the plan per package, change nothing",
        }),
        yes: option(z.boolean().optional(), {
            description: "assume yes (non-interactive; default is keep)",
            short: "y",
        }),
        adopt: option(z.boolean().optional(), {
            description: "adopt-flow: stow --adopt the pre-existing $HOME files into the repo and report git diff (mine wins)",
        }),
        keep: option(z.boolean().optional(), {
            description: "skip the prompt; keep the deployed content",
        }),
        restore: option(z.boolean().optional(), {
            description: "skip the prompt; restore stored user content (or revert to dots in --adopt mode)",
        }),
        store: option(z.string().optional(), {
            description: "override the store root (default ~/.local/state/doftiles/preserve)",
        }),
    },
    handler: async ({ flags, positional }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }

        let pkgs = positional.filter(Boolean);
        if (pkgs.length === 0) {
            if (!process.stdin.isTTY) {
                console.error("preserve: no packages and no tty");
                console.error("preserve: usage: on-deploy preserve <pkg> [--adopt] [--restore] [--keep] [--dry-run]");
                process.exit(2);
            }
            const all = stowPackages();
            const sel = whiptailChecklist("on-deploy preserve", "select packages", all);
            if (sel === null) {
                console.log("preserve: cancelled");
                return;
            }
            pkgs = sel;
        }

        const known = stowPackages();
        const unknown = pkgs.filter((p) => !known.includes(p));
        for (const p of unknown && unknown.length > 0 ? pkgs : []) {
            if (!known.includes(p)) console.error(`preserve: not a dots package: ${p}`);
        }
        const targets = pkgs.filter((p) => known.includes(p));
        if (unknown.length > 0 && targets.length === 0) process.exit(2);

        const opts: PreserveOptions = {
            dryRun: !!flags["dry-run"],
            yes: !!flags.yes,
            keep: !!flags.keep,
            restore: !!flags.restore,
            adopt: !!flags.adopt,
            store: flags.store,
        };
        void opts.store;

        const isTTY = !!process.stdin.isTTY;
        let worst = 0;
        for (const pkg of targets) {
            const result = await preservePackage(pkg, opts, {
                ask: async () => {
                    if (!isTTY) return false; // default: keep
                    const tty = process.stdin.isTTY as boolean;
                    if (tty) {
                        return (await confirm(
                            `preserve ${pkg}: restore your stored files over the deployed version? [y/N] `,
                        )) as unknown as boolean;
                    }
                    return false;
                },
            }, DOTS_DIR);
            for (const l of result.lines) console.log(l);
            if (result.code > worst) worst = result.code;
        }
        process.exit(worst);
    },
});
