// src/commands/supports.ts — print the supported surface of the managed
// layer: the deploy target family, the registered package-manager
// transports and their usability, plus the knob syntax the dots
// package Makefiles consume. Generated 1:1 from the catalogs in
// lib/pkgmanagers.ts (extending support = edit there, this stays in
// sync by construction).

import { defineCommand } from "@bunli/core";
import { readRequires } from "../lib/dots";
import { flush, tell } from "../lib/out";
import {
    TARGET_FAMILY,
    TRANSPORTS,
    transportIds,
} from "../lib/pkgmanagers";

export default defineCommand({
    name: "supports",
    description: "Show knob + method syntax",
    handler: async () => {
        const { target } = await readRequires().catch(() => ({ target: null }) as { target: string | null });
        // [FLUSH-CLASS: buffered] the whole surface report is built as
        // an Out — nothing spawns with inherited stdio here
        const lines: string[] = [];
        lines.push("on-deploy supports:");
        lines.push(`  deploy target family : ${target ?? "(unknown)"}`);
        lines.push("");
        lines.push("  pkg-method transports (selected via the metadata repos_pkg):");
        for (const t of TRANSPORTS) {
            const usable = !t.families || (target !== null && t.families.includes(target as keyof typeof TARGET_FAMILY));
            const gate = t.families ? ` [families: ${t.families.join(", ")}]` : "";
            lines.push(`    ${t.id.padEnd(8)} ${usable ? "usable" : "NOT usable here"}${gate}`);
            lines.push(`    ${" ".repeat(8)} note: ${t.missing}`);
        }
        lines.push("");
        lines.push(`  registered ids : ${transportIds().join(" ")}`);
        lines.push("  knob syntax    : <PKG>=source|pkg");
        lines.push("  extend support : lib/pkgmanagers.ts — implement PkgManagerSpec, append to TRANSPORTS");
        lines.push(`  families       : ${Object.keys(TARGET_FAMILY).join(" ")}`);
        // [FLUSH-CLASS: exit] the buffered report flushes here — after
        // this point only the exit code speaks
        flush(tell(...lines));
    },
});
