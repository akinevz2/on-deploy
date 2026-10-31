// src/lib/applyCore.ts — the apply engine, shared by the `apply` verb
// and the configure wizard: resolve the deploy target from the
// wm.requires manifest (the single deployment manifest) and run its
// GENERIC step list. Returns the failure count (caller exits).

import { checkDotsEnv, readRequires } from "./dots";
import { resolveTarget, targetSteps } from "./targets";

/** returns the number of FAILED steps */
export async function runApply(opts: { dryRun?: boolean } = {}): Promise<number> {
    const env = checkDotsEnv();
    if (!env.ok) {
        console.error(`on-deploy: ${env.problem}`);
        return 1;
    }
    let requires;
    try {
        requires = await readRequires();
    } catch (err) {
        console.error(`apply: ${(err as Error).message}`);
        return 1;
    }

    let tgt;
    try {
        tgt = resolveTarget(requires.target, requires.session);
    } catch (err) {
        console.error(`apply: ${(err as Error).message}`);
        return 1;
    }
    console.log(
        `apply: target=${tgt.key} pkgmgr=${tgt.pkgMgr}` +
        ` xserver=${tgt.externalXServer ? "external" : "managed"}`,
    );
    console.log(`apply: session=${requires.session}`);

    let failed = 0;
    for (const step of targetSteps(tgt, !!opts.dryRun)) {
        const s = await step.run();
        const mark = s.ok ? "ok" : "FAILED";
        console.log(`  ${step.name.padEnd(12)} ${mark} — ${s.detail}${s.problem ? ` (${s.problem})` : ""}`);
        if (!s.ok) failed += 1;
    }
    return failed;
}
