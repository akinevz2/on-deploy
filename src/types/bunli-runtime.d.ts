// src/types/bunli-runtime.d.ts — the ambient declarations for the two
// runtime internals the TSX diff viewer uses. The package does not
// export subpaths below ./prompt — @bunli/runtime's own session file is
// imported by SPECIFIER (bun resolves the real files at runtime,
// including inside the compiled binary), and tsc accepts these ambient
// declarations when the module resolution fails through exports.
//
// Typed minimally (the viewer only needs create + runPrompt + dispose).

declare module "@bunli/runtime/dist/prompt/runtime/open-tui-session.js" {
    export interface OpenTuiRendererSession {
        initialize: () => Promise<void>;
        runPrompt: <T>(
            args: {
                render: (resolve: (value: T | symbol) => void) => unknown;
            },
        ) => Promise<T | symbol>;
        dispose: () => Promise<void>;
    }
    export function createOpenTuiRendererSession(): OpenTuiRendererSession;
}

declare module "@bunli/runtime/dist/prompt/runtime/open-tui-types.js" {
    export declare const OPEN_TUI_CANCEL: unique symbol;
    export type OpenTuiCancel = typeof OPEN_TUI_CANCEL;
}
