// src/lib/pkgops.ts — package-group operations shared by the TUI verbs
// (stow/unstow/enable/disable/packages). Output discipline: every
// operation CAPTURES its per-package output and returns it; callers
// print the blocks sequentially AFTER the TUI closes. The TUI layer
// itself lives in lib/tui.ts (bunli-native prompts, no whiptail).


import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DOTS = join(process.env.HOME!, "dots");
export const STOW_STATE = join(process.env.HOME!, ".local/state/doftiles/stowed");

/** stow packages = top-level dirs with .config or .local content */
export function stowPackages(): string[] {
    const out: string[] = [];
    for (const e of readdirSync(DOTS, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith(".") || e.name === "defaults") continue;
        if (e.name.startsWith("system-")) continue;
        if (existsSync(join(DOTS, e.name, ".config")) || existsSync(join(DOTS, e.name, ".local"))) {
            out.push(e.name);
        }
    }
    return out.sort();
}

/**
 * the per-package dependency Makefile, at the 2026-11 depends scheme:
 *	dots/<pkg>/.local/state/depends/<pkg>.Makefile	(the stow package
 *     hosts its submodules' build/link/install recipes; run with -f)
 * or, as a fallback for packages NOT yet migrated (e.g. polybar's
 * bar-control Makefile), the legacy hook directory:
 *	dots/<pkg>/.local/share/<pkg>/Makefile
 * Returns { dir, file } where dir is the `make -C` cwd and file the
 * repo-relative makefile to run.
 */
export function pkgMakefile(pkg: string): { dir: string; file: string } | null {
    const dir = join(DOTS, pkg);
    const stateFile = join(dir, ".local", "state", "depends", `${pkg}.Makefile`);
    if (existsSync(stateFile)) {
        return { dir, file: join(".local", "state", "depends", `${pkg}.Makefile`) };
    }
    const shareDir = join(dir, ".local", "share", pkg);
    if (existsSync(join(shareDir, "Makefile"))) {
        return { dir: shareDir, file: "Makefile" };
    }
    return null;
}

export function hasMakefile(pkg: string): boolean {
    return pkgMakefile(pkg) !== null;
}

/** the depends-scheme Makefile of a package (the per-submodule
 *  sync/build/link/install recipes on-deploy `depends` drives) —
 * dots/<pkg>/.local/state/depends/<pkg>.Makefile, or null */
export function depsMakefile(pkg: string): string | null {
    const file = join(DOTS, pkg, ".local", "state", "depends", `${pkg}.Makefile`);
    return existsSync(file) ? file : null;
}

/** every package that ships the depends-scheme Makefile */
export function packagesWithDepsMakefiles(): string[] {
    const out: string[] = [];
    for (const e of readdirSync(DOTS, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        if (depsMakefile(e.name)) out.push(e.name);
    }
    return out.sort();
}

/** submodule paths mapped to the stow package that owns each
 * (duplicated across packages). CONFIGURED SOURCE: the system.required
 *  manifest — each non-comment line is `<pkg> <path> <path>...`.
 * FALLBACK: .gitmodules walk (grouped by first path segment) when the
 * manifest is missing or empty — keeps bare checkouts usable. */
export function submodulesByPackage(): Record<string, string[]> {
    const manifest = join(DOTS, "system.required");
    if (existsSync(manifest)) {
        const out: Record<string, string[]> = {};
        for (const line of readFileSync(manifest, "utf8").split("\n")) {
            const l = line.trim();
            if (!l || l.startsWith("#")) continue;
            const fields = l.split(/\s+/).filter(Boolean);
            if (fields.length < 2) continue;
            (out[fields[0]] ??= []).push(...fields.slice(1));
        }
        if (Object.keys(out).length > 0) return out;
    }
    const gitmodules = join(DOTS, ".gitmodules");
    if (!existsSync(gitmodules)) return {};
    const out: Record<string, string[]> = {};
    for (const line of readFileSync(gitmodules, "utf8").split("\n")) {
        const m = /^[\t ]*path = (.+)$/.exec(line.trim());
        if (!m) continue;
        const pkg = m[1].split("/")[0];
        (out[pkg] ??= []).push(m[1]);
    }
    return out;
}

export interface PkgResult {
    pkg: string;
    ok: boolean;
    lines: string[];
}

/** the legacy regular-file swap: a REGULAR file at ~/.local/bin/<name>
 *  is removed so the package's stow link can land — every adapter used
 * to carry this per package; it is the COMMON redeploy step now */
export function swapArtifact(name: string): PkgResult {
    const p = join(process.env.HOME!, ".local", "bin", name);
    if (existsSync(p)) {
        try {
            if (lstatSync(p).isSymbolicLink()) return { pkg: name, ok: true, lines: [] };
            unlinkSync(p);
            return { pkg: name, ok: true, lines: [`${name}: REGULAR file at the deploy point — swapped for the package link`] };
        } catch (e) {
            return { pkg: name, ok: false, lines: [`${name}: swap failed (${e})`] };
        }
    }
    return { pkg: name, ok: true, lines: [] };
}

/** stow -R -t $HOME <pkg>; records the remembered set */
export function stowPkg(pkg: string): PkgResult {
    const p = Bun.spawnSync(["stow", "-R", "-t", process.env.HOME!, pkg], {
        cwd: DOTS, stdout: "pipe", stderr: "pipe",
    });
    const lines = [`${p.stdout ?? ""}`.trim(), `${p.stderr ?? ""}`.trim()].filter(Boolean);
    if ((p.exitCode ?? 1) === 0) {
        try {
            const cur = existsSync(STOW_STATE)
                ? readFileSync(STOW_STATE, "utf8").split("\n").filter(Boolean)
                : [];
            if (!cur.includes(pkg)) cur.push(pkg);
            mkdirSync(dirname(STOW_STATE), { recursive: true });
            writeFileSync(STOW_STATE, cur.sort().join("\n") + "\n");
        } catch { /* state is best-effort */ }
    }
    return { pkg, ok: (p.exitCode ?? 1) === 0, lines };
}

/** stow -D -t $HOME <pkg>; drops the remembered entry */
export function unstowPkg(pkg: string): PkgResult {
    const p = Bun.spawnSync(["stow", "-D", "-t", process.env.HOME!, pkg], {
        cwd: DOTS, stdout: "pipe", stderr: "pipe",
    });
    const lines = [`${p.stdout ?? ""}`.trim(), `${p.stderr ?? ""}`.trim()].filter(Boolean);
    if ((p.exitCode ?? 1) === 0 && existsSync(STOW_STATE)) {
        try {
            const cur = readFileSync(STOW_STATE, "utf8").split("\n").filter((l) => l && l !== pkg);
            writeFileSync(STOW_STATE, cur.sort().join("\n") + "\n");
        } catch { /* state is best-effort */ }
    }
    return { pkg, ok: (p.exitCode ?? 1) === 0, lines };
}

/** the user units a package ships (dots/<pkg>/.config/systemd/user/) */
export function pkgUnits(pkg: string): string[] {
    const dir = join(DOTS, pkg, ".config", "systemd", "user");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".service")).sort();
}

/** enable/disable the package's stowed user units (generic fallback
 * for packages WITHOUT a Makefile; Makefile packages use their own
 * enable/disable rules instead) */
export function unitsOp(pkg: string, op: "enable" | "disable"): PkgResult {
    const lines: string[] = [];
    let ok = true;
    Bun.spawnSync(["systemctl", "--user", "daemon-reload"]);
    for (const unit of pkgUnits(pkg)) {
        const r = Bun.spawnSync(["systemctl", "--user", op, unit]);
        const uok = (r.exitCode ?? 1) === 0;
        ok = ok && uok;
        lines.push(`${unit} ${uok ? `${op}d` : `${op} FAILED`}`);
    }
    if (lines.length === 0) lines.push("no user units");
    return { pkg, ok, lines };
}

/** run a Makefile rule of one package, output CAPTURED. The Makefile
 * is resolved by pkgMakefile (depends scheme -f, else the legacy
 * hook directory). */
export function runRule(pkg: string, rule: string): PkgResult {
    const mf = pkgMakefile(pkg);
    if (!mf) return { pkg, ok: false, lines: ["no Makefile"] };
    const p = Bun.spawnSync(
        ["make", "-C", mf.dir, "--no-print-directory", "-f", mf.file, rule],
        { cwd: DOTS, stdout: "pipe", stderr: "pipe" },
    );
    const lines = [
        ...`${p.stdout ?? ""}`.trim().split("\n").filter(Boolean),
        ...`${p.stderr ?? ""}`.trim().split("\n").filter(Boolean),
    ];
    return { pkg, ok: (p.exitCode ?? 1) === 0, lines };
}

/** neat sequential printing of the captured results */
export function printResults(results: PkgResult[]): void {
    for (const r of results) {
        console.log(`==${r.pkg} ${r.ok ? "SUCCESS" : "FAILURE"}`);
        for (const l of r.lines) console.log(`  ${l}`);
    }
}

// the per-package make runs are piped (nothing shows until the rule
// exits) — a long compile looks like a hang. The spinner prints ONE
// line on a non-tty (headless flows), a ticking label on a tty; it
// stops with the result. Per step; no state kept.
const SPIN_FRAMES = ["|", "/", "-", "\\"];
export function spinner(label: string): (meta: string) => void {
    const err = process.stderr;
    if (!err.isTTY) { err.write(`${label} ...\n`); return () => {}; }
    let i = 0;
    const tick = () => err.write(`\r${label} ${SPIN_FRAMES[i++ % SPIN_FRAMES.length]}`);
    tick();
    const t = setInterval(tick, 250);
    return (meta: string) => { clearInterval(t); err.write(`\r${label} ${meta}\n`); };
}

/** ONE package Makefile run, async so the spinner can tick the
 * blocking step; the raw spawnSync twin (runRule/runDeps twin) rides
 * the same text capture. */
export async function runMakeSpun(
    dir: string, file: string, makeVars: string[], rule: string,
    label: string,
): Promise<{ ok: boolean; lines: string[] }> {
    const stop = spinner(label);
    const proc = Bun.spawn(
        ["make", "-C", dir, "--no-print-directory", "-f", file, ...makeVars, rule],
        { cwd: dir, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    const [out, errText] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    const ok = code === 0;
    stop(ok ? "ok" : `FAILED (${code})`);
    const lines = [
        ...out.trim().split("\n").filter(Boolean),
        ...errText.trim().split("\n").filter(Boolean),
    ];
    return { ok, lines };
}

/** packages that ship a dependency Makefile (the depends scheme
 * preferred, the legacy hook directory as fallback) */
export function packagesWithMakefiles(): string[] {
    const out: string[] = [];
    for (const e of readdirSync(DOTS, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        if (hasMakefile(e.name)) out.push(e.name);
    }
    return out.sort();
}
