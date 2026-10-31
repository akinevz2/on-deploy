// src/commands/deps.ts — the deployable-dependencies command.
//
// This USED to be a Makefile deployed at ~/.local/share/doftiles (a
// stowed copy of the repo-side file) with `make -C ~/.local/share/
// doftiles deploy-fromsource` — backwards: the "deployed copy" was
// just the repo file talking to itself. The dependency deployment now
// lives HERE, where the rest of the deploy machinery lives.
//
//   on-deploy deps                    ensure the artifact (deploy only
//                                     when missing — the install step)
//   on-deploy deps --force            redeploy now (the refresh flow)
//   on-deploy deps --method source|npm|release
//                                     deploy with an explicit method
//                                     (and record it)
//   on-deploy deps --uninstall        remove the artifact per the
//                                     recorded method
//   on-deploy deps --dry-run          print what would be done
//
// The only deployable is polyframes (the polybar module / rofi menus
// binary the WM stack execs directly). The install method is recorded
// in ~/.config/doftiles.conf (stowed from the repo — method changes
// show up as a tracked diff):
//   source   built from the depends/.local/share/polyframes submodule
//            checkout (bun install + the package's own make install)
//   npm      npm install --global github:akinevz2/polyframes
//   release  the toolchain-free fallback: the latest github release
//            asset over https straight into ~/.local/bin
//
// Invariant after a successful run: ~/.local/bin/polyframes exists.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DOTS_DIR } from "../lib/dots";

const CONF = join(process.env.HOME!, ".config", "doftiles.conf");
const POLYFRAMES_SUBMOD = join(DOTS_DIR, "depends", ".local", "share", "polyframes");
const POLYFRAMES_BIN = join(process.env.HOME!, ".local", "bin", "polyframes");
const POLYFRAMES_REPO = "https://github.com/akinevz2/polyframes";
const POLYFRAMES_NPM = "github:akinevz2/polyframes";
const RELEASE_URL = `${POLYFRAMES_REPO}/releases/latest/download/polyframes-linux-x64`;
type Method = "source" | "npm" | "release";

function sh(cmd: string, args: string[]): { code: number; out: string } {
    const p = Bun.spawnSync([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? 1, out: (p.stdout ?? "").toString().trim() };
}

function run(cmd: string, args: string[]): number {
    const p = Bun.spawnSync([cmd, ...args], {
        stdout: "inherit", stderr: "inherit", stdin: "inherit",
    });
    return p.exitCode ?? 1;
}

function confGet(): string | null {
    const f = Bun.file(CONF);
    if (!existsSync(CONF)) return null;
    // sync via file read (sed --follow-symlinks equivalent for reading)
    const text = Bun.spawnSync(["sh", "-c", `. '${CONF}' 2>/dev/null; printf '%s' "$POLYFRAMES_METHOD"`]);
    const v = (text.stdout ?? "").toString().trim();
    return v || null;
}

function confSet(method: string): void {
    // the conf lives in the repo via stow — write through the symlink
    // (sed --follow-symlinks keeps it a link; a plain redirect would
    // replace it with a regular file)
    const f = Bun.spawnSync(["sh", "-c",
        `touch '${CONF}'; ` +
        `if grep -q '^POLYFRAMES_METHOD=' '${CONF}'; then ` +
        `sed -i --follow-symlinks 's/^POLYFRAMES_METHOD=.*/POLYFRAMES_METHOD=${method}/' '${CONF}'; ` +
        `else printf 'POLYFRAMES_METHOD=${method}\\n' >> '${CONF}'; fi`,
    ]);
    if (f.exitCode !== 0) {
        console.error(`deps: WARNING: method=${method} not recorded in ${CONF}`);
    }
}

/** sync the submodule checkout to origin/main (the source-build base) */
function polyframesSync(dry: boolean): number {
    if (!existsSync(POLYFRAMES_SUBMOD)) {
        console.error(`deps: submodule checkout missing — ${POLYFRAMES_SUBMOD}`);
        console.error("  run 'make submodules' first (git submodule update --init --recursive --remote)");
        return 1;
    }
    if (dry) {
        console.log(`    [dry-run] git -C ${DOTS_DIR} submodule sync/update + ${POLYFRAMES_SUBMOD} -> origin/main`);
        return 0;
    }
    if (run("git", ["-C", DOTS_DIR, "submodule", "sync", "--", "depends/.local/share/polyframes"]) !== 0) return 1;
    if (run("git", ["-C", DOTS_DIR, "submodule", "update", "--init", "--", "depends/.local/share/polyframes"]) !== 0) return 1;
    if (run("git", ["-C", POLYFRAMES_SUBMOD, "checkout", "-q", "-B", "main", "origin/main"]) !== 0) return 1;
    if (run("git", ["-C", POLYFRAMES_SUBMOD, "pull", "--ff-only"]) !== 0) return 1;
    return 0;
}

function deploySource(dry: boolean): { ok: boolean; detail: string } {
    if (sh("which", ["bun"]).code !== 0) {
        return { ok: false, detail: "bun not found — arch: pacman -S bun, or use --method npm/release" };
    }
    if (polyframesSync(dry) !== 0) return { ok: false, detail: "submodule sync failed" };
    if (dry) {
        return { ok: true, detail: "[dry-run] bun install + make install in the submodule" };
    }
    if (run("sh", ["-c", `cd '${POLYFRAMES_SUBMOD}' && bun install`]) !== 0) {
        return { ok: false, detail: "bun install failed in the polyframes submodule" };
    }
    // the deploy target's trust issue: bun's default policy keeps
    // lifecycle scripts (postinstall) blocked in the submodule too —
    // e.g. herbstutil's `bunli generate`, or the vendored `bun` package
    // itself whose postinstall `bun x bunli build` needs. Trust every
    // untrusted dependency of the checkout, then heal bun's postinstall.
    if (!dry) {
        const untrusted = sh("sh", ["-c", `cd '${POLYFRAMES_SUBMOD}' && bun pm untrusted 2>/dev/null`]).out;
        for (const line of untrusted.split("\n")) {
            const m = line.match(/\.\/node_modules\/(\S+)/);
            if (!m) continue;
            const code = sh("sh", ["-c", `cd '${POLYFRAMES_SUBMOD}' && bun pm trust ./node_modules/${m[1]}`]).code;
            console.log(code === 0
                ? `    trust: ${m[1]} (postinstall scripts ran)`
                : `    trust: ${m[1]} FAILED — its lifecycle scripts stay blocked`);
        }
    }
    // bun's own postinstall can sit un-run (a --ignore-scripts install or
    // a previous partial state); `bun x bunli build` then fails with
    // "Bun's postinstall script was not run". Heal it when present.
    if (existsSync(join(POLYFRAMES_SUBMOD, "node_modules", "bun", "install.js"))) {
        if (run("sh", ["-c", `cd '${POLYFRAMES_SUBMOD}/node_modules/bun' && node install.js`]) !== 0) {
            console.error("deps: WARNING: local bun postinstall failed");
            console.error("deps: the build may still fail");
        }
    }
    if (run("make", ["-C", POLYFRAMES_SUBMOD, "install"]) !== 0) {
        return { ok: false, detail: "make install failed in the polyframes submodule" };
    }
    return { ok: true, detail: `built from source -> ${POLYFRAMES_BIN}` };
}

function deployNpm(dry: boolean): { ok: boolean; detail: string } {
    if (sh("which", ["npm"]).code !== 0) {
        return { ok: false, detail: "npm not found — arch: pacman -S npm, or use --method release" };
    }
    if (dry) return { ok: true, detail: `[dry-run] npm install --global ${POLYFRAMES_NPM}` };
    if (run("npm", ["install", "--global", POLYFRAMES_NPM]) !== 0) {
        return { ok: false, detail: "npm install failed" };
    }
    return { ok: true, detail: `installed via npm -> ${POLYFRAMES_BIN}` };
}

function deployRelease(dry: boolean): { ok: boolean; detail: string } {
    const fetcher = sh("which", ["curl"]).code === 0 ? "curl"
        : sh("which", ["wget"]).code === 0 ? "wget" : "";
    if (!fetcher) {
        return { ok: false, detail: "neither curl nor wget found — arch: pacman -S curl" };
    }
    if (dry) {
        return { ok: true, detail: `[dry-run] ${fetcher} ${RELEASE_URL} -> ${POLYFRAMES_BIN}` };
    }
    const tmp = `/tmp/polyframes-install.${process.pid}`;
    const dl = fetcher === "curl"
        ? run("curl", ["-fL", "--retry", "3", "--user-agent", "doftiles-deploy", RELEASE_URL, "-o", tmp])
        : run("wget", ["-q", "-O", tmp, RELEASE_URL]);
    if (dl !== 0) {
        Bun.spawnSync(["rm", "-f", tmp]);
        return { ok: false, detail: `download failed from ${RELEASE_URL}` };
    }
    Bun.spawnSync(["mkdir", "-p", join(process.env.HOME!, ".local", "bin")]);
    const inst = Bun.spawnSync(["install", "-m", "755", tmp, POLYFRAMES_BIN]);
    Bun.spawnSync(["rm", "-f", tmp]);
    if ((inst.exitCode ?? 1) !== 0) return { ok: false, detail: "install failed" };
    return { ok: true, detail: `release artifact -> ${POLYFRAMES_BIN}` };
}

function deploy(method: Method, dry: boolean): { ok: boolean; detail: string } {
    const r = method === "source" ? deploySource(dry)
        : method === "npm" ? deployNpm(dry)
        : deployRelease(dry);
    if (r.ok && !dry) confSet(method);
    return r;
}

export default defineCommand({
    name: "deps",
    description:
        "Deploy the doftiles dependencies (polyframes) — ensure | --force | --method source|npm|release | --uninstall",
    options: {
        "dry-run": option(z.boolean().optional(), {
            description: "print what would be done, change nothing",
        }),
        force: option(z.boolean().optional(), {
            description: "redeploy even when the artifact exists (the refresh flow)",
            short: "f",
        }),
        method: option(z.enum(["source", "npm", "release"]).optional(), {
            description: "deploy with this method and record it (overrides the conf)",
        }),
        uninstall: option(z.boolean().optional(), {
            description: "remove the artifact per the recorded method, reset the conf",
        }),
    },
    handler: async ({ flags }) => {
        const dry = !!flags["dry-run"];
        const recorded = confGet();

        // --- uninstall -----------------------------------------------
        if (flags.uninstall) {
            if (!recorded || recorded === "none") {
                console.log(`deps: nothing recorded in ${CONF} — nothing to uninstall`);
                return;
            }
            if (dry) {
                console.log(`  [dry-run] uninstall per ${recorded}`);
                return;
            }
            const r = recorded === "npm"
                ? run("npm", ["uninstall", "--global", "polyframes"])
                : (Bun.spawnSync(["rm", "-f", POLYFRAMES_BIN]).exitCode ?? 1);
            if (r === 0) {
                confSet("none");
                console.log(`deps: uninstalled polyframes (was ${recorded}); submodule checkout left in place`);
            } else {
                console.error(`deps: uninstall FAILED (method ${recorded})`);
                process.exit(1);
            }
            return;
        }

        // --- ensure / deploy -----------------------------------------
        const method: Method = flags.method ?? (recorded && recorded !== "none" ? recorded as Method
            : sh("which", ["bun"]).code === 0 ? "source" : "release");
        if (!existsSync(POLYFRAMES_BIN) || flags.force || flags.method) {
            if (existsSync(POLYFRAMES_BIN) && !flags.method) {
                console.log(`deps: ${POLYFRAMES_BIN} exists — redeploying (--force, method=${method})`);
            }
            const r = deploy(method, dry);
            console.log(`  deps     ${r.ok ? "ok" : "FAILED"} — ${r.detail}`);
            if (!r.ok) process.exit(1);
        } else {
            console.log(`  deps     ok — ${POLYFRAMES_BIN} deployed already (method=${recorded ?? "unset"}) — skipping (--force redeploys)`);
        }
    },
});
