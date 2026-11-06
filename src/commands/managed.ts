// src/commands/managed.ts — the PACKAGE-MANAGED deploy router. It owns
// per-package method routing (formerly duplicated in every dots
// router-Makefile) AND the transport machinery (formerly verb-level).
// The adapters declare package-specific VARIABLES (the metadata
// contract in lib/adapters.ts) and keep only concrete step recipes:
//
//	method resolution: --method M > doftiles.conf record > source
//     ("none" = unset)
//     validity check against the adapter's metadata methods_supported
//	pkg → the repositories from metadata repos_pkg (registry bun/npm
//         first, then the deploy target's platform package manager —
//	lib/pkgmanagers.ts in-process: family gates, the
//	<target>.deploy binary-name resolution for system transports)
//     source → the adapter's own install-source recipe
//	the conf record update (through the repo-stowed doftiles.conf)
//	stow via pkgops when the adapter really produced a dots artifact
//
// VERB SURFACE (the adapters' target table, preserved):
//
//	routed here	install, uninstall, status, conf-get, conf-set,
//	start/stop/enable/disable (common no-ops)
//	passthrough	toolchain, build, link, install-source,
//	install-release, trust-local, trust-global — any
//	other op is a plain make target on the adapter
//	consult	metadata (prints the one-line summary)
//
//	on-deploy managed <pkg> <op> [--method M] [--force] [--dry-run]
//
// The adapters' install/uninstall targets stay the make-level interface
// (the depends walk keeps calling them); their body is a delegation.
// No adapter branching: only this router decides.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
    consult, confGet, confSet, deployedAlready, deployedState, methodSupported,
    registryTransportInstalled,
    type PkgDescriptor,
} from "../lib/adapters";
import { echoHelpList, echoOrdered , say } from "../lib/lines";
import { pkgMakefile, stowPkg, swapArtifact, unstowPkg } from "../lib/pkgops";
import { lookupTransport } from "../lib/pkgmanagers";
import { readRequires } from "../lib/dots";
import {
    familyPkgManager, PKG_OP, type TargetFamily,
} from "../lib/provisioners";

interface MakeResult { ok: boolean; lines: string[] }

interface MethodArgs {
    method?: string;
    value?: string;
    force: boolean;
    dry: boolean;
}

const COMMON_NOOPS = new Set(["start", "stop", "enable", "disable"]);

/** the package-manager transport resolution for the `pkg` method —
 *  driven by the adapter's repos_pkg coverage list (bun, npm before
 *  the deploy target's system package manager; unavailable ones step
 * aside, and an empty repos_pkg fails cleanly) */
async function pkgTransport(desc: PkgDescriptor, family: string | null) {
    for (const id of desc.reposPkg) {
        const found = lookupTransport(id);
        if (!found?.spec?.available()) continue;
        return { spec: found.spec, id, installable: desc.installName };
    }
    if (family) {
        const sysId = familyPkgManager(family);
        const found = sysId
            ? lookupTransport(sysId, family as TargetFamily)
            : null;
        if (found?.spec?.available()) {
            const resolved = found.spec.resolve
                ? await found.spec.resolve(family, desc.installName)
                : null;
            return { spec: found.spec, id: sysId, installable: resolved ?? desc.installName };
        }
    }
    return null;
}

/** the `pkg` method: resolve + install through the transport selected
 *  from the adapter's repos_pkg coverage */
async function runPkg(desc: PkgDescriptor, family: string | null, args: MethodArgs): Promise<MakeResult> {
    const t = await pkgTransport(desc, family);
    if (!t) {
        return { ok: false, lines: [
            `${desc.pkg}: no repository carries '${desc.installName}' (repos_pkg: ${desc.reposPkg.join(" ")}) — pkg method unusable`,
        ] };
    }
    const lines: string[] = [];
    if (!args.force && t.spec.installed(t.installable)) {
        lines.push(`  ${desc.pkg.padEnd(11)} installed already (${t.id}: ${t.installable})`);
        return { ok: true, lines };
    }
    lines.push(`  ${desc.pkg.padEnd(11)} install (${t.id}${t.installable !== desc.installName ? ` via ${t.installable}` : ""})`);
    return { ok: (await t.spec.run({ op: PKG_OP.install, names: [t.installable], dry: args.dry })) === 0, lines };
}

/** resolve: --method M > conf record > source; none = unset */
function resolveMethod(desc: PkgDescriptor, args: MethodArgs): string {
    let resolved = args.method ?? "";
    if (!resolved) resolved = confGet(desc.key);
    if (resolved === "none") resolved = "";
    if (!resolved) resolved = "source";
    return resolved;
}

function dryGuard(dry: boolean, what: string): boolean {
    if (!dry) return false;
    console.log(`  [dry-run] ${what}`);
    return true;
}

/** run one adapter recipe (1 shell-out; the adapters are plain) */
function runAdapter(desc: PkgDescriptor, target: string, force: boolean): MakeResult {
    const vars: string[] = [];
    if (force) vars.push("FORCE=1");
    const r = Bun.spawnSync([
        "make", "-C", join(process.env.HOME!, "dots", desc.pkg), "--no-print-directory",
        "-f", `.local/state/depends/${desc.pkg}.Makefile`, target, ...vars,
    ], { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
    return { ok: (r.exitCode ?? 1) === 0, lines: [] };
}

interface MakeResult { ok: boolean; lines: string[] }

export default defineCommand({
    name: "managed",
    description:
        "Route ONE package's ops to its adapter Makefile.\n" +
        "\tmethod/knob syntax: on-deploy supports.",
    options: {
        method: option(z.string().optional(), {
            description: "Override the doftiles.conf record (PACKAGE=source|pkg)",
        }),
        value: option(z.string().optional(), {
            description: "Write the conf-set record value",
        }),
        force: option(z.string().optional(), { argumentKind: "flag" as const,
            description: "Redeploy even when deployed already (--force=1)",
        }),
        "dry-run": option(z.string().optional(), { argumentKind: "flag" as const,
            description: "Print what would run (--dry-run=1)",
        }),
    },
    handler: async ({ flags, positional }) => {
        const [pkg, op, ...extra] = positional ?? [];
        if (op === "help" || pkg === "help") {
            echoHelpList("managed", "usage\ton-deploy managed <pkg> <op> [--method|--force|--dry-run]", [
                "install\troute PACKAGE=source|pkg",
                "uninstall\tadapter uninstall + unstow + record reset",
                "status\tdeploy state: artifact + checkout + record",
                "conf-get\tprint the doftiles.conf record",
                "conf-set\twrite the record (--value V)",
                "metadata\tthe metadata items, one line",
                "toolchain, build, link\tpassthrough make targets",
                "trust-local, trust-global\tpassthrough make targets",
            ]);
            process.exit(0);
        }
        if (!pkg || !op || extra.length > 0) {
            say(`managed: ${op || "(no op)"} is not a managed op`);
            say("managed:\tusage\ton-deploy managed <pkg> <op>");
            say("managed:\thelp\ton-deploy managed <pkg> help");
            process.exit(2);
        }
        const { target } = await readRequires();
        const family: string | null = target ?? null;
        if (!pkgMakefile(pkg)) {
            say(`managed: ${pkg}: no adapter`);
            say(`managed:\tabsent\tdots/${pkg}/.local/state/depends/${pkg}.Makefile`);
            process.exit(2);
        }
        const consultDesc = consult(pkg);
        if (!consultDesc.ok) {
            echoOrdered([
                `managed: ${pkg}: ${consultDesc.problem}`,
                `managed: the adapter consult failed for ${pkg}`,
            ]);
            process.exit(2);
        }
        const desc: PkgDescriptor = consultDesc;

        // the metadata surface: ONE op per contract item, each prints
        // the BARE value on a single stdout line; `method` reports the
        // current doftiles.conf record
        const descs: Record<string, (d: PkgDescriptor) => string> = {
            git_repo: (d) => d.repoUrl,
            pkg_name: (d) => d.pkgName,
            methods_supported: (d) => d.methods.join(","),
            repos_pkg: (d) => d.reposPkg.join(","),
            repos_pkg_name: (d) => d.installName,
            method: (d) => confGet(d.key),
        };
        if (descs[op]) {
            console.log(descs[op](desc));
            return;
        }

        if (op === "metadata") {
            console.log(Object.entries(descs).map(([k, v]) => `${k}=${v(desc)}`).join(" "));
            return;
        }

        const args: MethodArgs = {
            method: flags.method || undefined,
            value: flags.value || undefined,
            force: flags.force === "1" || flags.force === "true",
            dry: flags["dry-run"] === "1" || flags["dry-run"] === "true",
        };

        if (COMMON_NOOPS.has(op)) {
            console.log(`  ${desc.pkg.padEnd(11)} nothing to ${op}`);
            return;
        }

        if (op === "conf-get") {
            console.log(`  ${desc.pkg.padEnd(11)} ${desc.key}=${confGet(desc.key)}`);
            return;
        }
        if (op === "conf-set") {
            if (args.value === undefined) {
                say("managed: conf-set needs --value");
                process.exit(2);
            }
            if (dryGuard(args.dry, `conf-set ${desc.key}=${args.value}`)) return;
            confSet(desc.key, args.value);
            console.log(`  ${desc.pkg.padEnd(11)} ${desc.key}=${args.value}`);
            return;
        }

        if (op === "status") {
            const registryCovered = desc.artifact
                ? !existsSync(join(process.env.HOME!, "dots", desc.artifact))
                : true;
            let registryOk = false;
            if (registryCovered) {
                for (const id of desc.reposPkg) {
                    if (registryTransportInstalled(id, desc.installName)) { registryOk = true; break; }
                }
            }
            const art = desc.artifact ? existsSync(join(process.env.HOME!, "dots", desc.artifact)) : false;
            const subOk = desc.subDir ? existsSync(join(process.env.HOME!, "dots", desc.subDir)) : true;
            console.log(`  ${desc.pkg.padEnd(11)} ${registryOk ? "installed" : deployedState(desc)}`);
            console.log(`  ${"".padEnd(11)} artifact=${art ? "linked" : "none"}`);
            console.log(`  ${"".padEnd(11)} checkout=${subOk ? "present" : "missing"} method=${confGet(desc.key) || "(unset)"}`);
            return;
        }

        if (op === "uninstall") {
            if (dryGuard(args.dry, "adapter uninstall + conf reset")) return;
            // a pkg-recorded route removes through ITS transport; a
            // source deployment leaves the transports alone
            const prior = confGet(desc.key);
            if (prior === "pkg") {
                const t = await pkgTransport(desc, family);
                if (t) {
                    const rc = await t.spec.run({ op: PKG_OP.remove, names: [t.installable], dry: false });
                    if (rc !== 0) { say(`managed: ${desc.pkg}: transport remove FAILED (${t.id})`); process.exit(1); }
                }
            }
            const r = runAdapter(desc, "uninstall", args.force);
            if (!r.ok) process.exit(1);
            unstowPkg(desc.pkg);
            confSet(desc.key, "none");
            console.log(`  ${desc.pkg.padEnd(11)} uninstalled`);
            return;
        }

        if (op === "install") {
            // the deployed-already guard (unless --force/--method)
            const resolved = resolveMethod(desc, args);
            if (!methodSupported(desc, resolved)) {
                say(`managed: ${desc.pkg}: unknown method '${resolved}' (methods_supported: ${desc.methods.join(" ")})`);
                process.exit(2);
            }
            console.log(`  ${desc.pkg.padEnd(11)} install (method=${resolved})`);
            if (resolved === "pkg") {
                const r = await runPkg(desc, family, args);
                for (const line of r.lines) console.log(line);
                if (!r.ok) {
                    say(`managed: ${desc.pkg}: pkg route FAILED`);
                    process.exit(1);
                }
                if (dryGuard(args.dry, `conf-set ${desc.key}=${resolved}`)) return;
                confSet(desc.key, resolved);
                return;
            }
            // source: the adapter's composed route
            if (dryGuard(args.dry, "make install-source")) return;
            const r = runAdapter(desc, "install-source", args.force);
            if (!r.ok) {
                say(`managed: ${desc.pkg}: FAILED (make install-source)`);
                process.exit(1);
            }
            // landed: stow + swap ONLY where the adapter really placed
            // a dots artifact (registry adapters do not)
            if (desc.artifact && existsSync(join(process.env.HOME!, "dots", desc.artifact))) {
                swapArtifact(desc.installName);
                stowPkg(desc.pkg);
            }
            confSet(desc.key, resolved);
            return;
        }

        // everything else: passthrough to the adapter's own recipe
        if (dryGuard(args.dry, `make ${op}`)) return;
        const r = runAdapter(desc, op, args.force);
        if (!r.ok) process.exit(1);
    },
});
