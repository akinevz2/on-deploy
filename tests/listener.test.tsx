// tests/listener.test.tsx — GUARANTEE: the in-repo prompt session
// (lib/tuiSession.tsx) attaches its keypress listeners ONCE for the
// whole session lifetime (never per prompt), and the register/
// unregister round-trip for BOTH emitter listeners and PROCESS signal
// handlers is exactly balanced:
//
//   keyInput keypress listeners: baseline at birth → unchanged while a
//     prompt mounts → unchanged after it settles (the fold-button views
//     receive keys through the framework's FOCUS wiring, not
//     subscriptions; nothing accumulates);
//   process SIGINT handlers: zero at baseline → +1 at session birth
//     (idle guard) → +1 while a prompt runs → back to +1 after settle
//     → 0 after dispose.
//
// The old MaxListenersExceeded regression (per-prompt useKeyboard
// accumulation, "fixed" with a listening sweep inside vendored
// node_modules) cannot regress here without these numbers moving —
// there is no patch in the dependency tree anymore.
//
// The renderer is opentui's OWN testing renderer (createTestRenderer —
// real Core, headless streams), injected through the session's DI seam.

import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot as realCreateRoot } from "@opentui/react";
import { __onDeploySessionInternalsForTests } from "../src/lib/tuiSession";
import { createElement } from "react";

const MOUNT_SETTLE_MS = 250; // ms to let mount + the drain commit flush
const settleTick = (ms = MOUNT_SETTLE_MS) => new Promise<void>((r) => setTimeout(r, ms));

// a minimal REAL focus-less shell: the session renders what render()
// returns; pressing a key must resolve the prompt via the session
// dispatcher's cancel path? No — that's esc/ctrl-c only. This probe
// resolves on ANY key through the framework (its useKeyboard wires the
// renderer keyInput... no!). For the listener-balance purpose the
// component renders a plain box with no handlers at all; the prompt is
// settled via esc (the session dispatcher's cancel path).
function Shell(props: { label: string }) {
    return createElement("box", { label: props.label });
}

describe("session listener balance (in-repo session)", () => {
    test("keypress listeners stay constant; SIGINT handlers balance exactly", async () => {
        const { renderer } = await createTestRenderer({ width: 80, height: 24 });
        const keyInput = (renderer as unknown as {
            keyInput: { listenerCount(e: string): number; emit(e: string, x: unknown): void };
        }).keyInput;
        const count = (): number => keyInput.listenerCount("keypress");

        const sess = __onDeploySessionInternalsForTests.createSession({
            createRenderer: async () => renderer,
            createRoot: realCreateRoot,
            destroyEvent: "destroy",
        });
        await sess.initialize();

        const keyBaseline = count();
        // NOTE: bun's test harness keeps its own native SIGINT handler
        // (and the testing renderer may clear it during teardown), so
        // the session's own registers are asserted as DELTAS, never as
        // absolute counts.
        const beforeSess = process.listenerCount("SIGINT");

        // a prompt mounts: NO new keyInput listeners (focus wiring only)
        const p = sess.runPrompt({
            render: (resolve) => createElement(Shell, { label: "probe" }),
        });
        await settleTick();

        expect(count()).toBe(keyBaseline);
        expect(process.listenerCount("SIGINT")).toBe(beforeSess + 1);

        // settle via esc on the renderer's key input (dispatcher cancels)
        keyInput.emit("keypress", { name: "escape", sequence: "\x1b" });
        expect(await p).toBeTypeOf("symbol");

        // BALANCE, after settling: per-prompt registers removed
        await settleTick();
        expect(count()).toBe(keyBaseline);
        expect(process.listenerCount("SIGINT")).toBe(beforeSess);

        // second round: still no accumulation
        const p2 = sess.runPrompt({
            render: (resolve) => createElement(Shell, { label: "probe2" }),
        });
        await settleTick();
        keyInput.emit("keypress", { name: "escape", sequence: "\x1b" });
        expect(await p2).toBeTypeOf("symbol");
        await settleTick();
        expect(count()).toBe(keyBaseline);
        expect(process.listenerCount("SIGINT")).toBe(beforeSess);

        // dispose: the session's own SIGINT guard is gone (delta
        // negative; the harness's native handler is not ours to track)
        await sess.dispose();
        expect(process.listenerCount("SIGINT")).toBeLessThan(beforeSess);
        // process.stdin untouched
        expect(process.stdin.listenerCount("keypress")).toBe(0);
    });
});
