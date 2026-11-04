// src/commands/services.ts — the service.order runner. The dots Makefile
// DELEGATES here: enable/start/stop/restart over the units listed in
// service.order (repo-level manifest, one unit name per non-comment
// line, in start order).
//
//   on-deploy services check      daemon-reload + enable --now each unit
//   on-deploy services start      start each unit (reset-failed first)
//   on-deploy services stop       drop .wants links + cancel jobs + stop
//   on-deploy services restart    restart each unit
//   on-deploy services status     is-active per unit
//
// All actions run --no-block (a headless herbst polls 30s for X per
// attempt and would idle the caller). Stop does NOT use
// `systemctl --user disable`: a stow-linked unit file would be deleted
// (disable undoes `systemctl link`); the .wants symlinks are dropped
// by hand. Non-interactive runs require --yes. NO package knowledge:
// the unit list comes entirely from service.order.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { checkDotsEnv, DOTS_DIR } from "../lib/dots";

type Action = "check" | "start" | "stop" | "restart" | "status";

const SERVICE_ORDER_FILE = join(DOTS_DIR, "service.order");

function shOut(cmd: string): { code: number; out: string } {
    const p = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
    return { code: p.status ?? 1, out: (p.stdout ?? "").trim() };
}

function readOrder(): string[] {
    return shOut(`grep -vi '^#' ${JSON.stringify(SERVICE_ORDER_FILE)} 2>/dev/null`)
        .out.split(/\s+/)
        .filter(Boolean);
}

function run(cmd: string): number {
    const p = spawnSync("sh", ["-c", cmd], { stdio: "inherit" });
    return p.status ?? 1;
}

export default defineCommand({
    name: "services",
    description:
        "Run service.order units: check|start|stop|restart|status (systemd --user, --no-block, stow-safe disable)",
    options: {
        yes: option(z.boolean().optional(), {
            description: "no confirmation (non-interactive)",
            short: "y",
        }),
    },
    handler: async ({ flags, positional }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            console.error(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const action = (positional[0] ?? "") as Action;
        const ACTIONS: Action[] = ["check", "start", "stop", "restart", "status"];
        if (!ACTIONS.includes(action)) {
            console.error(`services: usage: on-deploy services <${ACTIONS.join("|")}> [--yes]`);
            process.exit(2);
        }
        const order = readOrder();
        if (order.length === 0) {
            console.error(`services: empty or missing ${SERVICE_ORDER_FILE}`);
            process.exit(2);
        }
        const units = order.map((u) => (u.endsWith(".service") ? u : `${u}.service`));
        const yes = !!flags.yes;

        // confirm on interactive terminals for start/stop/restart — the
        // Makefile may need to run these non-interactively, so --yes
        // bypasses; non-tty without --yes aborts (nothing hangs)
        if ((action === "start" || action === "stop" || action === "restart") && !yes) {
            if (!process.stdin.isTTY) {
                console.error("services: non-interactive without --yes — aborting");
                process.exit(1);
            }
            console.log(`services: ${units.join(" ")}`);
            process.stdout.write(`services: continue with ${action}? [y/N] `);
            const line = await (async () => {
                const dec = new TextDecoder();
                for await (const chunk of process.stdin) {
                    const s = dec.decode(chunk as Uint8Array);
                    if (s.includes("\n")) return s.trim().toLowerCase();
                }
                return "";
            })();
            if (line !== "y" && line !== "yes") {
                console.log("services: cancelled");
                return;
            }
        }

        const suffix = units.join(" ");
        let failed = 0;
        if (action === "check") {
            failed += run("systemctl --user daemon-reload");
            for (const unit of units) {
                const code = run(`systemctl --user enable --now --no-block ${unit}`);
                if (code !== 0) console.error(`services: failed to enable ${unit}`);
                failed += Math.min(code, 1);
            }
            console.log(`services: enabled: ${suffix}`);
        } else if (action === "start") {
            failed += run("systemctl --user daemon-reload");
            for (const unit of units) {
                run(`systemctl --user reset-failed ${unit} 2>/dev/null`);
                failed += Math.min(run(`systemctl --user start --no-block ${unit}`), 1);
            }
        } else if (action === "stop") {
            for (const unit of units) {
                // drop the .wants symlinks by hand — `disable` would delete
                // the stow-linked unit file itself
                shOut(
                    `for d in "$HOME"/.config/systemd/user/*.wants; do ` +
                    `[ -e "$d/${unit}" ] && rm -f "$d/${unit}"; done; exit 0`,
                );
                // cancel pending start/restart jobs: a stuck activating
                // unit makes a plain stop wait for them
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
            console.log(`  ${unit.padEnd(28)} ${st}`);
        }
        if (failed > 0) process.exit(1);
    },
});
