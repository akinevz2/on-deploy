// src/lib/profile.ts — the deploy.profile manifest: which platform
// provisioning features the deployment wants.
//
//   # deploy.profile — one feature per line, '#' comments
//   xserver
//   xinitrc
//   greeter
//
// Absent file or empty = no provisioning (e.g. the WSL2 host: the X
// server is VcXsrv on Windows, reached over TCP — nothing to install).

import { join } from "node:path";
import { DOTS_DIR } from "./dots";

export const FEATURES = ["xserver", "xinitrc", "greeter"] as const;
export type Feature = (typeof FEATURES)[number];

export async function readProfile(file = "deploy.profile"): Promise<Feature[]> {
    const path = join(DOTS_DIR, file);
    const f = Bun.file(path);
    if (!(await f.exists())) return [];
    const out: Feature[] = [];
    for (const line of (await f.text()).split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const word = t.split(/\s+/)[0];
        if (!(FEATURES as readonly string[]).includes(word)) {
            throw new Error(`${file}: unknown feature '${word}' (known: ${FEATURES.join(", ")})`);
        }
        if (!out.includes(word as Feature)) out.push(word as Feature);
    }
    return out;
}
