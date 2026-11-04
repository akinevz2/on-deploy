// src/types/bunli-runtime.d.ts — ambient declarations for the runtime
// internals used directly. The package does not export subpaths below
// ./prompt — the session module is imported by deep SPECIFIER both
// through the node_modules source path (tests + lib/tui.ts) and the
// dist bundle path (inside the compiled binary); bun resolves the real
// files at runtime, tsc takes these declarations.
//
// Typed minimally — create + runPrompt + dispose, plus the single-view
// prompt runners lib/tui.ts drives through ONE shared session.

declare module "@bunli/runtime/src/prompt/runtime/open-tui-session" {
    export interface OpenTuiRendererSession {
        initialize: () => Promise<void>;
        runPrompt: <T>(
            args: {
                render: (resolve: (value: T | symbol) => void) => unknown;
                formatHistoryLine?: (value: T) => string | undefined;
            },
        ) => Promise<T | symbol>;
        appendHistoryLines: (lines: string[]) => void;
        setHistorySection: (key: string, lines: string[]) => void;
        renderStatusLine: (content: string, fg?: string) => void;
        clearStatusLine: () => void;
        flushHistoryToStdout: () => void;
        dispose: () => Promise<void>;
    }
    export interface OpenTuiTriggerlessOption<T = string> {
        label: string;
        value: T;
        hint?: string;
        disabled?: boolean;
    }
    export function createOpenTuiRendererSession(): OpenTuiRendererSession;
    export function createOpenTuiRendererSessionWithDependencies(deps: {
        createRenderer: unknown;
        createReactRoot: unknown;
        destroyEvent: string;
    }): OpenTuiRendererSession;
    export function runOpenTuiTextPrompt(
        args: {
            message: string;
            placeholder?: string;
            defaultValue?: string;
            validate?: (value: string) => string | undefined;
            formatHistoryLine?: (value: string) => string | undefined;
        },
        session?: OpenTuiRendererSession,
    ): Promise<string | symbol>;
    export function runOpenTuiConfirmPrompt(
        args: {
            message: string;
            initialValue?: boolean;
            formatHistoryLine?: (value: boolean) => string | undefined;
        },
        session?: OpenTuiRendererSession,
    ): Promise<boolean | symbol>;
    export function runOpenTuiSelectPrompt<T = string>(
        args: {
            message: string;
            options: OpenTuiTriggerlessOption<T>[];
            initialValue?: T;
            formatHistoryLine?: (value: T) => string | undefined;
        },
        session?: OpenTuiRendererSession,
    ): Promise<T | symbol>;
    export function runOpenTuiMultiSelectPrompt<T = string>(
        args: {
            message: string;
            options: OpenTuiTriggerlessOption<T>[];
            initialValues?: T[];
            required?: boolean;
            ordered?: boolean;
            height?: number;
            formatHistoryLine?: (value: T[]) => string | undefined;
        },
        session?: OpenTuiRendererSession,
    ): Promise<T[] | symbol>;
}

declare module "@bunli/runtime/dist/prompt/runtime/open-tui-session.js" {
    export function createOpenTuiRendererSession(): unknown;
}

declare module "@bunli/runtime/dist/prompt/runtime/open-tui-types.js" {
    export declare const OPEN_TUI_CANCEL: unique symbol;
    export type OpenTuiCancel = typeof OPEN_TUI_CANCEL;
}
