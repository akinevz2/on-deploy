// src/lib/tui.ts — the bunli-native TUI layer, driven through ONE
// long-lived opentui session.
//
// WHY the session lives HERE (not just inside @bunli/runtime/prompt):
// the runtime keeps a global session for the facade too, but under
// bun's run loop its per-prompt react unmount never drained — VERIFIED
// leak ([InternalKeyHandler] keypress listeners accumulate ~3/prompt
// inside the preserve resolver, MaxListenersExceeded). The runtime now
// carries the listener-sweep patch (patches/@bunli%2Fruntime@0.3.2.patch):
// baseline listeners at session birth, everything post-baseline swept
// at cleanup. lib/tui.ts guarantees the same sweep for the deep
// prompt APIs (and holds the session for the process lifetime).
//
// Contract (same as before, whiptail-compatible): prompts render their
// frames into the terminal scrollback sequentially; cancel
// (Esc/q/ctrl-c) maps to null/false; non-TTY callers must be guarded
// by the caller (exit 2 with a usage note instead of blocking).
//
// TSX support: tsconfig.json sets jsx=react-jsx +
// jsxImportSource=@opentui/react; src/lib/diffview.tsx renders a
// full-screen side-by-side/inline diff on a DEDICATED temporary
// renderer (which the user manually closes), for the preserve
// conflict resolver.

import {
    // relative src path: the package exports map does not expose the
    // prompt-session internals; ts typing comes from the ambient
    // declaration over the SAME specifier (with the path, in
    // src/types/bunli-runtime.d.ts)
    runOpenTuiConfirmPrompt,
    runOpenTuiSelectPrompt,
    runOpenTuiMultiSelectPrompt,
    runOpenTuiTextPrompt,
    createOpenTuiRendererSession,
    type OpenTuiRendererSession,
} from "../../node_modules/@bunli/runtime/src/prompt/runtime/open-tui-session.tsx";

let _session: OpenTuiRendererSession | null = null;

function ttyGate(): boolean {
    return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

function session(): OpenTuiRendererSession {
    if (!_session) {
        _session = createOpenTuiRendererSession();
        const teardown = () => {
            try {
                void _session?.dispose();
            } catch { /* exit-time best effort */ }
            _session = null;
        };
        process.once("exit", teardown);
        process.once("SIGINT", () => {
            void teardown();
            process.exit(130);
        });
        process.once("SIGTERM", () => {
            void teardown();
            process.exit(143);
        });
    }
    return _session;
}

export { ttyGate as isTTY };

interface OpenTuiOptionLike<T> { label: string; value: T; hint?: string }

function toOptions<T>(items: T[]): OpenTuiOptionLike<T>[] {
    return items.map((item) => {
        if (typeof item === "object" && item !== null) {
            const obj = item as { label?: string; hint?: string };
            return { label: obj.label ?? "", value: item, hint: obj.hint };
        }
        return { label: String(item), value: item };
    });
}

function cancelled(v: unknown): boolean {
    return v === null || v === undefined || typeof v === "symbol";
}

/** yes/no; non-TTY answers no (never blocks) */
export async function tuiYesNo(_prompt: unknown, message: string): Promise<boolean> {
    if (!ttyGate()) return false;
    return await runOpenTuiConfirmPrompt(
        { message, formatHistoryLine: (v) => (v ? "yes" : "no") },
        session(),
    ) === true;
}

/** checklist -> selected tags; null = cancelled */
export async function tuiChecklist<T = string>(
    _prompt: unknown, _title: string, message: string,
    items: T[], preselect: T[] = [],
): Promise<T[] | null> {
    void _title;
    if (!items.length) return [];
    if (!ttyGate()) return null;
    const r = await runOpenTuiMultiSelectPrompt<T>(
        { message, options: toOptions(items), initialValues: preselect },
        session(),
    );
    return cancelled(r) ? null : (r as T[]);
}

/** menu -> single tag; null = cancelled */
export async function tuiMenu<T = string>(
    _prompt: unknown, _title: string, message: string, items: T[],
): Promise<T | null> {
    void _title;
    if (!items.length) return null;
    if (!ttyGate()) return null;
    const r = await runOpenTuiSelectPrompt<T>(
        { message, options: toOptions(items) },
        session(),
    );
    return cancelled(r) ? null : (r as T);
}

/** text input; null = cancelled; non-TTY fails the caller's contract */
export async function tuiText(
    _prompt: unknown, message: string,
    opts: { placeholder?: string; defaultValue?: string; validate?: (v: string) => string | undefined } = {},
): Promise<string | null> {
    if (!ttyGate()) return null;
    const r = await runOpenTuiTextPrompt(
        {
            message,
            placeholder: opts.placeholder,
            defaultValue: opts.defaultValue,
            validate: opts.validate,
            formatHistoryLine: (v) => `> ${v}`,
        },
        session(),
    );
    return cancelled(r) ? null : (r as string);
}
