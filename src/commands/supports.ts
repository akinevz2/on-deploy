// src/commands/supports.ts — the supported surface of the managed
// layer: the deploy target family, the registered transports and their
// usability. Generated 1:1 from the catalogs in lib/pkgmanagers.ts —
// extending support = add the transport there, this stays in sync by
// construction.
//
// Output shape: values only, one per line, the order implicit:
//	1 the deploy target family
//	2.. the transports: usable / NOT usable here (families), then
//	a note line with what a missing transport would ask for
//	3 the managers row
//	4 the families row

import { defineCommand } from "@bunli/core";
import { readRequires } from "../lib/dots";
import {
	TARGET_FAMILY,
	TRANSPORTS,
	transportIds,
} from "../lib/pkgmanagers";

export default defineCommand({
	name: "supports",
	description: "Print supported package managers and system families",
	handler: async () => {
		const { target } = await readRequires().catch(() => ({ target: null }) as { target: string | null });
		console.log("\tdeploy target family:\t" + (target ?? "(unknown)"));
		for (const t of TRANSPORTS) {
			const usable = !t.families || (target !== null && t.families.includes(target as keyof typeof TARGET_FAMILY));
			console.log(`\t${t.id}\t${usable ? "usable" : "NOT usable here"} (${t.missing.split(" not on PATH")[0]})`);
		}
		console.log(`\tsupported managers:\t${transportIds().join(", ")}`);
		console.log(`\tfamilies:\t${Object.keys(TARGET_FAMILY).join(", ")}`);
	},
});
