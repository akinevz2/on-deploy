// src/lib/tui.ts — the bunli-native TUI layer's public wrappers.
//
// The session (lib/tuiSession.tsx) + fold-button views
// (lib/tuiMenuTree.tsx / lib/tuiViews.tsx) are framework-native:
// esc/ctrl-c/ctrl-d are owned by the session dispatcher, everything
// else by the FOCUSED FoldButton through the framework's focus routing.
// Cancel (esc/q? no — esc only, plus ctrl-c, plus ctrl-d in menus)
// maps to null/false, exactly the whiptail-era contract:
//
//   tuiSelect(msg, items)      → item | null (cancelled)
//   tuiChecklist(msg, items)   → T[] | null
//   tuiYesNo(msg, initialValue)→ boolean | null
//   tuiText(msg, opts)         → string | null
//
// Non-TTY callers are gated (return null instead of blocking).

import {
    session,
} from "./tuiSession";
export { releaseTui } from "./tuiSession";
import {
    MenuTree,
    type MenuTreeOptions,
    type RowSpec,
} from "./tuiMenuTree";
import {
    TuiMenuView,
    TuiTextView,
} from "./tuiViews";

interface OptionLike<T> { label: string; value: T; hint?: string }

/** tty gate: TUI prompts render only on real terminals */
export function isTTY(): boolean {
    return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

type Rows<T> = OptionLike<T>[];

const MENU_HINT = "Up/Down or j/k • Enter select • Esc cancel";
const CHECK_HINT = "Space toggle • o fold/unfold • Ctrl+A all • Enter submit • Esc cancel";
const CONFIRM_HINT = "Up/Down • Enter select • Esc cancel";
const SUBMIT_HINT = "Enter submits the checked items";

function history(question: string, answer: string): string {
    return `◇ ${question} ▸ ${answer}`;
}

/* ── select ──────────────────────────────────────────────────────────────── */

export async function tuiSelect<T>(
    message: string,
    items: Rows<T>,
    opts: { initialValue?: T } = {},
): Promise<T | null> {
    if (items.length === 0) return null;
    if (!isTTY()) return null;
    const se = session();
    const byKey = new Map<string, T>(items.map((i) => [String(i.value), i.value]));
    const specs: RowSpec[] = items.map((i) => ({
        key: String(i.value),
        label: i.label,
        hint: i.hint,
    }));
    const initialValue = opts.initialValue !== undefined ? String(opts.initialValue) : undefined;

    const res = await se.runPrompt<T>({
        formatHistoryLine: (v: T) => history(message, itemLabel(items, v)),
        render: (resolve) => {
            const treeOpts: MenuTreeOptions = {
                specs,
                mode: "single",
                initialKey: initialValue,
                onDone: ({ keys }) => resolve(byKey.get(keys[0]) as T),
                onError: () => {},
            };
            return (
                <TuiMenuView<T> message={message} options={treeOpts} hint={MENU_HINT} resolve={resolve} />
            );
        },
    });
    if (typeof res === "symbol") {
        se.appendHistoryLines([`WARN ${message}: cancelled`]);
        return null;
    }
    return res;
}

function itemLabel<T>(items: Rows<T>, value: T): string {
    return items.find((i) => i.value === value)?.label ?? String(value);
}

/* ── checklist (multi select) ────────────────────────────────────────────── */

export interface CheckItem<T> { label: string; value: T; hint?: string }

export async function tuiChecklist<T>(
    message: string,
    items: CheckItem<T>[],
    opts: { preselect?: T[]; required?: boolean } = {},
): Promise<T[] | null> {
    if (items.length === 0) return [];
    if (!isTTY()) return null;
    const se = session();
    const byKey = new Map<string, T>(items.map((i) => [String(i.value), i.value]));
    const preselect = new Set((opts.preselect ?? []).map(String));
    const specs: RowSpec[] = items.map((i) => ({
        key: String(i.value),
        label: i.label,
        hint: i.hint,
        checked: preselect.has(String(i.value)),
    }));
    const checkedLabel = (keys: string[]) =>
        keys.map((k) => itemLabel(items as Rows<T>, byKey.get(k) as T)).join(", ") || "(none)";

    const res = await se.runPrompt<T[]>({
        formatHistoryLine: (v: T[]) =>
            history(message, v.map((v) => itemLabel(items as Rows<T>, v)).join(", ") || "(none)"),
        render: (resolve) => {
            const treeOpts: MenuTreeOptions = {
                specs,
                mode: "multi",
                required: opts.required,
                startExpanded: false,
                onDone: ({ keys }) => {
                    const picked = keys.map((k) => byKey.get(k) as T).filter((v) => v !== undefined);
                    resolve(picked);
                },
                onError: () => {},
            };
            void checkedLabel;
            return (
                <TuiMenuView<T[]> message={message} options={treeOpts} hint={CHECK_HINT} resolve={resolve} />
            );
        },
    });
    if (typeof res === "symbol") {
        se.appendHistoryLines([`WARN ${message}: cancelled`]);
        return null;
    }
    return res;
}

/* ── confirm ─────────────────────────────────────────────────────────────── */

export async function tuiYesNo(
    message: string,
    opts: { initialValue?: boolean } = {},
): Promise<boolean | null> {
    if (!isTTY()) return null;
    const se = session();
    const items: CheckItem<boolean>[] = [
        { label: "Yes", value: true },
        { label: "No", value: false },
    ];
    return await tuiSelect<boolean>(message, items, {
        initialValue: opts.initialValue ?? true,
    });

}

/* ── text ────────────────────────────────────────────────────────────────── */

export async function tuiText(
    message: string,
    opts: { placeholder?: string; defaultValue?: string; validate?: (v: string) => string | undefined } = {},
): Promise<string | null> {
    if (!isTTY()) return null;
    const se = session();
    const okToHistory = opts.defaultValue !== undefined;

    const res = await se.runPrompt<string>({
        formatHistoryLine: (v: string) => history(message, v || (okToHistory ? "(default)" : "(empty)")),
        render: (resolve) => (
            <TuiTextView
                message={message}
                placeholder={opts.placeholder}
                defaultValue={opts.defaultValue}
                validate={opts.validate}
                resolve={resolve}
            />
        ),
    });
    if (typeof res === "symbol") {
        se.appendHistoryLines([`WARN ${message}: cancelled`]);
        return null;
    }
    return res;
}

export { SUBMIT_HINT };
