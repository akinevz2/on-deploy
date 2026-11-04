// src/lib/tuiViews.tsx — the prompt views. Framework-native by design:
// every interactive row is a FoldButtonRenderable (focusable, key
// handling inside the focused button itself — see lib/tuiMenuTree.tsx),
// so these components hold ZERO react key handlers and ZERO react
// interaction state. React renders the static shell (message, row
// container, hint); the MenuTree mediator owns all interaction state
// imperatively. The single-line text prompt stays on the native
// <input> (framework focus-routed editing + submit).
//
// TuiMenuView creates its MenuTree exactly once per prompt (useRef),
// so a re-render never rebuilds or re-seeds interaction state; the
// mediator's attach() additionally guards repeat ref invocations.

/** @jsxImportSource @opentui/react */
import { useRef, useState } from "react";
import type { BoxRenderable } from "@opentui/core";

import {
    MenuTree,
    type MenuTreeOptions,
} from "./tuiMenuTree";

const TEXT = "#f4f7fb";
const MUTED = "#8fa1b5";
const ERROR = "#ff6b6b";

/** menus, checklists, confirms — one mediator-driven shell */
export function TuiMenuView<T>(props: {
    message: string;
    options: MenuTreeOptions;
    hint: string;
    resolve: (value: T | symbol) => void;
}) {
    const { message, options, hint, resolve } = props;
    void resolve; // the mediator's onDone is wired by the wrapper
    const treeRef = useRef<MenuTree | null>(null);
    if (!treeRef.current) treeRef.current = new MenuTree(options);
    const tree = treeRef.current;

    return (
        <box style={{ flexDirection: "column", gap: 1 }}>
            <text content={`? ${message}`} fg={TEXT} />
            <box
                style={{ flexDirection: "column", gap: 0 }}
                ref={(b: BoxRenderable | null) => {
                    if (b) tree.attach(b);
                }}
            />
            <text content={hint} fg={MUTED} />
        </box>
    );
}

// ── text (single line; the on-deploy flows only need that) ────────────────

export function TuiTextView(props: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    validate?: (value: string) => string | undefined;
    resolve: (value: string | symbol) => void;
}) {
    const { message, placeholder, defaultValue = "", validate, resolve } = props;
    const [error, setError] = useState<string | undefined>();

    const submit = (submitted: unknown) => {
        const value = typeof submitted === "string" ? submitted : defaultValue;
        const validationError = validate?.(value);
        if (validationError) {
            setError(validationError);
            return;
        }
        resolve(value);
    };

    return (
        <box style={{ flexDirection: "column", gap: 1 }}>
            <text content={`? ${message}`} fg={TEXT} />
            <input
                value={defaultValue}
                placeholder={placeholder}
                focused
                onChange={() => { if (error) setError(undefined); }}
                onSubmit={submit}
            />
            {error ? (
                <text content={`ERR ${error}`} fg={ERROR} />
            ) : (
                <text content="Enter submit • Esc cancel" fg={MUTED} />
            )}
        </box>
    );
}
