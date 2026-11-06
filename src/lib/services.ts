// src/lib/services.ts — the services.required runner, shared by the
// `services` verb and the `deploy` menu. All actions run --no-block (a
// headless herbst polls 30s for X per attempt and would idle the
// caller). Stop does NOT use `systemctl --user disable`: a stow-linked
// unit file would be deleted (disable undoes `systemctl link`); the
// .wants symlinks are dropped by hand, and pending start/restart jobs
// are cancelled first so stop never waits on a stuck start job.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DOTS_DIR } from "./dots";

export const SERVICE_ORDER_FILE = join(DOTS_DIR, "services.required");

export type ServicesAction = "check" | "start" | "stop" | "restart" | "status";

export const SERVICES_ACTIONS: ServicesAction[] = [
    "check", "start", "stop", "restart", "status",
];

function shOut(cmd: string): { code: number; out: string } {
    const p = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
    return { code: p.status ?? 1, out: (p.stdout ?? "").trim() };
}

function run(cmd: string): number {
    const p = spawnSync("sh", ["-c", cmd], { stdio: "inherit" });
    return p.status ?? 1;
}

/** the services.required manifest (base names, whitespace-split per line) */
export function readServiceOrder(): string[] {
    return shOut(`grep -vi '^#' ${JSON.stringify(SERVICE_ORDER_FILE)} 2>/dev/null`)
        .out.split(/\s+/)
        .filter(Boolean);
}

/** append `.service` where missing */
export function unitify(names: string[]): string[] {
    return names.map((u) => (u.endsWith(".service") ? u : `${u}.service`));
}

/** run a services action over EXPLICIT unit names (no confirmation —
 *  the caller owns it). Returns the failure count. */
export function runServicesAction(action: ServicesAction, units: string[]): number {
    let failed = 0;
    if (action === "check") {
        failed += run("systemctl --user daemon-reload");
        for (const unit of units) {
            const code = run(`systemctl --user enable --now --no-block ${unit}`);
            if (code !== 0) console.error(`services: failed to enable, ${unit}`);
            failed += Math.min(code, 1);
        }
        console.log(`services: enabled: ${units.join(" ")}`);
    } else if (action === "start") {
        failed += run("systemctl --user daemon-reload");
        for (const unit of units) {
            run(`systemctl --user reset-failed ${unit} 2>/dev/null`);
            failed += Math.min(run(`systemctl --user start --no-block ${unit}`), 1);
        }
    } else if (action === "stop") {
        for (const unit of units) {
            shOut(
                `for d in "$HOME"/.config/systemd/user/*.wants; do ` +
                `[ -e "$d/${unit}" ] && rm -f "$d/${unit}"; done; exit 0`,
            );
            const jobs = shOut(
                `systemctl --user list-jobs --no-legend 2>/dev/null | ` +
                `grep -F " ${unit}" | grep -E " (start|restart) " | cut -d" " -f1`,
            ).out;
            for (const job of jobs.split("\n").filter(Boolean)) {
                run(`systemctl --user cancel ${job} 2>/dev/null`);
            }
            failed += Math.min(run(`systemctl --user stop --no-block ${unit} 2>/dev/null`), 1);
        }
    } else if (action === "restart") {
        failed += run("systemctl --user daemon-reload");
        for (const unit of units) {
            failed += Math.min(run(`systemctl --user restart --no-block ${unit} 2>/dev/null`), 1);
        }
    } else {
        // status: WAIT for the jobs to settle, then report
        Bun.spawnSync(["sleep", "1"]);
    }

    console.log(`services: ${action} submitted; current state:`);
    for (const unit of units) {
        const st = shOut(`systemctl --user is-active ${unit} 2>/dev/null`).out || "unknown";
        console.log(`	${unit.padEnd(28)} ${st}`);
    }
    return failed;
}
