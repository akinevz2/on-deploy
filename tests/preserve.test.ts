// tests/preserve.test.ts — the preserve mechanics (pure functions over
// tmpdirs and temp git repos; no WM, no package manager, no real stow
// except the guarded integration test below).

import { describe, expect, test } from "bun:test";
import {
    mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync,
    existsSync, realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    scanConflicts, copyToStore, removeConflicts, restoreFromStore,
    snapshotAdopted, storeDir, gitClean, writePreserveManifest,
    type Conflict,
} from "../src/lib/preserve";

const USER_BYTES = "user pre-existing config\n";
const DOTS_BYTES = "dots distributed config\n";

/** Build a fake dots checkout (one package `dummy` with .config/app.cfg)
 *  and a fake $HOME containing a conflicting user file at the same rel. */
function fixture(userBytes: string = USER_BYTES) {
    const root = mkdtempSync(join(tmpdir(), "preserve-test-"));
    const dots = join(root, "dots");
    const home = join(root, "home");
    mkdirSync(join(dots, "dummy", ".config"), { recursive: true });
    writeFileSync(join(dots, "dummy", ".config", "app.cfg"), DOTS_BYTES);
    mkdirSync(join(home, ".config"), { recursive: true });
    writeFileSync(join(home, ".config", "app.cfg"), userBytes);
    return { root, dots, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function initGit(dir: string) {
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
    Bun.spawnSync(["git", "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
}

describe("scanConflicts", () => {
    test("dots-owned path is skipped; absent paths skipped", () => {
        const f = fixture();
        try {
            // make the $HOME file dots-owned (symlink into the repo)
            rmSync(join(f.home, ".config", "app.cfg"));
            symlinkSync(join(f.dots, "dummy", ".config", "app.cfg"), join(f.home, ".config", "app.cfg"));
            expect(scanConflicts(f.dots, f.home, "dummy")).toEqual({ conflicts: [], hard: [] });
        } finally { f.cleanup(); }
    });

    test("real user file is a conflict", () => {
        const f = fixture();
        try {
            const scan = scanConflicts(f.dots, f.home, "dummy");
            expect(scan.hard).toEqual([]);
            expect(scan.conflicts).toHaveLength(1);
            expect(scan.conflicts[0]).toMatchObject({ rel: ".config/app.cfg", kind: "file" });
        } finally { f.cleanup(); }
    });

    test("no $HOME file -> no conflict", () => {
        const f = fixture();
        try {
            rmSync(join(f.home, ".config", "app.cfg"));
            expect(scanConflicts(f.dots, f.home, "dummy").conflicts).toEqual([]);
        } finally { f.cleanup(); }
    });

    test("directory where the package has a file -> hard conflict", () => {
        const f = fixture();
        try {
            rmSync(join(f.home, ".config", "app.cfg"));
            mkdirSync(join(f.home, ".config", "app.cfg"));
            const scan = scanConflicts(f.dots, f.home, "dummy");
            expect(scan.hard).toHaveLength(1);
            expect(scan.hard[0].kind).toBe("directory");
            expect(scan.conflicts).toEqual([]);
        } finally { f.cleanup(); }
    });

    test("symlink to a regular file -> conflict with linkTarget", () => {
        const root = mkdtempSync(join(tmpdir(), "preserve-test-"));
        const dots = join(root, "dots");
        const home = join(root, "home");
        mkdirSync(join(dots, "dummy", ".config"), { recursive: true });
        writeFileSync(join(dots, "dummy", ".config", "app.cfg"), DOTS_BYTES);
        const realTarget = join(root, "real.txt");
        writeFileSync(realTarget, USER_BYTES);
        mkdirSync(join(home, ".config"), { recursive: true });
        symlinkSync(realTarget, join(home, ".config", "app.cfg"));
        try {
            const scan = scanConflicts(dots, home, "dummy");
            expect(scan.hard).toEqual([]);
            expect(scan.conflicts).toHaveLength(1);
            expect(scan.conflicts[0].kind).toBe("symlink");
            expect(scan.conflicts[0].linkTarget).toBe(realTarget);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test("dangling symlink -> manifest-only entry, kind symlink-dangling", () => {
        const root = mkdtempSync(join(tmpdir(), "preserve-test-"));
        const dots = join(root, "dots");
        const home = join(root, "home");
        mkdirSync(join(dots, "dummy", ".config"), { recursive: true });
        writeFileSync(join(dots, "dummy", ".config", "app.cfg"), DOTS_BYTES);
        mkdirSync(join(home, ".config"), { recursive: true });
        symlinkSync(join(root, "does-not-exist"), join(home, ".config", "app.cfg"));
        try {
            const scan = scanConflicts(dots, home, "dummy");
            expect(scan.conflicts).toHaveLength(1);
            expect(scan.conflicts[0].kind).toBe("symlink-dangling");
            // copyToStore must skip it without throwing
            const store = storeDir(home, "dummy");
            const copied = copyToStore(store, scan.conflicts);
            expect(copied).toEqual([]);
            expect(existsSync(join(store, ".config", "app.cfg"))).toBe(false);
            removeConflicts(scan.conflicts); // removes the dangling link, no throw
            expect(existsSync(join(home, ".config", "app.cfg"))).toBe(false);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test("packageFiles skips .stow-local-ignore (regression)", () => {
        const f = fixture();
        try {
            writeFileSync(join(f.dots, "dummy", ".stow-local-ignore"), "nothing/.*\n");
            writeFileSync(join(f.home, ".stow-local-ignore"), USER_BYTES);
            const scan = scanConflicts(f.dots, f.home, "dummy");
            expect(scan.conflicts.map((c: Conflict) => c.rel)).not.toContain(".stow-local-ignore");
        } finally { f.cleanup(); }
    });
});

describe("store round-trip", () => {
    test("copy -> remove -> restore is byte-identical", () => {
        const f = fixture();
        try {
            const store = storeDir(f.home, "dummy");
            const scan = scanConflicts(f.dots, f.home, "dummy");
            expect(scan.conflicts).toHaveLength(1);
            const copied = copyToStore(store, scan.conflicts);
            expect(copied).toHaveLength(1);
            expect(readFileSync(join(store, ".config", "app.cfg"), "utf8")).toBe(USER_BYTES);
            removeConflicts(scan.conflicts);
            expect(existsSync(join(f.home, ".config", "app.cfg"))).toBe(false);
            // restore into the PACKAGE TREE: dots file now user bytes
            const restored = restoreFromStore(f.dots, "dummy", store);
            expect(restored).toEqual([".config/app.cfg"]);
            expect(readFileSync(join(f.dots, "dummy", ".config", "app.cfg"), "utf8")).toBe(USER_BYTES);
        } finally { f.cleanup(); }
    });

    test("store lives OUTSIDE the dots checkout", () => {
        const f = fixture();
        try {
            const store = storeDir(f.home, "dummy");
            // the store is under $HOME, while the fake repo is NOT
            expect(store.startsWith(join(f.home, ".local"))).toBe(true);
            expect(store).toContain(join(".local", "state", "doftiles", "preserve"));
        } finally { f.cleanup(); }
    });

    test("manifest is written with rel/kind/bytes", () => {
        const f = fixture();
        try {
            const store = storeDir(f.home, "dummy");
            const scan = scanConflicts(f.dots, f.home, "dummy");
            writePreserveManifest(store, "dummy", "default", scan.conflicts);
            const m = JSON.parse(readFileSync(join(store, "PRESERVE.json"), "utf8"));
            expect(m.pkg).toBe("dummy");
            expect(m.mode).toBe("default");
            expect(m.conflicts).toHaveLength(1);
            expect(m.conflicts[0].rel).toBe(".config/app.cfg");
            expect(m.conflicts[0].kind).toBe("file");
            expect(m.conflicts[0].bytes).toBe(USER_BYTES.length);
        } finally { f.cleanup(); }
    });

    test("snapshotAdopted copies the adopted tree content into the store", () => {
        const f = fixture();
        try {
            const store = storeDir(f.home, "dummy");
            // simulate --adopt: BOTH the live file (via symlink flip — the
            // dots file content is replaced by the user content)
            writeFileSync(join(f.dots, "dummy", ".config", "app.cfg"), USER_BYTES);
            const conflicts: Conflict[] = [{ rel: ".config/app.cfg", kind: "file", homePath: join(f.home, ".config", "app.cfg") }];
            snapshotAdopted(store, join(f.dots, "dummy"), conflicts);
            expect(readFileSync(join(store, ".config", "app.cfg"), "utf8")).toBe(USER_BYTES);
        } finally { f.cleanup(); }
    });

    test("restoreFromStore on empty store is a no-op", () => {
        const f = fixture();
        try {
            expect(restoreFromStore(f.dots, "dummy", join(f.home, ".local", "state", "doftiles", "preserve", "dummy"))).toEqual([]);
            expect(readFileSync(join(f.dots, "dummy", ".config", "app.cfg"), "utf8")).toBe(DOTS_BYTES);
        } finally { f.cleanup(); }
    });

    test("nested relpaths are mirrored in the store", () => {
        const root = mkdtempSync(join(tmpdir(), "preserve-test-"));
        const dots = join(root, "dots");
        const home = join(root, "home");
        mkdirSync(join(dots, "dummy", ".config", "app", "sub"), { recursive: true });
        writeFileSync(join(dots, "dummy", ".config", "app", "sub", "f.cfg"), DOTS_BYTES);
        mkdirSync(join(home, ".config", "app", "sub"), { recursive: true });
        writeFileSync(join(home, ".config", "app", "sub", "f.cfg"), USER_BYTES);
        try {
            const store = storeDir(home, "dummy");
            const scan = scanConflicts(dots, home, "dummy");
            expect(scan.conflicts).toHaveLength(1);
            copyToStore(store, scan.conflicts);
            expect(readFileSync(join(store, ".config", "app", "sub", "f.cfg"), "utf8")).toBe(USER_BYTES);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});

describe("gitClean", () => {
    test("clean repo -> true; modified tracked file -> false; untracked -> still true", () => {
        const f = fixture();
        try {
            initGit(f.dots);
            expect(gitClean(f.dots, "dummy")).toBe(true);
            // untracked file inside the package: still clean (diff-only)
            writeFileSync(join(f.dots, "dummy", "untracked.txt"), "x");
            expect(gitClean(f.dots, "dummy")).toBe(true);
            // modify the tracked file
            writeFileSync(join(f.dots, "dummy", ".config", "app.cfg"), USER_BYTES);
            expect(gitClean(f.dots, "dummy")).toBe(false);
        } finally { f.cleanup(); }
    });
});

// --- integration: real stow when available -------------------------------
describe("stow integration (real stow, guarded)", () => {
    const hasStow = (Bun.spawnSync(["sh", "-c", "command -v stow"]).exitCode ?? 1) === 0;
    test.skipIf(!hasStow)("default flow: deployed == dots bytes, store holds user bytes", async () => {
        const { preservePackage } = await import("../src/lib/preserve");
        const f = fixture();
        try {
            // dots-owned absent: stow proceeds against the fake home
            const r = await preservePackage(
                "dummy",
                { dryRun: false, yes: true, keep: true, restore: false, adopt: false },
                {
                    stow: (pkg, _adopt) => {
                        const p = Bun.spawnSync(["stow", "-R", "-t", f.home, pkg], { cwd: f.dots, stdout: "pipe", stderr: "pipe" });
                        return { ok: (p.exitCode ?? 1) === 0, lines: [`${p.stdout ?? ""}${p.stderr ?? ""}`.trim()].filter(Boolean) as string[] };
                    },
                },
                f.dots,
                f.home,
            );
            expect(r.status).toBe("ok");
            // deployed through the symlink == dots bytes
            expect(readFileSync(join(f.home, ".config", "app.cfg"), "utf8")).toBe(DOTS_BYTES);
            // realpath resolves into the fake dots checkout
            expect(realpathSync(join(f.home, ".config", "app.cfg"))).toContain(join("dots", "dummy"));
            // store holds the user's original bytes
            expect(readFileSync(join(storeDir(f.home, "dummy"), ".config", "app.cfg"), "utf8")).toBe(USER_BYTES);
        } finally { f.cleanup(); }
    });

    test.skipIf(!hasStow)("--dry-run writes nothing anywhere", async () => {
        const { preservePackage } = await import("../src/lib/preserve");
        const f = fixture();
        try {
            const homeCfgBefore = readFileSync(join(f.home, ".config", "app.cfg"), "utf8");
            const r = await preservePackage(
                "dummy",
                { dryRun: true, yes: true, keep: false, restore: false, adopt: false },
                {},
                f.dots,
                f.home,
            );
            expect(r.status).toBe("dry-run");
            expect(readFileSync(join(f.home, ".config", "app.cfg"), "utf8")).toBe(homeCfgBefore);
            expect(existsSync(join(f.home, ".local", "state", "doftiles", "preserve"))).toBe(false);
            expect(r.lines.join("\n")).toContain("[dry-run] stow");
        } finally { f.cleanup(); }
    });
});

describe("mixed per-file decisions", () => {
    const mixedFixture = () => {
        const f = fixture();
        // a second conflicting file, so one pkg has two decisions
        writeFileSync(join(f.dots, "dummy", ".config", "other.cfg"), DOTS_BYTES);
        writeFileSync(join(f.home, ".config", "other.cfg"), USER_BYTES);
        initGit(f.dots);
        return f;
    };

    const mkc = (rel: string, home: string): Conflict => ({
        rel, kind: "file", homePath: join(home, rel), bytes: USER_BYTES.length,
    });

    test("dots-wins: archived + removed; mine-wins: copied into the package tree", async () => {
        const { preservePackage } = await import("../src/lib/preserve");
        const f = mixedFixture();
        try {
            const r = await preservePackage(
                "dummy",
                {
                    dryRun: false, yes: true, keep: true, restore: false, adopt: false,
                    dotsWins: [mkc(".config/app.cfg", f.home)],
                    mineWins: [mkc(".config/other.cfg", f.home)],
                },
                {
                    stow: (pkg) => ({ ok: true, lines: [`[stub] stow ${pkg}`] }),
                },
                f.dots,
                f.home,
            );
            expect(r.status).toBe("ok");
            const body = r.lines.join("\n");
            // the dots-wins file: user bytes archived, dots version left for stow
            expect(readFileSync(join(storeDir(f.home, "dummy"), ".config", "app.cfg"), "utf8")).toBe(USER_BYTES);
            expect(existsSync(join(f.home, ".config", "app.cfg"))).toBe(false);
            // the mine-wins file: the PACKAGE TREE now holds the user's bytes
            expect(readFileSync(join(f.dots, "dummy", ".config", "other.cfg"), "utf8")).toBe(USER_BYTES);
            // the manifest records both decisions, mode=mixed
            const man = JSON.parse(readFileSync(join(storeDir(f.home, "dummy"), "PRESERVE.json"), "utf8"));
            expect(man.mode).toBe("mixed");
            const byRel = Object.fromEntries(man.decisions.map((d: { rel: string; decision: string }) => [d.rel, d.decision]));
            expect(byRel[".config/app.cfg"]).toBe("dots");
            expect(byRel[".config/other.cfg"]).toBe("mine");
            expect(body).toContain("ADOPTED");
        } finally { f.cleanup(); }
    });
});
