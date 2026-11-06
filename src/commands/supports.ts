// src/commands/supports.ts — print the supported surface of the managed
// layer: the deploy target family, the registered package-manager
// transports and their usability, plus the knob syntax the dots
// package Makefiles consume. Generated 1:1 from the catalogs in
// lib/pkgmanagers.ts (extending support = edit there, this stays in
// sync by construction).

import { defineCommand } from "@bunli/core";
import { readRequires } from "../lib/dots";
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
        console.log("on-deploy supports:");
        console.log(`  deploy target family : ${target ?? "(unknown)"}`);
        console.log("");
        console.log("  pkg-method transports (selected via the metadata repos_pkg):");
        for (const t of TRANSPORTS) {
            const usable = !t.families || (target !== null && t.families.includes(target as keyof typeof TARGET_FAMILY));
            const gate = t.families ? ` [families: ${t.families.join(", ")}]` : "";
            console.log(`    ${t.id.padEnd(8)} ${usable ? "usable" : "NOT usable here"}${gate}`);
            console.log(`    ${" ".repeat(8)} note: ${t.missing}`);
        }
        console.log("");
        console.log(`  registered ids : ${transportIds().join(" ")}`);
        console.log("  knob syntax    : <PKG>=source|pkg");
        console.log("  extend support : lib/pkgmanagers.ts — implement PkgManagerSpec, append to TRANSPORTS");
        console.log(`  families       : ${Object.keys(TARGET_FAMILY).join(" ")}`);
    },
});
