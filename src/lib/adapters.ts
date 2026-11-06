// src/lib/adapters.ts — the PACKAGE ADAPTER consultation layer.
//
// The dots package adapters (dots/<pkg>/.local/state/depends/
// <pkg>.Makefile — the "router-Makefile" of the 2026-11 scheme)
// declare what is genuinely PACKAGE-SPECIFIC, one config item per
// recipe, chained by the `metadata` target:
//
//   on-deploy consults them with `make -C dots/<pkg> -f <pkg>.Makefile
//   metadata` and reads key=value lines:
//
//     git_repo=<url>          the upstream repository (the sources)
//     pkg_name=<name>         the submodule package name; the checkout
//                             path is INFERRED as
//                             dots/build/<pkg>/<pkg_name>
//     methods_supported=<s>   the valid method set ("source" is always
//                             valid; bat keeps its release route)
//     repos_pkg=<name>        the dots package (stow) name
//     repos_pkg_name=<name>   the deployment binary name (~/.local/bin)
//
// The branching does NOT live in the adapters: the METHOD RESOLUTION
// (--method M > doftiles.conf record > source), the validity checks,
// the conf update and the ensure/force guards are COMMON. Everything
// else (the record key) is DERIVED here from repos_pkg/pkg_name. The
// adapters keep concrete step recipes (toolchain/build/link, the
// package-specific release fetch), plain sequences, no conditionals.
//
// ── extending: a new package adapter mints its metadata contract with
// the same recipes and keeps them plain; no on-deploy change needed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pkgMakefile } from "./pkgops";
import { TRANSPORTS, type PkgManagerSpec } from "./pkgmanagers";

export const DOTS = join(process.env.HOME!, "dots");

/** the doftiles method record (~/.config/doftiles.conf, stowed from the
 *  repo through the symlink; plain writes drop through the link) */
export const CONF = join(process.env.HOME!, ".config/doftiles.conf");

export interface PkgDescriptor {
    /** the dots package (stow) name — metadata repos_pkg */
    pkg: string;
    /** the doftiles.conf record key (derived: uppercase repos_pkg) */
    key: string;
    /** the upstream repository — metadata git_repo */
    repoUrl: string;
    /** the submodule package name — metadata pkg_name; the checkout
     *  path is INFERRD: dots/<pkg>/.local/share/<pkg_name> */
    pkgName: string;
    /** the inferred submodule checkout path (dots-relative) */
    subDir?: string;
    /** the package-owned artifact (derived for binary adapters;
     *  undefined for registry adapters) */
    artifact?: string;
    /** the deployment binary name — metadata repos_pkg_name */
    installName: string;
    /** the valid method set — metadata methods_supported */
    methods: string[];
    /** the repositories carrying the deployment binary (bun, apt,
     *  npm) — metadata repos_pkg; drives the pkg transport choice */
    reposPkg: string[];
    /** the raw make map, for anything packages add later */
    raw: Record<string, string>;
    /** did the adapter exist / metadata cleanly? */
    ok: boolean;
    problem?: string;
}

export function hasMakefile(pkg: string): boolean {
    return existsSync(join(DOTS, pkg, ".local", "state", "depends", `${pkg}.Makefile`));
}

// ── safe property helpers (one per descriptor field; each helper
// tolerates a sparse/skewed metadata output and applies the fallback) ──

function safeKeyName(pkg: string): string {
    return pkg.toUpperCase().replace(/-/g, "_");
}

function safeRepoUrl(raw: Record<string, string>): string {
    return raw.git_repo || "";
}

function safePkgName(raw: Record<string, string>, fallback: string): string {
    return raw.pkg_name || fallback;
}

/** the checkout path is INFERRED from pkg_name — the BUILD SLED,
 *  outside the stow packages: dots/build/<pkg>/<pkg_name> */
function safeSubDir(pkg: string, pkgName: string): string | undefined {
    return pkgName ? join("build", pkg, pkgName) : undefined;
}

/** the package-owned artifact lives at the well-known dots link path */
function safeArtifact(pkg: string, repoPkgName: string): string {
    return join(pkg, ".local", "bin", repoPkgName);
}

/** source is always valid (the contract); whatever the adapter also
 *  declares joins the set */
function safeMethodsSupported(raw: Record<string, string>): string[] {
    const list = (raw.methods_supported || "source").split(/[\s,]+/).filter(Boolean);
    const methods = list.filter((m) => m !== "source");
    return ["source", ...methods];
}

/** the repositories that carry the deployment binary (bun, apt, npm) */
function safeReposPkg(raw: Record<string, string>): string[] {
    return (raw.repos_pkg || "").split(/[\s,]+/).filter(Boolean);
}

/** metadata repos_pkg_name (positional 5) — the deployment name */
function safeReposPkgName(raw: Record<string, string>, fallback: string): string {
    return raw.repos_pkg_name || fallback;
}

/** ── semantic helpers (the queries on the DESCRIPTOR; no call site ────
    recomputes) ────────────────────────────────────────────────────────*/

/** the deploy-state label for the status report */
export function deployedState(desc: PkgDescriptor): string {
    return deployedAlready(desc) ? "installed" : "MISSING";
}

/** artifact adapters place a dots-owned binary here; registry adapters
 *  (herbstutil) never do, and their state is the transports' */
export function artifactExists(desc: PkgDescriptor): boolean {
    return desc.artifact ? existsSync(join(DOTS, desc.artifact)) : false;
}

function lookupTransportUnsafe(id: string): PkgManagerSpec | null {
    return TRANSPORTS.find((t) => t.id === id) ?? null;
}

/** is `method` among the adapter's supported methods? source is
 *  always valid (the contract); pkg additionally needs coverage */
export function methodSupported(desc: PkgDescriptor, method: string): boolean {
    if (method === "source") return true;
    const specialized = desc.methods.filter((m) => m !== "source");
    return specialized.includes(method) || (method === "pkg" && desc.reposPkg.length > 0);
}

/** is the package deployed already? (artifacts probe the dots-owned
 *  file; registry-covered packages consult their repositories) */
export function deployedAlready(desc: PkgDescriptor): boolean {
    if (artifactExists(desc)) return true;
    return desc.reposPkg
        .map((id) => lookupTransportUnsafe(id))
        .some((t) => !!t && t.installed(desc.installName));
}

export function registryTransportInstalled(id: string, name: string): boolean {
    const found = lookupTransportUnsafe(id);
    return found ? found.installed(name) : false;
}

/** consult an adapter's metadata contract: the adapter prints the FIVE
 *  contract values, one bare value per recipe line, positionally:
 *   1 git_repo           the upstream repository URL
 *   2 pkg_name           the submodule package name; the checkout path
 *                        is inferred as dots/<pkg>/.local/share/<pkg>
 *   3 methods_supported  the valid methods (source | pkg)
 *   4 repos_pkg          the repositories carrying the deployment
 *                        binary (bun, apt, npm) — drives the pkg method
 *   5 repos_pkg_name     the deployment binary name (~/.local/bin)
 *  Every descriptor property routes through a safe* helper; none of
 *  them re-derive inline in the result block. */
export function consult(pkg: string): PkgDescriptor {
    const raw: Record<string, string> = {};
    let ok = true;
    let problem: string | undefined;
    const host = pkgMakefile(pkg);
    if (!host) problem = `no adapter for ${pkg}`;
    if (problem) ok = false;

    if (ok) {
        const r = Bun.spawnSync([
            "make", "-C", host!.dir, "--no-print-directory",
            "-f", host!.file, "metadata",
        ], { stdout: "pipe", stderr: "pipe" });
        const out = `${r.stdout ?? ""}`;
        if ((r.exitCode ?? 1) !== 0) {
            ok = false;
            problem = `metadata consult failed: ${`${r.stderr ?? ""}`.trim().split("\n")[0]}`;
        } else {
            const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
            raw.git_repo = lines[0] ?? "";
            raw.pkg_name = lines[1] ?? "";
            raw.methods_supported = lines[2] ?? "";
            raw.repos_pkg = lines[3] ?? "";
            raw.repos_pkg_name = lines[4] ?? "";
        }
    }

    // the anchor DOTS package: the invocation name (doftiles) maps to
    // the HOST package through the adapter (depends)
    const anchorPkg = host?.pkg ?? pkg;
    const repoPkgName = safeReposPkgName(raw, anchorPkg);
    const pkgName = safePkgName(raw, anchorPkg);
    const subDir = safeSubDir(anchorPkg, pkgName);
    const artifact = safeArtifact(anchorPkg, repoPkgName);
    return {
        pkg: anchorPkg,
        key: safeKeyName(anchorPkg),
        repoUrl: safeRepoUrl(raw),
        pkgName,
        subDir,
        artifact,
        installName: repoPkgName,
        methods: safeMethodsSupported(raw),
        reposPkg: safeReposPkg(raw),
        raw,
        ok,
        problem,
    };
}

/* ── the source route's language probes (the adapter's lang) ─────────── */
/** dispatch table; lang values are the metadata contract's lang=<id> */
export const LANG_TOOLCHAIN: Record<string, string> = {
    [String("rust")]: "cargo",
    [String("bun")]: "bun",
};

/** is the toolchain the source route needs available? */
export function langToolchainOk(lang: string | undefined): boolean {
    if (!lang) return true;
    const bin = LANG_TOOLCHAIN[lang];
    if (!bin) return true;
    return (Bun.spawnSync(["sh", "-c", `command -v ${bin}`]).exitCode ?? 1) === 0;
}

/* ── the conf record (common; formerly per-adapter conf-get/conf-set) ── */

export function confGet(key: string): string {
    if (!existsSync(CONF)) return "";
    for (const line of readFileSync(CONF, "utf8").split("\n")) {
        if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
    }
    return "";
}

/** write ONE record (the stow symlink drops through; the tracked file
 *  in the repo gains the diff) */
export function confSet(key: string, value: string): void {    const head = existsSync(CONF)
        ? readFileSync(CONF, "utf8").split("\n")
        : [];
    const next: string[] = [];
    let seen = false;
    for (const line of head) {
        if (line.trim().startsWith("#") || !line.includes("=")) { next.push(line); continue; }
        const k = line.slice(0, line.indexOf("=")).trim();
        if (k === key) { next.push(`${key}=${value}`); seen = true; continue; }
        next.push(line);
    }
    if (!seen) next.push(`${key}=${value}`);
    while (next.length && next[next.length - 1] === "") next.pop();
    writeFileSync(CONF, next.join("\n") + "\n");
}
