// src/commands/check.ts — report requirement state, install nothing.

import { defineCommand, option } from "@bunli/core";
import { say } from "../lib/lines";
import { z } from "zod";
import { checkDotsEnv, readRequires, missing, DOTS_DIR } from "../lib/dots";
import { resolvePackage, scriptPath } from "../lib/deployScript";

export interface CheckRow {
    binary: string;
    installed: boolean;
    pkg?: string;
    installCommand?: string;
    problem?: string;
}

/** The would-be install command (the deploy script only PRINTS it). */
async function previewInstall(target: string, binary: string): Promise<string | undefined> {
    const proc = Bun.spawn([scriptPath(target), "install", binary], {
        stdout: "pipe", stderr: "ignore",
    });
    const code = await proc.exited;
    const out = (await new Response(proc.stdout).text()).trim();
    return code === 0 ? out : undefined;
}

export async function collect(): Promise<{ rows: CheckRow[]; target: string }> {
    const requires = await readRequires();
    const gone = missing(requires.binaries);
    const rows: CheckRow[] = [];
    for (const binary of requires.binaries) {
        if (!gone.includes(binary)) {
            rows.push({ binary, installed: true });
            continue;
        }
        const res = await resolvePackage(requires.target, binary);
        if (res.ok) {
            rows.push({
                binary,
                installed: false,
                pkg: res.pkg,
                installCommand: await previewInstall(requires.target, binary),
            });
        } else {
            rows.push({ binary, installed: false, problem: res.problem });
        }
    }
    return { rows, target: requires.target };
}

export default defineCommand({
    name: "check",
    description: "Verify env + requirements",
    options: {
        json: option(z.boolean().optional(), { argumentKind: "flag" as const, description: "machine-readable output" }),
    },
    handler: async ({ flags }) => {
        const env = checkDotsEnv();
        if (!env.ok) {
            say(`on-deploy: ${env.problem}`);
            process.exit(2);
        }
        const { rows, target } = await collect();
        if (flags.json) {
            console.log(JSON.stringify({ target, rows }, null, 2));
        } else {
            console.log(`deploy target: ${target}`);
            for (const r of rows) {
                const state = r.installed
                    ? "installed"
                    : r.problem
                        ? `MISSING (${r.problem})`
                        : `MISSING -> ${r.pkg}`;
                console.log(`  ${r.binary.padEnd(20)} ${state}`);
            }
        }
        process.exit(rows.some((r) => !r.installed) ? 1 : 0);
    },
});
