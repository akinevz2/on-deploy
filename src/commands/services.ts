// src/commands/services.ts — the services.depends runner. The dots Makefile
// DELEGATES here: enable/start/stop/restart over the units listed in
// services.depends (repo-level manifest, whitespace-split, start order).
//
//	on-deploy services check	daemon-reload + enable --now each unit
//	on-deploy services start	start each unit (reset-failed first)
//	on-deploy services stop	drop .wants links + cancel jobs + stop
//	on-deploy services restart	restart each unit
//	on-deploy services status	is-active per unit
//
// Non-interactive runs REQUIRE --yes (start/stop/restart confirm on a
// tty; nothing hangs on stdin). NO package knowledge: the unit list
// comes entirely from services.depends (the runner lives in
// lib/services.ts, shared with the `deploy` menu).

import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { checkDotsEnv } from "../lib/dots";
import {
    readServiceOrder, unitify, runServicesAction, SERVICES_ACTIONS,
    type ServicesAction,
} from "../lib/services";
import { say } from "../lib/lines";
import { flush, tell } from "../lib/out";

export default defineCommand({
    name: "services",
    description: "Systemd unit actions",
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
        const action = raw as ServicesAction;
        if (!SERVICES_ACTIONS.includes(action)) {
            // [FLUSH-CLASS: exit] usage report — exit code carries severity
            say(`services: ${raw || "(no action)"} is not a services action`);
            say("services:\tusage\ton-deploy services <action> [--yes]");
            say("services:\thelp\ton-deploy services help");
            process.exit(2);
        }
        const order = readServiceOrder();
        if (order.length === 0) {
            // [FLUSH-CLASS: exit] precondition failure — exit code
            // carries severity
            say("services: empty or missing services.depends");
            process.exit(2);
        }
        const units = unitify(order);
        const yes = !!flags.yes;

        // confirm on interactive terminals for start/stop/restart — the
        // Makefile may need to run these non-interactively, so --yes
        // bypasses; non-tty without --yes aborts (nothing hangs)
        if ((action === "start" || action === "stop" || action === "restart") && !yes) {
            if (!process.stdin.isTTY) {
                // [FLUSH-CLASS: exit] abort report — exit code carries severity
                say("services: non-interactive without --yes — aborting");
                process.exit(1);
            }
            // [FLUSH-CLASS: prompt] the unit list must be on the terminal
            // BEFORE the stdin read below — buffering here would freeze
            // the run with a silent, answerable question
            flush(tell(`services: ${units.join(" ")}`));
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
                // [FLUSH-CLASS: exit] cancellation is the whole
                // transcript; the handler returns, nothing runs after
                flush(tell("services: cancelled"));
                return;
            }
        }

        const failed = runServicesAction(action, units);
        if (failed > 0) process.exit(1);
    },
});
