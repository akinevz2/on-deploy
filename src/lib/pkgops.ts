// src/lib/pkgops.ts — package-group operations shared by the TUI verbs
// (stow/unstow/enable/disable/packages). Output discipline: every
// operation CAPTURES its per-package output and returns it; callers
// print the blocks sequentially AFTER the TUI closes, so whiptail
// never fights with make output.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function hasMakefile(pkg: string): boolean {
    return existsSync(join(DOTS, pkg, ".local", "share", pkg, "Makefile"));
}

export interface PkgResult {
    pkg: string;
    ok: boolean;
    lines: string[];
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
 *  for packages WITHOUT a Makefile; Makefile packages use their own
 *  enable/disable rules instead) */
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

/** run a Makefile rule of one package, output CAPTURED */
export function runRule(pkg: string, rule: string): PkgResult {
    const dir = join(DOTS, pkg, ".local", "share", pkg);
    const p = Bun.spawnSync(["make", "-C", dir, "--no-print-directory", rule], {
        cwd: DOTS, stdout: "pipe", stderr: "pipe",
    });
    const lines = [
        ...`${p.stdout ?? ""}`.trim().split("\n").filter(Boolean),
        ...`${p.stderr ?? ""}`.trim().split("\n").filter(Boolean),
    ];
    return { pkg, ok: (p.exitCode ?? 1) === 0, lines };
}

/** neat sequential printing of the captured results */
export function printResults(results: PkgResult[]): void {
    for (const r of results) {
        console.log(`== ${r.pkg}${r.ok ? "" : " (FAILED)"}`);
        for (const l of r.lines) console.log(`  ${l}`);
    }
}

/** whiptail (newt) can exit with the terminal still in raw/no-echo
 *  mode — any later prompt then hangs (Enter sends \r, no \n ever
 *  arrives). Restore sane modes after EVERY whiptail call. */
function sttySane(): void {
    Bun.spawnSync(["stty", "sane"], {
        stdin: "inherit", stdout: "ignore", stderr: "ignore",
    });
}

/** whiptail checklist -> selected tags (null = cancelled) */
export function whiptailChecklist(
    title: string, prompt: string, items: string[], preselect: string[] = [],
): string[] | null {
    if (items.length === 0) return [];
    const p = Bun.spawnSync([
        "whiptail", "--title", title, "--separate-output",
        "--checklist", prompt, "20", "60", "12",
        ...items.flatMap((i) => [i, "", preselect.includes(i) ? "on" : "off"]),
    ], { stdout: "pipe", stderr: "inherit", stdin: "inherit" });
    sttySane();
    if ((p.exitCode ?? 1) !== 0) return null;
    return `${p.stdout ?? ""}`.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** whiptail yes/no (false on cancel) */
export function whiptailYesNo(title: string, prompt: string): boolean {
    const p = Bun.spawnSync(
        ["whiptail", "--title", title, "--yesno", prompt, "12", "60"],
        { stdout: "ignore", stderr: "inherit", stdin: "inherit" },
    );
    sttySane();
    return (p.exitCode ?? 1) === 0;
}
/** whiptail menu -> single tag (null = cancelled) */
export function whiptailMenu(title: string, prompt: string, items: string[]): string | null {
    if (items.length === 0) return null;
    const p = Bun.spawnSync([
        "whiptail", "--title", title, "--menu", prompt, "20", "60", "12",
        ...items.flatMap((i) => [i, ""]),
    ], { stdout: "pipe", stderr: "inherit", stdin: "inherit" });
    sttySane();
    if ((p.exitCode ?? 1) !== 0) return null;
    return `${p.stdout ?? ""}`.trim();
}

/** packages that ship a dependency Makefile (dots/<pkg>/.local/share/<pkg>/Makefile) */
export function packagesWithMakefiles(): string[] {
    const out: string[] = [];
    for (const e of readdirSync(DOTS, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        if (existsSync(join(DOTS, e.name, ".local", "share", e.name, "Makefile"))) {
            out.push(e.name);
        }
    }
    return out.sort();
}
