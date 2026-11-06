// src/lib/pkgmanagers.ts — the generic transport registry.
//
// The doftiles method knobs have two methods per package:
//   source          deploy from the git submodule checkout (the
//                   package's adapter owns all local work)
//   pkg             deploy through a package manager: the adapter's
//                   metadata repos_pkg coverage names the repositories
//                   carrying the package (bun, apt, npm) and the
//                   router picks the first AVAILABLE one — registry
//                   transports before the deploy target's system
//                   package manager
//
// A transport <id> is a concrete PACKAGE MANAGER implementation (apt,
// pacman, npm, bun...). The knob's record values are source | pkg only;
// the registry below decides the concrete invocation:>
//
//   1. implement PkgManagerSpec below (id, available, installed, run)
//      — `run` performs ONLY the package-manager invocation for the
//      names it is GIVEN; it never invents names. A binary NAME that
//      maps to a different installed package name goes through the
//      <target>.deploy protocol (resolvePackage in deployScript.ts)
//      BEFORE run — the spec gets the final, resolvable name.
//   2. append the instance to the TRANSPORTS array (the only registration
//      point; the managed verb, the knob validation and `managed list`
//      are all generated from this array).
//   3. nothing else.
//
// Contract notes:
//   - specs are side-effect free until run() fires (available/installed
//     may run arbitrary read-only probes).
//   - available() is a fast command-presence check; the managed verb
//     fail-fasts with the spec's `missing` note when it fails.
//   - run() returns the process exit code; dry-run must print and return 0.
//   - interactive confirmations belong to the caller (the managed verb
//     carries the --yes / tty gate); specs run sudo the way provisioners
//     .ts does when they need it.
//   - no spec ever hardcodes a dots package name: names come from the
//     caller exactly like the pkg verb.

import { targetPkg, targetPkgInstalled } from "./provisioners";
import { resolvePackage } from "./deployScript";

/** ── supported enumeration ──────────────────────────────────────────────
 *  ONE typed catalog for everything the managed layer knows about.
 *  Extending support = adding to these catalogs AND implementing the
 *  PkgManagerSpec in the registry (nothing else changes; `on-deploy
 *  supports` prints the result of this same catalog). */

export const PKG_MANAGER_ID = {
    apt: "apt",
    pacman: "pacman",
} as const;
/** the concrete platform package-manager programs */
export type PkgManagerId = keyof typeof PKG_MANAGER_ID;

/** deploy target families (deployScript/targets implement them as the
 *  `<target>.deploy` protocol; the family decides which system transport
 *  is usable) */
export const TARGET_FAMILY = {
    debian: "debian",
    ubuntu: "ubuntu",
    arch: "arch",
    manjaro: "manjaro",
} as const;
export type TargetFamily = keyof typeof TARGET_FAMILY;

/** the JS registry transports (transport ids live in the same namespace
 *  as the package-manager ids — the knob value is managed:<id> either way) */
export const REGISTRY_ID = {
    bun: "bun",
    npm: "npm",
} as const;
export type RegistryId = keyof typeof REGISTRY_ID;

export interface PkgManagerSpec {
    /** transport id — the knob value managed:<id> */
    id: string;
    /** platform family gate: when is this transport USABLE ("system"-
     *  transports are usable on their deploy target family only;
     *  registry transports are usable everywhere). undefined = any */
    families?: TargetFamily[];
    /** fast availability probe (command presence + env sanity) */
    available: () => boolean;
    /** is the given (resolved) name installed? */
    installed: (name: string) => boolean;
    /** perform install/remove for the given names; dry-run prints */
    run: (op: "install" | "remove", names: string[], dry: boolean) => Promise<number>;
    /** how binary names resolve into installable names (undefined =
     *  the name IS the installable name — registry transports) */
    resolve?: (target: string | null, name: string) => Promise<string | null>;
    /** what fails when the transport's command is missing */
    missing: string;
}

function binOnPath(bin: string): boolean {
    return (Bun.spawnSync(["sh", "-c", `command -v ${bin}`]).exitCode ?? 1) === 0;
}

/** the registry transports use the given name as-is; system transports
 * (below) go through the <target>.deploy name resolution instead */
const resolveSelf = async (): Promise<string | null> => null;

/** the global-list COMMAND per registry transport — the dispatch table
 *  the registry probes go through (no inline bun/npm branching) */
const REGISTRY_LS: Record<RegistryId, string[]> = {
    [REGISTRY_ID.bun]: ["pm", "ls", "-g"],
    [REGISTRY_ID.npm]: ["ls", "-g", "--depth=0"],
};

/** registry-scoped "is this package installed globally?" — the binary
 *  check (binOnPath) would accept any installed binary of that name
 *  (e.g. a system-packaged one), misreading the transport state */
function registryHas(cmd: RegistryId, name: string): boolean {
    const r = Bun.spawnSync([cmd, ...REGISTRY_LS[cmd]]);
    if ((r.exitCode ?? 1) !== 0) return false;
    return (r.stdout ?? "")
        .toString()
        .split("\n")
        .some((line) => line.includes(`${name}@`));
}

/** apt / pacman — the deploy target family transports. The family gate
 *  is checked by the managed verb (it knows the deploy target); the
 *  underlying invocations live in provisioners.ts. Typed ids and
 *  families only — no stringly-typed wiring. */
const systemSpec = (id: PkgManagerId, families: TargetFamily[]): PkgManagerSpec => ({
    id,
    families,
    available: () => binOnPath(id),
    installed: (name) => targetPkgInstalled(id, name),
    run: async (op, names, dry) => await targetPkg(id, op, names, true, dry),
    resolve: async (target, name) => {
        const res = await resolvePackage(target, name);
        return res.ok ? res.pkg : null;
    },
    missing: `${id} not on PATH — not this deploy target's platform package manager?`,
});

/** bun — global registry installs (JS packages; respects the bun trust
 *  policy; run `bun pm trust -g <pkg>` when postinstalls stay blocked) */
const bunSpec: PkgManagerSpec = {
    id: REGISTRY_ID.bun,
    available: () => binOnPath(REGISTRY_ID.bun),
    installed: (name) => registryHas(REGISTRY_ID.bun, name),
    run: (op, names, dry) => {
        if (dry) {
            console.log(`    [dry-run] bun ${op === "install" ? "add" : "remove"} -g ${names.join(" ")}`);
            return Promise.resolve(0);
        }
        const argv = op === "install"
            ? ["bun", "add", "-g", ...names]
            : ["bun", "remove", "-g", ...names];
        const p = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });
        return Promise.resolve(p.exitCode ?? 1);
    },
    resolve: resolveSelf,
    missing: "bun not on PATH — install the bun toolchain first (`on-deploy toolchain --bun`)",
};

/** npm — global registry installs (the JS transport fallback where bun
 *  is unavailable) */
const npmSpec: PkgManagerSpec = {
    id: REGISTRY_ID.npm,
    available: () => binOnPath(REGISTRY_ID.npm),
    installed: (name) => registryHas(REGISTRY_ID.npm, name),
    run: (op, names, dry) => {
        if (dry) {
            console.log(`    [dry-run] npm ${op === "install" ? "install" : "uninstall"} --global ${names.join(" ")}`);
            return Promise.resolve(0);
        }
        const argv = op === "install"
            ? ["npm", "install", "--global", ...names]
            : ["npm", "uninstall", "--global", ...names];
        const p = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });
        return Promise.resolve(p.exitCode ?? 1);
    },
    resolve: resolveSelf,
    missing: "npm not on PATH — install node/npm first",
};

/** THE registry. Keep the array as the only place a transport is
 *  REGISTERED; order documents the supported set (today: the two
 *  platform package managers of the deploy targets + the two JS
 *  registries). */
export const TRANSPORTS: PkgManagerSpec[] = [
    systemSpec(PKG_MANAGER_ID.apt, [TARGET_FAMILY.debian, TARGET_FAMILY.ubuntu]),
    systemSpec(PKG_MANAGER_ID.pacman, [TARGET_FAMILY.arch, TARGET_FAMILY.manjaro]),
    bunSpec,
    npmSpec,
];

export function transportIds(): string[] {
    return TRANSPORTS.map((t) => t.id);
}

/** id lookup + usability against the given deploy target family.
 *  usable=false: a system transport whose family does not include the
 *  target. null: unregistered id (callers list transportIds()). */
export function lookupTransport(
    id: string,
    family?: TargetFamily | null,
): { spec: PkgManagerSpec; usable: boolean } | null {
    const spec = TRANSPORTS.find((t) => t.id === id);
    if (!spec) return null;
    const usable = !spec.families || !family || spec.families.includes(family);
    return { spec, usable };
}
