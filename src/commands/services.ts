// src/commands/services.ts — the services.required runner. The dots Makefile
// DELEGATES here: enable/start/stop/restart over the units listed in
// services.required (repo-level manifest, whitespace-split, start order).
//
//	on-deploy services check	daemon-reload + enable --now each unit
//	on-deploy services start	start each unit (reset-failed first)
//	on-deploy services stop	drop .wants links + cancel jobs + stop
//	on-deploy services restart	restart each unit
//	on-deploy services status	is-active per unit
//
// Non-interactive runs REQUIRE --yes (start/stop/restart confirm on a
// tty; nothing hangs on stdin). NO package knowledge: the unit list
// comes entirely from services.required (the runner lives in
// lib/services.ts, shared with the `deploy` menu).

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { checkDotsEnv } from "../lib/dots";
import {
    readServiceOrder, unitify, runServicesAction, SERVICES_ACTIONS,
    type ServicesAction,
} from "../lib/services";
import { echoHelpList, say } from "../lib/lines";

export default defineCommand({
    name: "services",
    description:
        "Control services.required units over systemd (--user, --no-block, stow-safe disable)",
    options: {
        yes: option(z.boolean().optional(), { argumentKind: "flag" as const,
            description: "no confirmation (non-interactive)",
            short: "y",
        }),
    },
    handler: async ({ flags, positional }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            say(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const raw = positional[0] ?? "";
        if (raw === "help") {
            echoHelpList("services", "usage\ton-deploy services <action> [--yes]", [
                "check\treload + enable --now, no-op when active",
                "start\treset-failed then start each unit",
                "stop\tcancel jobs, drop the wants links, stop",
                "restart\trestart each unit in the order",
                "status\tis-active per unit",
            ]);
            process.exit(0);
        }
        const action = raw as ServicesAction;
        if (!SERVICES_ACTIONS.includes(action)) {
            say(`services: ${raw || "(no action)"} is not a services action`);
            say("services:\tusage\ton-deploy services <action> [--yes]");
            say("services:\thelp\ton-deploy services help");
            process.exit(2);
        }
        const order = readServiceOrder();
        if (order.length === 0) {
            say("services: empty or missing services.required");
            process.exit(2);
        }
        const units = unitify(order);
        const yes = !!flags.yes;

        // confirm on interactive terminals for start/stop/restart — the
        // Makefile may need to run these non-interactively, so --yes
        // bypasses; non-tty without --yes aborts (nothing hangs)
        if ((action === "start" || action === "stop" || action === "restart") && !yes) {
            if (!process.stdin.isTTY) {
                say("services: non-interactive without --yes — aborting");
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

        const failed = runServicesAction(action, units);
        if (failed > 0) process.exit(1);
    },
});
