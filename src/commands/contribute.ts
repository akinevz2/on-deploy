// src/commands/contribute.ts — synchronise the dots repository (and its
// configured submodules) with origin. The workflow:
//
//   1. fetch + report: the user is INFORMED of the local changes//      (uncommitted modifications), the DIVERGENCE from origin's main
//      (ahead / behind), and the submodule state
//   2. sync: local work is committed onto the CURRENT branch and
//      replayed onto the origin tip (rebase). BRANCHING IS EXCEPTIONAL:
//      a side branch (contribute/<timestamp>) is created ONLY when the
//      rebase would CONFLICT — the divergent work is moved there, the
//      branch is synced clean to origin, and the conflicts are
//      INDICATED to the user for by-hand resolution
//   3. publish: the synced branch (and ahead submodules) are pushed
//      (auto on --yes; confirmed on a tty)
//
// ALL presentation delegates to lib/commitUI.ts (the adapter module):
// readline TUI on a tty, fail-fast CLI otherwise (--yes forces the
// CLI). No park/fold staging: the repository structure stays
// branch-clean except for the exceptional conflict branches.

import { defineCommand, option } from "@bunli/core";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { checkDotsEnv, DOTS_DIR } from "../lib/dots";
import {
    die,
    input,
    note,
    pause,
    pickBackend,
    type Backend,
    choose,
    view,
    yesno,
} from "../lib/commitUI";

interface Git {
    code: number;
    out: string;
}

function git(args: string[], cwd?: string): Git {
    const r = spawnSync("git", args, { cwd: cwd ?? DOTS_DIR, encoding: "utf8" });
    return { code: r.status ?? 1, out: (r.stdout ?? "").trim() };
}

function currentBranch(repo?: string): string {
    return git(["-C", repo ?? DOTS_DIR, "symbolic-ref", "--quiet", "--short", "HEAD"]).out;
}

function treeDirty(repo: string): boolean {
    return git(["-C", repo, "status", "--porcelain", "--untracked-files=no"]).out !== "";
}

/** submodule paths: system.depends lines are '<pkg> <path>...' — the
 * on-deploy bootstrap checkout rides along (no awk — repo quirk 7) */
function submodulePaths(): string[] {
    const paths: string[] = [];
    try {
        for (const line of readFileSync(join(DOTS_DIR, "system.depends"), "utf8").split("\n")) {
            if (line.startsWith("#")) continue;
            for (const p of line.trim().split(/\s+/).slice(1)) {
                if (p !== "") paths.push(p);
            }
        }
    } catch {
        /* no manifest — the bootstrap checkout still rides along */
    }
    paths.push("on-deploy/.local/share/on-deploy");
    return paths;
}

function conflictRecipe(repo: string): never {
    note(`conflicts while syncing ${repo} — the divergent work stays on the branch`);
    note(`  1. inspect:   git -C ${repo} status`);
    note(`  2. resolve:   edit the conflicted files, then git -C ${repo} add <files>`);
    note(`  3. continue:  git -C ${repo} rebase --continue`);
    note("then re-run on-deploy contribute — nothing has been lost");
    process.exit(1);
}

/** run <desc> <args> [cwd] — announce, execute, report (exec flush
 * class: the child's output interleaves on the real terminal) */
function run(desc: string, args: string[], cwd?: string): number {
    note(desc);
    const r = spawnSync(args[0], args.slice(1), { cwd, stdio: "inherit" });
    const code = r.status ?? 1;
    if (code === 0) note(`ok: ${desc}`);
    else note(`FAILED (exit ${code}): ${desc}`);
    return code;
}

interface Divergence {
    ahead: number;
    behind: number;
}

function divergence(repo: string, branch: string): Divergence {
    const n = (spec: string) =>
        Number(git(["-C", repo, "rev-list", "--count", spec]).out || "0");
    return { ahead: n(`origin/${branch}..${branch}`), behind: n(`${branch}..origin/${branch}`) };
}

function tempFile(): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "on-deploy-contribute."));
    return { dir, path: join(dir, "report") };
}

/** inform the user: local changes + divergence + submodule state */
async function actionReport(backend: Backend): Promise<void> {
    const u = currentBranch();
    const d = divergence(DOTS_DIR, u);
    const { dir, path } = tempFile();
    const lines: string[] = [
        `branch:      ${u}  (ahead ${d.ahead} / behind ${d.behind} vs origin)`,
    ];
    if (treeDirty(DOTS_DIR)) {
        lines.push("local changes (uncommitted):");
        for (const l of git(["status", "--porcelain", "--untracked-files=no"]).out.split("\n"))
            lines.push(`  ${l}`);
    } else lines.push("local changes: none");
    lines.push("submodules:");
    for (const s of submodulePaths()) {
        const sb = currentBranch(s);
        if (sb === "") {
            lines.push(`  ${s}: detached HEAD`);
            continue;
        }
        const sd = divergence(s, sb);
        const dirty = treeDirty(s) ? " [dirty]" : "";
        lines.push(`  ${s} (${sb}): ahead ${sd.ahead} / behind ${sd.behind}${dirty}`);
    }
    spawnSync("sh", ["-c", `cat > '${path}'`], { input: lines.join("\n") + "\n" });
    await view("contribute — repository state", path);
    rmSync(dir, { force: true, recursive: true });
    await pause(backend);
}

/** commit the uncommitted work onto the current branch (no staging
 * branches — the work belongs to the branch it was made on) */
async function actionCommit(backend: Backend, repo: string): Promise<number> {
    if (!treeDirty(repo)) {
        note(`${repo}: nothing to commit`);
        await pause(backend);
        return 0;
    }
    git(["-C", repo, "add", "-A"]);
    if (repo === DOTS_DIR) {
        const deps = spawnSync("sh", ["-c", "ls *.depends 2>/dev/null"], {
            cwd: repo,
            encoding: "utf8",
        }).stdout?.split("\n").filter(Boolean) ?? [];
        if (deps.length > 0) git(["add", "-f", ...deps]);
    }
    const m = await input(backend, `commit message (${repo})`, "on-deploy contribute: local changes");
    return run(`commit local changes (${repo})`, ["git", "-C", repo, "commit", "-m", m]);
}

/** sync <repo>: replay the local commits onto the origin tip. Branching
 * is exceptional: a conflict aborts the rebase and moves the divergent
 * work to contribute/<ts> so the branch syncs clean to origin. */
function actionSync(repo: string, u: string): number {
    if (git(["-C", repo, "rebase", `origin/${u}`]).code !== 0) {
        // conflicts: park the replay by aborting and branching
        git(["-C", repo, "rebase", "--abort"]);
        const side = `contribute/${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
        if (git(["-C", repo, "branch", side, "HEAD"]).code !== 0)
            conflictRecipe(repo);
        // the branch itself syncs clean to origin (the divergent work
        // rides the side branch for by-hand resolution)
        if (git(["-C", repo, "checkout", "-q", side]).code !== 0) conflictRecipe(repo);
        if (git(["-C", repo, "rebase", `origin/${u}`]).code !== 0) conflictRecipe(repo);
        git(["-C", repo, "checkout", "-q", u]);
        git(["-C", repo, "reset", "-q", "--hard", `origin/${u}`]);
        note(`${repo}: divergent work branched to '${side}' — resolve its conflicts there`);
        return 1;
    }
    return 0;
}

async function actionPublish(backend: Backend, repo: string, u: string, ahead: number): Promise<number> {
    if (ahead <= 0) return 0;
    if (backend === "readline" &&
        !(await yesno(backend, `push ${repo} (${u}, ${ahead} commit(s)) to origin?`))) {
        note(`skipped push of ${repo}`);
        return 0;
    }
    return run(`push ${repo} (${u}, ${ahead} commit(s))`, ["git", "-C", repo, "push", "origin", u], repo);
}

export default defineCommand({
    name: "contribute",
    description: "Synchronise the dots repository + submodules with origin",
    options: {
        yes: option(z.boolean().optional(), {
            argumentKind: "flag" as const,
            description: "non-interactive fail-fast flow (no menus)",
            short: "y",
        }),
        report: option(z.boolean().optional(), {
            argumentKind: "flag" as const,
            description: "show the state report only, change nothing",
            short: "r",
        }),
    },
    handler: async ({ flags }) => {
        const env = checkDotsEnv();
        if (!env.ok) die(env.problem ?? "not inside the dots repository");
        const backend = pickBackend(!!flags.yes);

        if (flags.report) {
            git(["fetch", "origin", "--prune"]);
            await actionReport(backend);
            process.exit(0);
        }

        // 1+2. dots: fetch, inform, commit, sync (branch only on conflict)
        git(["fetch", "origin", "--prune"]);
        await actionReport(backend);
        const u = currentBranch();
        if (u === "") die("detached HEAD — checkout a branch first");
        if (backend === "readline") {
            await actionCommit(backend, DOTS_DIR);
        } else if ((await actionCommit(backend, DOTS_DIR)) !== 0) {
            process.exit(1);
        }
        const before = divergence(DOTS_DIR, u);
        if (before.behind > 0 && actionSync(DOTS_DIR, u) !== 0) process.exit(1);
        const after = divergence(DOTS_DIR, u);
        if ((await actionPublish(backend, DOTS_DIR, u, after.ahead)) !== 0) process.exit(1);

        // 3. submodules: the same inform/commit/sync/publish dance
        for (const s of submodulePaths()) {
            const sb = currentBranch(s);
            if (sb === "") {
                note(`${s}: detached HEAD — skipped (checkout a branch to contribute)`);
                continue;
            }
            const sd = divergence(s, sb);
            if (treeDirty(s)) {
                if (backend === "readline") await actionCommit(backend, s);
                else if ((await actionCommit(backend, s)) !== 0) process.exit(1);
            }
            const now = divergence(s, sb);
            if (now.behind > 0 && actionSync(s, sb) !== 0) process.exit(1);
            const pub = divergence(s, sb);
            if ((await actionPublish(backend, s, sb, pub.ahead)) !== 0) process.exit(1);
            if (sd.ahead === 0 && sd.behind === 0 && !treeDirty(s))
                note(`${s}: in sync with origin`);
        }
        note("done — the repository is synchronised with origin");
        process.exit(0);
    },
});
