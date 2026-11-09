// src/lib/userBranch.ts — the USER-BRANCH configuration model (2026-11,
// replaces the skip-worktree manifest dance).
//
// MODEL: mainline `main` carries the GENERIC manifests. A machine that
// personalizes them lives on a branch named after its unix username
// (id -un, honoring SUDO_USER): `configure` ensures that branch exists
// (created from the current HEAD on the first personalization), stages
// the config files (they are .gitignore'd — add -f, and --sparse since
// skip-worktree-era entries may carry the bit) and COMMITS the change.
// The working tree stays CLEAN at all times — no skip-worktree flags,
// no stash dances, no phantom dirtiness for the reconfigure gate.
//
// `make update` completes the model (dots Makefile): when the user
// branch exists, it is REBASED onto origin/main; a rebase conflict is
// the new volition point, resolved by hand (the branch ref is never
// touched by the updater otherwise).
//
// Everything here is BEST-EFFORT and non-fatal: a machine without git,
// without a username, or with a detached HEAD keeps deploying — the
// commit attempt reports into the transcript and configure proceeds.

import { say } from "./lines";

export interface UserBranchResult {
    ok: boolean;
    /** did a commit actually land? */
    committed: boolean;
    branch?: string;
    /** transcript lines [FLUSH-CLASS: buffered] */
    lines: string[];
}

function git(dots: string, args: string[]): { code: number; out: string } {
    const p = Bun.spawnSync(["git", "-C", dots, ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });
    return {
        code: p.exitCode ?? 1,
        out: `${p.stdout ?? ""}`.trim(),
    };
}

/** the unix username (sudo granted first: the PERSON is the operator,
 * not root) — empty when unresolvable */
export function userName(): string {
    const env = process.env.SUDO_USER || process.env.USER || "";
    if (env) return env;
    const id = Bun.spawnSync(["id", "-un"], { stdout: "pipe" });
    return `${id.stdout ?? ""}`.trim();
}

/** stage + commit the config files on the user branch. The paths are
 * the repo-relative manifest/conf set configure may have rewritten.
 * [FLUSH-CLASS: buffered] — the transcript lines ride the result; the
 * caller flushes them in order with its own output. */
export function commitUserBranch(dots: string, paths: string[]): UserBranchResult {
    const lines: string[] = [];
    const user = userName();
    if (!user) {
        return { ok: false, committed: false, lines: ["userbranch: no unix username — config left uncommitted"] };
    }
    if (git(dots, ["rev-parse", "--is-inside-work-tree"]).out !== "true") {
        return { ok: false, committed: false, lines: [`userbranch: ${dots} is not a git work tree — config left uncommitted`] };
    }
    const existing = git(dots, ["show-ref", "--verify", "--quiet", `refs/heads/${user}`]).code === 0;
    const current = git(dots, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
    if (current !== user) {
        const co = existing
            ? git(dots, ["checkout", user])
            : git(dots, ["checkout", "-b", user]);
        if (co.code !== 0) {
            // a dirty switch (branch history differs from the tree) is
            // the hand-resolve case — never fatal to the deployment
            lines.push(`userbranch: could not switch to '${user}' — resolve by hand (${co.out.split("\n")[0]})`);
            return { ok: false, committed: false, branch: user, lines };
        }
        lines.push(existing
            ? `userbranch: on '${user}'`
            : `userbranch: created branch '${user}' (from ${current})`);
    }
    const present = paths.filter((p) => git(dots, ["ls-files", "--error-unmatch", "--", p]).code === 0
        || git(dots, ["cat-file", "-e", `HEAD:${p}`]).code === 0
        || Bun.file(`${dots}/${p}`).size > 0);
    const trackable = present.length > 0 ? present : paths;
    const add = git(dots, ["add", "--sparse", "-f", "--", ...trackable]);
    if (add.code !== 0) {
        lines.push(`userbranch: staging failed — ${add.out.split("\n")[0]}`);
        return { ok: false, committed: false, branch: user, lines };
    }
    if (git(dots, ["diff", "--cached", "--quiet"]).code === 0) {
        return { ok: true, committed: false, branch: user, lines };
    }
    const ci = git(dots, [
        "commit", "-q", "-m",
        `configure: personalize (user ${user})`,
    ]);
    if (ci.code !== 0) {
        // most likely git identity unset on a fresh machine (the
        // credentials flow runs before this in the wizard); the change
        // stays staged — the next configure retries
        lines.push(`userbranch: commit FAILED (change staged) — ${ci.out.split("\n")[0]}`);
        return { ok: false, committed: false, branch: user, lines };
    }
    lines.push(`userbranch: committed config to '${user}'`);
    return { ok: true, committed: true, branch: user, lines };
}

/** report the result into the transcript — [FLUSH-CLASS: buffered]
 * lines land via say(); call where the configure output flows */
export function reportUserBranch(r: UserBranchResult): void {
    if (r.lines.length > 0) say(...r.lines);
}
