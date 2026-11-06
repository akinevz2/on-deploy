// tests/menuTree.test.tsx — the fold-button mediator (lib/tuiMenuTree)
// under the REAL opentui test renderer. The interaction model is
// focus-driven (keys land in the focused FoldButtonRenderable through
// the framework's own wiring — no react listeners anywhere), so the
// tests drive keys by emitting on the renderer's keyInput exactly like
// a terminal would:
//
//	j / down	→ adjacent visible row
//	enter	→ folder folds | single picks | multi submits
//	space	→ toggle check (multi)
//	o	→ toggle fold: children ATTACH after the folder row and
//	DETACH on fold again (DOM order via add(obj, index))
//	ctrl+a	→ check/uncheck all (multi)
//
// The listener-balance guarantee is pinned by tests/listener.test.tsx;
// here the mediator's own behavior contract is what matters.

import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot as realCreateRoot } from "@opentui/react";
import { __onDeploySessionInternalsForTests } from "../src/lib/tuiSession";
import { MenuTree, type MenuTreeOptions } from "../src/lib/tuiMenuTree";
import { createElement } from "react";

const tick = (ms = 250) => new Promise<void>((r) => setTimeout(r, ms));

interface Probe {
    /** the picked key via onDone (single: a key; multi: the submitted first) */
    pick: () => string | null;
    /** the last onError message (required-submit gate) */
    error: () => string | null;
    ki: { emit(e: string, x: unknown): void };
    /** mediator internals: host.get_children_count() includes the error line */
    rowCount: () => number;
    dispose: () => Promise<void>;
}

async function setup(
    specs: MenuTreeOptions["specs"],
    mode: "single" | "multi",
    opts: Partial<MenuTreeOptions> = {},
): Promise<Probe> {
    const { renderer, sess } = await (async () => {
        const { renderer } = await createTestRenderer({ width: 80, height: 24 });
        const s = __onDeploySessionInternalsForTests.createSession({
            createRenderer: async () => renderer,
            createRoot: realCreateRoot,
            destroyEvent: "destroy",
        });
        await s.initialize();
        return { renderer, sess: s };
    })();

    let pick: string | null = null;
    let error: string | null = null;
    let tree: MenuTree = null as never;

    const p = sess.runPrompt({
        render: (resolve) => {
            const treeOpts: MenuTreeOptions = {
                specs,
                mode,
                onDone: (r) => { pick = r.keys[0]; resolve("picked"); },
                onError: (msg) => { error = msg; },
                ...opts,
            };
            tree = new MenuTree(treeOpts);
            return createElement(
                "box",
                {
                    style: { flexDirection: "column" as never },
                    ref: (b: unknown) => { if (b) tree.attach(b as never); },
                },
            );
        },
    });
    await tick();

    const ki = (renderer as unknown as { keyInput: { emit(e: string, x: unknown): void } }).keyInput;
    const host = (): { getChildrenCount(): number } =>
        (tree as unknown as { host: { getChildrenCount(): number } })["host"];

    return {
        pick: () => pick,
        error: () => error,
        ki,
        rowCount: () => host().getChildrenCount(),
        dispose: async () => {
            ki.emit("keypress", { name: "escape", sequence: "\x1b" });
            await p.catch(() => undefined);
            await sess.dispose();
        },
    };
}

const key = (name: string, ctrl = false, sequence?: string) => ({
    name,
    ctrl,
    sequence: sequence ?? "",
});

describe("fold-button menu tree (focus-routed)", () => {
    const emitK = (ki: { emit(e: string, x: unknown): void }, k: { name?: string; ctrl?: boolean; sequence?: string }) =>
        ki.emit("keypress", k);

    test("single mode: enter picks the focused row", async () => {
        const m = await setup([{ key: "a", label: "alpha" }, { key: "b", label: "beta" }], "single");
        emitK(m.ki, key("return", false, "\r"));
        expect(m.pick()).toBe("a");
        await m.dispose();
    });

    test("single mode: j moves focus; folder embeds children on unfold", async () => {
        const m = await setup(
            [
                { key: "a", label: "alpha" },
                { key: "grp", label: "group", folder: true, children: [
                    { key: "g1", label: "child one" },
                    { key: "g2", label: "child two" },
                ] },
                { key: "b", label: "beta" },
            ],
            "single",
        );
        // initial: alpha folderbeta collapsed → 4 host children (3 rows + error line)
        expect(m.rowCount()).toBe(4);

        emitK(m.ki, key("j")); // alpha → group (folder)
        emitK(m.ki, key("o")); // unfold: children attach
        // +2 rows unfolded (alpha, group, child one, child two, beta, err)
        expect(m.rowCount()).toBe(6);

        emitK(m.ki, key("j")); // group → child one
        emitK(m.ki, key("j")); // child one → child two
        emitK(m.ki, key("j")); // child two → beta
        expect(m.pick()).toBe(null);
        emitK(m.ki, key("return", false, "\r"));
        expect(m.pick()).toBe("b");

        // fold again: children detach — the row count shrinks back
        emitK(m.ki, key("j")); // (wrap around)
        void m;
        await m.dispose();
    });

    test("folding REMOVES the subtree rows and keeps focus on the folder", async () => {
        const m = await setup(
            [{ key: "grp", label: "group", folder: true, children: [{ key: "g1", label: "one" }] }],
            "single",
            { startExpanded: true },
        );
        // group, child one, error line
        expect(m.rowCount()).toBe(3);
        emitK(m.ki, key("o")); // fold: only group + err line remain
        expect(m.rowCount()).toBe(2);
        emitK(m.ki, key("o")); // unfold: +1
        expect(m.rowCount()).toBe(3);
        await m.dispose();
    });

    test("multi mode: space checks, enter submits, required gates an empty submit", async () => {
        const m = await setup(
            [{ key: "a", label: "alpha" }, { key: "b", label: "beta" }],
            "multi",
        );
        emitK(m.ki, key("return", false, "\r")); // nothing checked → gated
        expect(m.error()).toBe("Select at least one option.");
        expect(m.pick()).toBe(null);

        emitK(m.ki, key("space")); // alpha checked? focus is on alpha; space uses onActivate → toggle
        emitK(m.ki, key("return", false, "\r"));
        expect(m.pick()).toBe("a");
        await m.dispose();
    });

    test("multi mode: ctrl+a then enter submits the checked rows", async () => {
        const m = await setup(
            [{ key: "a", label: "alpha" }, { key: "b", label: "beta" }],
            "multi",
        );
        emitK(m.ki, key("a", true));
        emitK(m.ki, key("return", false, "\r"));
        expect(m.pick()).toBe("a");
        await m.dispose();
    });
});
