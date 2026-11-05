// src/commands/detect-server.ts — the shared X display probe.
//
//   on-deploy detect-server [--persist-to-systemd]
//
// Detects the REACHABLE X server: inherited $DISPLAY first, then the
// WSL conventions (localhost:0.0 | localhost:1.0), then plain :0 / :1
// — each candidate bounded by a 2s probe (xset q). Prints the winner.
//
//   --persist-to-systemd  also sets DISPLAY in the systemd USER MANAGER
//                         environment (systemctl --user set-environment),
//                         so every user unit inherits it — the single
//                         place DISPLAY is decided (no unit hardcodes).
//
// check-x-server.service is the caller-of-record: Type=oneshot with
// Restart=on-failure — a FAILED probe (exit 1) is the "wait for X"
// mechanism (retry per RestartSec), a clean exit gates the WM session.
//
// Exit codes: 0 winner (printed), 2 usage/env precondition,
// 1 no server reachable.

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { spawnSync } from "node:child_process";

interface Probe {
    display: string;
    ok: boolean;
}

/** `xset -display <d> q` bounded by `timeout 2` (coreutils) so a hung
 *  probe never stalls the on-failure retry loop */
function probe(display: string): Probe {
    const r = spawnSync("timeout", ["2", "xset", "-display", display, "q"], {
        encoding: "utf8",
    });
    return { display, ok: (r.status ?? 1) === 0 };
}

export default defineCommand({
    name: "detect-server",
    description:
        "Detect the reachable X server (shared display probe; --persist-to-systemd exports DISPLAY to the user manager)",
    options: {
        "persist-to-systemd": option(z.boolean().optional(), {
            argumentKind: "flag" as const,
            description: "set DISPLAY in the systemd user manager environment (the single source of truth)",
        }),
        "dry-run": option(z.boolean().optional(), {
            argumentKind: "flag" as const,
            description: "print what would be persisted, change nothing",
        }),
    },
    handler: async ({ flags }) => {
        // candidate order: the session state first, then the WSL
        // conventions, then the default sockets (quirk: fallbacks are
        // localhost:0.0-style or bare ':N' — never 127.0.0.1:0)
        const seen = new Set<string>();
        const candidates: string[] = [];
        const push = (d: string | undefined): void => {
            if (d && !seen.has(d)) {
                seen.add(d);
                candidates.push(d);
            }
        };
        push(process.env.DISPLAY);
        push("localhost:0.0");
        push("localhost:1.0");
        push(":0");
        push(":1");

        // fast path: probe all candidates; the FIRST reachable wins
        let winner: string | undefined;
        const details: string[] = [];
        for (const c of candidates) {
            const p = probe(c);
            details.push(`${c}${p.ok ? "" : " (unreachable)"}`);
            if (p.ok) {
                winner = c;
                break;
            }
        }
        if (!winner) {
            console.error(`detect-server: no reachable X server — probed: ${details.join(", ")}`);
            process.exit(1);
        }
        console.log(winner);

        if (flags["persist-to-systemd"]) {
            if (flags["dry-run"]) {
                console.log(`    [dry-run] systemctl --user set-environment DISPLAY=${winner}`);
                return;
            }
            const r = spawnSync("systemctl", ["--user", "set-environment", `DISPLAY=${winner}`], {
                encoding: "utf8", stdio: "inherit",
            });
            if ((r.status ?? 1) !== 0) {
                console.error("detect-server: set-environment FAILED — the user units would not inherit DISPLAY" +
                    " (systemd user session required)");
                process.exit(1);
            }
        }
    },
});
