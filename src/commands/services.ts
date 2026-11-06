// src/commands/services.ts — the services.required runner. The dots Makefile
// DELEGATES here: enable/start/stop/restart over the units listed in
// services.required (repo-level manifest, whitespace-split, start order).
//
//   on-deploy services check      daemon-reload + enable --now each unit
//   on-deploy services start      start each unit (reset-failed first)
//   on-deploy services stop       drop .wants links + cancel jobs + stop
//   on-deploy services restart    restart each unit
//   on-deploy services status     is-active per unit
//
// Non-interactive runs REQUIRE --force (start/stop/restart confirm on a
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

export default defineCommand({
    name: "services",
    description:
        "Control services.required units via systemd:\n"
        + "check|start|stop|restart|statu ",
    options: {
        force: option(z.boolean().optional(), {
            argumentKind: "flag" as const,
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
        const action = (positional[0] ?? "") as ServicesAction;
        if (!SERVICES_ACTIONS.includes(action)) {
            console.error(`services: usage: on-deploy services <${SERVICES_ACTIONS.join("|")}> [--force]`);
            process.exit(2);
        }
        const order = readServiceOrder();
        if (order.length === 0) {
            console.error("services: services.required is empty or missing");
            process.exit(2);
        }
        const units = unitify(order);
        const force = !!flags.force;

        // confirm on interactive terminals for start/stop/restart — the
        // Makefile may need to run these non-interactively, so --force
        // bypasses; non-tty without --force aborts (nothing hangs)
        if ((action === "start" || action === "stop" || action === "restart") && !force) {
            if (!process.stdin.isTTY) {
                console.error("services: aborting, non-interactive without --force");
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
