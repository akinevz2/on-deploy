// src/lib/tui.ts — the bunli-native TUI layer. @bunli/core hands every
// command handler a `prompt` (@bunli/runtime/prompt, rendered through
// opentui): text/confirm/select/multiselect/note. These wrappers give
// the old whiptail call shape (title/prompt/items → selection or null)
// with the SAME output-discipline contract:
//   - prompts render their own compact frames into the terminal
//     scrollback, Sequentially — no fullscreen takeover, so captured
//     per-package result blocks print cleanly after the last prompt.
//   - cancel (Esc/q/ctrl-c) maps to `null`/false exactly like whiptail
//     did; prompt.isCancel discriminates.
//   - non-TTY callers must be guarded by the caller (as before: exit 2
//     with a usage note instead of blocking).
//
// TSX support: tsconfig.json sets jsx=react-jsx +
// jsxImportSource=@opentui/react, and src/lib/diffview.tsx renders a
// full-screen side-by-side/inline diff through the open-tui session for
// the preserve conflict resolver.

import type { PromptApi } from "@bunli/core";

/** yes/no; non-TTY answers no (never blocks) */
export async function tuiYesNo(prompt: PromptApi, message: string): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    return await prompt.confirm(message, { default: false });
}

/** checklist -> selected tags; null = cancelled */
export async function tuiChecklist(
    prompt: PromptApi, _title: string, message: string, items: string[], preselect: string[] = [],
): Promise<string[] | null> {
    void _title;
    if (items.length === 0) return [];
    const sel = await prompt.multiselect(message, {
        options: items.map((label) => ({ label, value: label })),
        initialValues: preselect,
    });
    if (prompt.isCancel(sel)) return null;
    return sel;
}

/** menu -> single tag; null = cancelled */
export async function tuiMenu(
    prompt: PromptApi, _title: string, message: string, items: string[],
): Promise<string | null> {
    void _title;
    if (items.length === 0) return null;
    const sel = await prompt.select(message, {
        options: items.map((label) => ({ label, value: label })),
    });
    if (prompt.isCancel(sel)) return null;
    return sel;
}

/** text input; null = cancelled; non-TTY fails the caller's contract */
export async function tuiText(
    prompt: PromptApi, message: string, opts: { placeholder?: string; validate?: (v: string) => string | undefined } = {},
): Promise<string | null> {
    const v = await prompt.text(message, {
        placeholder: opts.placeholder,
        validate: opts.validate
            ? (input) => { const err = opts.validate!(input); return err ?? true; }
            : undefined,
    });
    if (prompt.isCancel(v)) return null;
    return v;
}
