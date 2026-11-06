// src/lib/configureCore.ts — the apply engine, shared by the `configure`
// verb (after its edits are saved) and the wizard path: resolve the
// deploy target from the wm.depends manifest (the single deployment
// manifest) and run its GENERIC step list. Returns the failure count
// (caller exits).
//
// (was lib/applyCore.ts backing the `apply` verb; `apply` was folded
// into `configure` — configuring now APPLIES itself.)

import { checkDotsEnv, readRequires } from "./dots";
import { say } from "../lib/lines";
import { resolveTarget, targetSteps } from "./targets";

/** returns the number of FAILED steps */
export async function runApply(opts: { dryRun?: boolean } = {}): Promise<number> {
    const env = checkDotsEnv();
    if (!env.ok) {
        say(`on-deploy: ${env.problem}`);
        return 1;
    }
    let requires;
    try {
        requires = await readRequires();
    } catch (err) {
        say(`configure: ${(err as Error).message}`);
        return 1;
    }

    let tgt;
    try {
        tgt = resolveTarget(requires.target, requires.session);
    } catch (err) {
        say(`configure: ${(err as Error).message}`);
        return 1;
    }
    console.log(
        `configure: target=${tgt.key} pkgmgr=${tgt.pkgMgr}` +
        ` xserver=${tgt.externalXServer ? "external" : "managed"}`,
    );
    console.log(`configure: session=${requires.session}`);

    let failed = 0;
    for (const step of targetSteps(tgt, !!opts.dryRun)) {
        const s = await step.run();
        const mark = s.ok ? "ok" : "FAILED";
        console.log(`  ${step.name.padEnd(12)} ${mark} — ${s.detail}${s.problem ? ` (${s.problem})` : ""}`);
        if (!s.ok) failed += 1;
    }
    return failed;
}
