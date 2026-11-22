// src/lib/commitUI.ts — the PRESENTATION ADAPTER of the commit-flow
// verb. The flow driver (commands/commit-flow.ts) holds no interactive
// primitives: every prompt delegates here, per the dots doctrine that
// guided flows NEVER inline their front end and NEVER put UI in
// scripting glue outside this compiled repo.
//
// Backends — POSIX-portable primitives ONLY (node:readline + a pager;
// no external TUI packages):
//   readline   guided numbered menus on a tty
//   cli        fail-fast: no prompts, everything auto-confirms
// Selection: $DOTS_COMMIT_UI (readline|cli) when set, else readline
// iff stdin is a tty, else cli (--auto forces cli).

import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { stdin, stderr, stdout } from "node:process";

export type Backend = "readline" | "cli";

export function pickBackend(forceCli: boolean): Backend {
    const knob = process.env.DOTS_COMMIT_UI;
    if (knob === "readline" || knob === "cli") return knob;
    if (forceCli) return "cli";
    return stdin.isTTY ? "readline" : "cli";
}

let rl: ReturnType<typeof createInterface> | null = null;

function iface() {
    if (!rl) rl = createInterface({ input: stdin, output: stderr });
    return rl;
}

/** progress line */
export function note(msg: string): void {
    stderr.write(`dots-commit: ${msg}\n`);
}

/** announce + exit 1 */
export function die(msg: string): never {
    stderr.write(`dots-commit: ${msg}\n`);
    process.exit(1);
}

/** best-effort interactive nudge (no-op in the cli backend) */
export async function pause(backend: Backend): Promise<void> {
    if (backend !== "readline") return;
    stderr.write("press Enter to continue...");
    await iface().question("");
}

/** exit 0 = yes. cli backend: fail-fast means no prompts — yes. */
export async function yesno(backend: Backend, q: string): Promise<boolean> {
    if (backend !== "readline") return true;
    for (;;) {
        const a = (await iface().question(`${q} [y/N] `)).trim().toLowerCase();
        if (a === "y" || a === "yes") return true;
        if (a === "n" || a === "no" || a === "") return false;
    }
}

/** numbered readline menu; null = cancelled. cli backend: null. */
export async function choose(
    backend: Backend,
    title: string,
    items: readonly { tag: string; desc: string }[],
): Promise<string | null> {
    if (backend !== "readline") return null;
    stderr.write(`${title}\n`);
    items.forEach((it, i) =>
        stderr.write(`  ${String(i + 1).padStart(2)}) ${it.tag.padEnd(14)} ${it.desc}\n`),
    );
    for (;;) {
        const a = (await iface().question("choose: ")).trim();
        if (!/^\d+$/.test(a)) continue;
        const n = Number(a);
        if (n < 1 || n > items.length) continue;
        return items[n - 1].tag;
    }
}

/** prompt with a default; echoes the answer (the default when empty).
 * cli backend: fail-fast — no prompts, the default. */
export async function input(backend: Backend, prompt: string, dflt: string): Promise<string> {
    if (backend !== "readline") return dflt;
    const a = (await iface().question(`${prompt} [${dflt}] `)).trim();
    return a === "" ? dflt : a;
}

/** show a file's content: less when interactive, plain cat otherwise */
export async function view(title: string, path: string): Promise<void> {
    stderr.write(`── ${title} ──\n`);
    const useLess = stdout.isTTY && spawnSync("sh", ["-c", "command -v less >/dev/null"]).status === 0;
    if (useLess) {
        const r = spawnSync("less", ["-R", path], { stdio: "inherit" });
        if (r.status !== 0) console.log(spawnSync("cat", [path], { encoding: "utf8" }).stdout ?? "");
    } else {
        console.log(spawnSync("cat", [path], { encoding: "utf8" }).stdout ?? "");
    }
}
