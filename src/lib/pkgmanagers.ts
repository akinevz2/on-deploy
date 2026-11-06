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
//   1. implement PkgManagerSpec below (id, available, installed, run[req])
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
//     carries the --force / tty gate); specs run sudo the way provisioners
//     .ts does when they need it.
//   - no spec ever hardcodes a dots package name: names come from the
//     caller exactly like the pkg verb.

import { targetPkg, targetPkgInstalled, PKG_MANAGER_ID, TARGET_FAMILY,
    PKG_OP,
    type PkgOpKind, type PkgManagerId, type TargetFamily,
} from "./provisioners";
export { PKG_MANAGER_ID, TARGET_FAMILY, PKG_OP };
export type { PkgManagerId, TargetFamily, PkgOpKind };
import { resolvePackage } from "./deployScript";

/** ── supported enumeration ──────────────────────────────────────────────
 *  ONE typed catalog for everything the managed layer knows about.
 *  Extending support = adding to these catalogs AND implementing the
 *  PkgManagerSpec in the registry (nothing else changes; `on-deploy
 *  supports` prints the result of this same catalog). */

/** the JS registry transports (transport ids live in the same namespace
 *  as the package-manager ids — the pkg method chooses BY the adapter
 *  metadata's repos_pkg coverage) */
export const REGISTRY_ID = {
    bun: "bun",
    npm: "npm",
} as const;
export type RegistryId = keyof typeof REGISTRY_ID;

/** the transport's package-manager invocation REQUEST (a typed
 *  object; no or-unions in the spec signatures) */
export interface TransportRequest {
    op: PkgOpKind;
    names: string[];
    /** dry-run prints instead of acting */
    dry: boolean;
}

export interface PkgManagerSpec {
    /** transport id (typed in the supported catalog) */
    id: PkgManagerId | RegistryId;
    /** platform family gate: when is this transport USABLE ("system"-
     *  transports are usable on their deploy target family only;
     *  registry transports are usable everywhere). undefined = any */
    families?: TargetFamily[];
    /** fast availability probe (command presence + env sanity) */
    available: () => boolean;
    /** is the given (resolved) name installed? */
    installed: (name: string) => boolean;
    /** perform the requested op for the given names; dry runs print */
    run: (req: TransportRequest) => Promise<number>;
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
    installed: (name) => targetPkgInstalled({ pkgMgr: id, name }),
    run: async (req) => await targetPkg({ ...req, pkgMgr: id }),
    resolve: async (target, name) => {
        if (!target) return null;
        const res = await resolvePackage(target, name);
        return res.ok && res.pkg ? res.pkg : null;
    },
    missing: `${id} not on PATH — not this deploy target's platform package manager?`,
});

/** the per-registry command argv dispatch (no inline bun/npm branching):
 *  [install argv, remove argv] per registry transport */
const REGISTRY_ARGV: Record<RegistryId, Record<PkgOpKind, string[]>> = {
    [REGISTRY_ID.bun]: {
        [PKG_OP.install]: ["bun", "add", "-g"],
        [PKG_OP.remove]: ["bun", "remove", "-g"],
    },
    [REGISTRY_ID.npm]: {
        [PKG_OP.install]: ["npm", "install", "--global"],
        [PKG_OP.remove]: ["npm", "uninstall", "--global"],
    },
};

/** one logical op: run a registry transport request */
function registryRun(cmd: RegistryId, req: TransportRequest): Promise<number> {
    const argv = REGISTRY_ARGV[cmd][req.op];
    if (req.dry) {
        console.log(`    [dry-run] ${argv.join(" ")} ${req.names.join(" ")}`);
        return Promise.resolve(0);
    }
    const p = Bun.spawnSync([...argv, ...req.names], { stdout: "inherit", stderr: "inherit" });
    return Promise.resolve(p.exitCode ?? 1);
}

/** bun — global registry installs (JS packages; respects the bun trust
 *  policy; run `bun pm trust -g <pkg>` when postinstalls stay blocked) */
const bunSpec: PkgManagerSpec = {
    id: REGISTRY_ID.bun,
    available: () => binOnPath(REGISTRY_ID.bun),
    installed: (name) => registryHas(REGISTRY_ID.bun, name),
    run: (req) => registryRun(REGISTRY_ID.bun, req),
    resolve: resolveSelf,
    missing: "bun not on PATH — install the bun toolchain first (`on-deploy toolchain --bun`)",
};

/** npm — global registry installs (the JS transport fallback where bun
 *  is unavailable) */
const npmSpec: PkgManagerSpec = {
    id: REGISTRY_ID.npm,
    available: () => binOnPath(REGISTRY_ID.npm),
    installed: (name) => registryHas(REGISTRY_ID.npm, name),
    run: (req) => registryRun(REGISTRY_ID.npm, req),
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
