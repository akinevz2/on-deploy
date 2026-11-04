// tests/listener.test.tsx — GUARANTEE: every prompt the runtime session
// (open-tui-session) renders attaches its keypress listeners and
// removes them again, per prompt and across the whole session — the
// register/unregister round-trip must be EXACTLY balanced (the
// MaxListenersExceededWarning seen inside the preserve resolver was
// exactly this balance breaking).
//
// Expected shape per prompt:
//   before:      N keypress listeners on keyInput
//   mounted:     N + 2 (the session's global cancel handler + the
//                prompt view's own useKeyboard mount)
//   settled:     N again (the view unmounts, the global handler off's)
//
// The renderer is opentui's OWN testing renderer (createTestRenderer —
// real Core, headless streams; the same machinery the upstream tests
// use), and the prompt views mount through the REAL opentui-react
// createRoot/useKeyboard via the runtime's dependency-injection seam —
// so the test exercises the true mount → keypress → unmount path.

import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { useKeyboard, createRoot as realCreateRoot } from "@opentui/react";
import { __openTuiSessionInternalsForTests } from "@bunli/runtime/src/prompt/runtime/open-tui-session";
import { createElement } from "react";

// a minimal REAL component (the runtime's own views are the same shape)
// that attaches one keypress listener on mount via the shared
// useKeyboard hook and resolves the prompt when any key arrives
function KeyProbe(props: { resolve: (v: string) => void }) {
    useKeyboard(() => props.resolve("ok"));
    return null;
}

const MOUNT_SETTLE_MS = 250; // ms to let mount + the drain commit flush before asserting
const settleTick = (ms = MOUNT_SETTLE_MS) => new Promise<void>((r) => setTimeout(r, ms));
const RELEASE = "j"; // any non-cancel key: only the view's probe handles it

describe("runtime prompt listener balance", () => {
    test("per-prompt keypress listeners are removed when the prompt settles", async () => {
        const { renderer } = await createTestRenderer({
            width: 80, height: 24,
        });
        const session = __openTuiSessionInternalsForTests
            .createOpenTuiRendererSessionWithDependencies({
                createRenderer: async () => renderer,
                createReactRoot: realCreateRoot,
                destroyEvent: "destroy",
            });
        await session.initialize();

        const keyInput = (renderer as unknown as { keyInput: { listenerCount(e: string): number; maxListeners(): number; getMaxListeners(): number } }).keyInput;
        const count = (): number => keyInput.listenerCount("keypress");
        const baseline = count();

        const ROUNDS = 5;
        for (let i = 0; i < ROUNDS; i++) {
            const p = session.runPrompt({
                render: (resolve) => createElement(KeyProbe, { resolve: resolve as (v: string) => void }),
            });
            await settleTick();

            // BALANCE, while mounted: exactly THREE listeners exist —
            // the session global cancel handler + TWO hook consumers
            // (PromptCancelBoundary and the prompt view itself both
            // mount their useKeyboard)
            const mounted = count();
            expect(mounted - baseline).toBe(3);

            // settle via a plain key on the renderer's key input
            const ki = renderer as unknown as { keyInput: { emit(e: string, x: unknown): void } };
            ki.keyInput.emit("keypress", { name: RELEASE, sequence: RELEASE });
            await p;

            // BALANCE, after settling: unchanged from baseline — the
            // per-prompt mount removed its registers. The drain commit
            // (the session's own BUGFIX patch) runs on the next
            // macrotask; give it a tick.
            await settleTick();
            expect(count()).toBe(baseline);
        }

        // SIGINT handlers the session registers on the PROCESS must be
        // fully drained after dispose; the baseline is the INITIAL
        // state (zero for the session)
        await session.dispose();
        expect(process.listenerCount("SIGINT")).toBe(0);
        // process.stdin untouched — the session works through the
        // renderer keyInput, not through raw stdin listeners
        expect(process.stdin.listenerCount("keypress")).toBe(0);
    });
});
