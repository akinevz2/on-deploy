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

/** HOW the graphical session starts:
 *  - greetd       a display manager owns the console (bare-OS targets)
 *  - wsl-systemd  NO display manager: hlwm runs as the systemd user
 *                 unit herbst.service, which waits for the Windows-side
 *                 X server (VcXsrv) to be reachable — the WSL bypass */
export type SessionModel = "greetd" | "wsl-systemd";

export interface Profile {
    features: Feature[];
    session: SessionModel;
}

export async function readProfile(file = "deploy.profile"): Promise<Profile> {
    const path = join(DOTS_DIR, file);
    const f = Bun.file(path);
    if (!(await f.exists())) return { features: [], session: "wsl-systemd" };
    const out: Feature[] = [];
    let session: SessionModel | null = null;
    for (const line of (await f.text()).split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const kv = t.match(/^(\w+)\s*=\s*(\S+)$/);
        if (kv) {
            if (kv[1] !== "session") {
                throw new Error(`${file}: unknown key '${kv[1]}' (only session=)`);
            }
            if (kv[2] !== "greetd" && kv[2] !== "wsl-systemd") {
                throw new Error(`${file}: unknown session model '${kv[2]}' (greetd | wsl-systemd)`);
            }
            session = kv[2];
            continue;
        }
        const word = t.split(/\s+/)[0];
        if (!(FEATURES as readonly string[]).includes(word)) {
            throw new Error(`${file}: unknown feature '${word}' (known: ${FEATURES.join(", ")})`);
        }
        if (!out.includes(word as Feature)) out.push(word as Feature);
    }
    // model resolution: an explicit session line wins; greeter implies
    // greetd; anything else defaults to the WSL systemd bypass
    const model: SessionModel =
        session ?? (out.includes("greeter") ? "greetd" : "wsl-systemd");
    if (model === "wsl-systemd" && out.includes("greeter")) {
        throw new Error(`${file}: session = wsl-systemd conflicts with the greeter feature`);
    }
    return { features: out, session: model };
}
