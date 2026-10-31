// src/lib/profile.ts — the deployment profile manifest.
//
//   session = greetd | wsl-systemd | xinit | nested
//   features = xserver xinitrc greeter        (space-separated, optional)
//   units = herbst compton dunst ...          (systemd user units to enable)
//   env = DISPLAY=localhost:0.0               (repeated lines allowed)
//
// session: HOW the graphical session starts
//   - greetd       a display manager owns the console (bare-OS targets)
//   - wsl-systemd  NO display manager: hlwm runs as the systemd user
//                  unit herbst.service, waiting for the Windows-side X
//                  server (VcXsrv) to be reachable — the WSL bypass
//   - xinit        startx runs ~/.xinitrc (exec herbstluftwm); no DM
//   - nested       hlwm inside the Xvfb framebuffer (:1), shared over
//                  VNC (:5900) + browser noVNC (:6080) — the temporary
//                  profile, co-installable with a primary one
//
// env lines are written to ~/.config/doftiles/env by provision; the
// units read it via EnvironmentFile (profile DISPLAY overrides the
// hardcoded WSL default). units are enabled additively — activating a
// second profile does not disable the first's units.

import { join } from "node:path";
import { DOTS_DIR } from "./dots";

export const FEATURES = ["xserver", "xinitrc", "greeter", "nested"] as const;
export type Feature = (typeof FEATURES)[number];

export type SessionModel = "greetd" | "wsl-systemd" | "xinit" | "nested";
const SESSIONS: ReadonlySet<string> = new Set([
    "greetd", "wsl-systemd", "xinit", "nested",
]);

export interface Profile {
    features: Feature[];
    session: SessionModel;
    /** systemd user units this profile enables */
    units: string[];
    /** env lines written to ~/.config/doftiles/env (KEY=VALUE) */
    env: string[];
}

export async function readProfile(file = "deploy.profile"): Promise<Profile> {
    const path = file.includes("/")
        ? join(DOTS_DIR, file)
        : join(DOTS_DIR, file);
    const f = Bun.file(path);
    if (!(await f.exists())) return { features: [], session: "wsl-systemd", units: [], env: [] };

    const features: Feature[] = [];
    let session: SessionModel | null = null;
    const units: string[] = [];
    const env: string[] = [];

    for (const line of (await f.text()).split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const kv = t.match(/^(\w+)\s*=\s*(.+)$/);
        if (kv) {
            const key = kv[1];
            const val = kv[2].trim();
            if (key === "session") {
                if (!SESSIONS.has(val)) {
                    throw new Error(
                        `${file}: unknown session model '${val}' (${[...SESSIONS].join(" | ")})`,
                    );
                }
                session = val as SessionModel;
            } else if (key === "features") {
                for (const w of val.split(/\s+/)) {
                    if (!(FEATURES as readonly string[]).includes(w)) {
                        throw new Error(
                            `${file}: unknown feature '${w}' (known: ${FEATURES.join(", ")})`,
                        );
                    }
                    if (!features.includes(w as Feature)) features.push(w as Feature);
                }
            } else if (key === "units") {
                for (const u of val.split(/\s+/)) {
                    if (u && !units.includes(u)) units.push(u);
                }
            } else if (key === "env") {
                if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(val)) {
                    throw new Error(`${file}: malformed env line '${val}' (want KEY=VALUE)`);
                }
                env.push(val);
            } else {
                throw new Error(`${file}: unknown key '${key}' (session | features | units | env)`);
            }
            continue;
        }
        // bare feature words stay supported (the original one-per-line form)
        const word = t.split(/\s+/)[0];
        if (!(FEATURES as readonly string[]).includes(word)) {
            throw new Error(`${file}: unknown feature '${word}' (known: ${FEATURES.join(", ")})`);
        }
        if (!features.includes(word as Feature)) features.push(word as Feature);
    }

    // model resolution: an explicit session line wins; greeter implies
    // greetd; otherwise wsl-systemd (the historical default)
    const model: SessionModel =
        session ?? (features.includes("greeter") ? "greetd" : "wsl-systemd");
    if (model !== "greetd" && features.includes("greeter")) {
        throw new Error(
            `${file}: session = ${model} conflicts with the greeter feature (greetd owns the console)`,
        );
    }
    return { features, session: model, units, env };
}
