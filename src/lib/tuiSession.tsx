// src/lib/tuiSession.tsx — the in-repo opentui prompt session.
//
// WHY this exists: the bunli runtime's vendored prompt views register
// react useKeyboard listeners PER PROMPT, and in this environment react
// unmount commits run out of band and never flush their passive
// cleanups — the listeners accumulated until MaxListenersExceeded
// (~3 prompts). The old workaround patched node_modules (a listener
// sweep). The patch is GONE: the runtimes/dependencies are pristine and
// the machinery lives HERE instead.
//
//  1. ONE long-lived renderer AND one react root; the ONLY keypress
//     listener attached for the whole session lifetime is the
//     dispatcher registered at initialize (never per prompt).
//  2. The views (lib/tuiMenuTree.tsx) are framework-native:
//     navigation/activation happen inside the FOCUSED renderable's own
//     handleKeyPress (the framework attaches it on focus() and removes
//     it on blur()) — no react-managed key handlers anywhere; the
//     multiselect is a FoldButton tree with state in a plain mediator.
//  3. Signal discipline is DEFINED here: esc and ctrl-c cancel the
//     active prompt; ctrl-c with the session idle EXITS the process
//     (130) so make stops; ctrl-d keeps the focused editor's native
//     bindings (input edit / textarea delete) and cancels a menu
//     prompt otherwise. SIGTERM/SIGHUP (kill, systemd stop, hangup)
//     tear the TUI down BEFORE exiting, so the shell never gets a
//     raw-mode/alien-screen terminal back.
//  4. Purity: the session internals are CONST once born — every
//     late-bound slot lives in the `live` cell record and is mutated
//     only through it; there is no bare `let` inside the session
//     (module-level _session/sessionState are the two documented
//     singletons and the only rebinds).
//
// Component framework note: the focused renderable sees keys through
// its framework wiring; it does not reach this dispatcher's decisions,
// and the dispatcher leaves non-canon keys alone, so native widgets
// keep their defaults intact.

/** @jsxImportSource @opentui/react */
import { createCliRenderer, CliRenderEvents } from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { appendFileSync } from "node:fs";

import type { ReactNode } from "react";

// ── history scrollback (ported from @bunli/runtime open-tui-history) ──────

interface HistoryEntry {
    lines: string[];
}

interface SessionShellProps {
    children: ReactNode;
}

const SHELL_TERMINAL_RESET_SEQUENCE =
    "\x1b[?1004l\x1b[?2004l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[<u\x1b[>4;0m\x1b[?25h";

const forceRestoreShellTerminalModes = () => {
    if (!process.stdout.isTTY) return;
    try {
        process.stdout.write(SHELL_TERMINAL_RESET_SEQUENCE);
    } catch {
        // Ignore write failures during teardown.
    }
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        try {
            process.stdin.setRawMode(false);
        } catch {
            // Ignore raw mode restoration failures during teardown.
        }
    }
};

function formatFixedWidth(line: string, width: number): string {
    // clip long lines to the width (the vendored text-layout contract,
    // single-line only)
    if (line.length <= width) return line;
    return line.slice(0, Math.max(1, width - 1)) + "…";
}

function colorizeAnsi(text: string, code: number): string {
    if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
    return `\x1b[${code}m${text}\x1b[0m`;
}

function formatHistoryLineForStdout(line: string): string {
    if (line.length === 0) return line;
    if (line.startsWith("● ")) return colorizeAnsi(line, 96);
    if (line.startsWith("◇ ")) return colorizeAnsi(line, 36);
    if (line.startsWith("┌ ") || line.startsWith("└ ")) return colorizeAnsi(line, 36);
    if (line.startsWith("OK ")) return colorizeAnsi(line, 32);
    if (line.startsWith("WARN ")) return colorizeAnsi(line, 33);
    if (line.startsWith("ERR ")) return colorizeAnsi(line, 31);
    if (line.startsWith("INFO ")) return colorizeAnsi(line, 36);
    if (line.startsWith("│ ")) {
        return `${colorizeAnsi("│", 90)} ${line.slice(2)}`;
    }
    if (line.startsWith("? ")) {
        return `${colorizeAnsi("?", 36)} ${line.slice(2)}`;
    }
    return line;
}

function historyLineColor(line: string): string {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("? ")) return "#f4f7fb";
    if (trimmed.startsWith("OK ")) return "#38d49c";
    if (trimmed.startsWith("WARN ")) return "#f9c85b";
    if (trimmed.startsWith("ERR ")) return "#ff6b6b";
    if (trimmed.startsWith("INFO ")) return "#6ac4ff";
    if (trimmed.startsWith("● ")) return "#6ac4ff";
    if (trimmed.startsWith("◇ ")) return "#6ac4ff";
    if (trimmed.startsWith("┌ ") || trimmed.startsWith("└ ")) return "#6ac4ff";
    if (trimmed.startsWith("│ ")) return "#8fa1b5";
    return "#8fa1b5";
}

function OpenTuiPromptShell({ children }: SessionShellProps) {
    return (
        <box style={{ flexDirection: "column", gap: 0 }}>{children}</box>
    );
}

// ── the session ───────────────────────────────────────────────────────────

let _session: OnDeploySession | null = null;

export interface PromptRunArgs<T> {
    render: (resolve: (value: T | symbol) => void) => ReactNode;
    /** history line for the ANSWER (rendered into the scrollback) */
    formatHistoryLine?: (value: T) => string | undefined;
}

export interface OnDeploySession {
    initialize: () => Promise<void>;
    runPrompt: <T>(args: PromptRunArgs<T>) => Promise<T | symbol>;
    appendHistoryLines: (lines: string[]) => void;
    flushHistoryToStdout: () => void;
    dispose: () => Promise<void>;
}

/** the two documented module rebinds: the process-lifetime session
 *  (created lazily) and its coarse phase. Everything INSIDE a session
 *  is const (the `live` cell record); tests re-enter createSession and
 *  must not inherit the previous phases, hence the resets on birth. */
type Phase = "unborn" | "idle" | "prompt" | "disposed";
let sessionState: Phase = "unborn";

/** true while a prompt owns the terminal */
export function promptActive(): boolean {
    return _session !== null && sessionState === "prompt";
}

const CANCEL_KEYNAMES = new Set(["escape", "esc"]);

function isEscapeEvent(event: KeyEvent): boolean {
    const name = event.name?.toLowerCase() ?? "";
    if (CANCEL_KEYNAMES.has(name)) return true;
    if ((event.sequence ?? "") === "\x1b") return true;
    if (event.code?.toLowerCase() === "escape") return true;
    return false;
}

function isCtrlCEvent(event: KeyEvent): boolean {
    const sequence = event.sequence ?? "";
    if (sequence === "\x03") return true;
    if (event.ctrl && (event.name?.toLowerCase() === "c" || sequence.toLowerCase() === "c")) return true;
    return false;
}

function isEotEvent(event: KeyEvent): boolean {
    if (event.ctrl && event.name?.toLowerCase() === "d") return true;
    return (event.sequence ?? "") === "\x04";
}

function emitInterruptSignal(source: string) {
    if (process.stdout.isTTY) process.stdout.write("\n");
    process.kill(process.pid, "SIGINT");
}

const OPEN_TUI_CANCEL = Symbol("on-deploy:prompt_cancel");

type RendererT = Awaited<ReturnType<typeof createCliRenderer>>;
type RootT = ReturnType<typeof createRoot>;

/** the birth-once slots of one session — every renderer-adjacent
 *  assignment is a well-known cell, mutated ONLY by the initialize /
 *  settle / dispose flows below. A plain record: assignment can't leak
 *  the way numbers of copied listener refs could. */
interface Live {
    /** the green renderer (undefined until initialize first runs) */
    renderer?: RendererT;
    /** the ONE react root (created with the renderer) */
    root?: RootT;
    /** the singleton initialize promise */
    init?: Promise<void>;
    /** the ACTIVE prompt's render throttler */
    render?: () => void;
    /** the cancel resolver of the ACTIVE prompt — read directly by the
     *  dispatcher and the SIGINT gate */
    cancel?: () => void;
}

function createSession(
    deps?: {
        createRenderer?: typeof createCliRenderer;
        createRoot?: typeof createRoot;
        destroyEvent?: string;
    },
): OnDeploySession {
    const createRenderer = deps?.createRenderer ?? createCliRenderer;
    const createReactRoot = deps?.createRoot ?? createRoot;
    const depsDestroyEvent = deps?.destroyEvent ?? CliRenderEvents.DESTROY;

    // NOTE: module-level phase — a second session (tests, re-entry
    // after dispose) must not inherit the previous "disposed" state
    sessionState = "unborn";

    const live: Live = {
        // explicit shape: exactly these slots, no more
        renderer: undefined,
        init: undefined,
        root: undefined,
        render: undefined,
        cancel: undefined,
    };
    const historyEntries: HistoryEntry[] = [];

    const historyLines = () => historyEntries.flatMap((entry) => entry.lines);
    const historyRenderLines = () => {
        const width = Math.max(1, (process.stdout.columns ?? 80) - 1);
        return historyLines().map((line) => formatFixedWidth(line, width));
    };

    const initialize = async () => {
        if (sessionState === "disposed") return;
        if (live.renderer?.isDestroyed) {
            live.renderer = undefined;
            live.init = undefined;
        }
        if (live.renderer) return;
        if (live.init) return live.init;

        live.init = (async () => {
            const boot = await createRenderer({
                screenMode: "main-screen",
                consoleMode: "disabled",
                externalOutputMode: "passthrough",
                exitOnCtrlC: false,
                targetFps: 30,
                useMouse: false,
            });
            live.renderer = boot;

            // ONE react root for the WHOLE session: createRoot() wires
            // renderer.once(DESTROY, cleanup) PER root and never lets go
            // of it — a root per prompt meant one irremovable listener
            // per submenu round trip (the MaxListenersExceeded class).
            // Prompts re-render into this single root; dispose unmounts it.
            live.root = createReactRoot(boot);

            // raw layer: ctrl-c is the one key delivered before any
            // emitter; handle it here so the discipline is deterministic
            // (the test renderer doesn't carry this API — guard it)
            if (typeof boot.prependInputHandler === "function") {
                boot.prependInputHandler((sequence: string) => {
                    if (sequence === "\x03") {
                        emitInterruptSignal("raw");
                        return true;
                    }
                    if (sequence === "\x1b" && sessionState === "prompt") {
                        live.cancel?.();
                        return true;
                    }
                    return false;
                });
            }

            // DEBUG: ON_DEPLOY_TUI_DEBUG=<path> appends every key event there
            const dbg = process.env.ON_DEPLOY_TUI_DEBUG;
            const debugKeyDown = (tag: string, event: KeyEvent) => {
                if (!dbg) return;
                try {
                    appendFileSync(dbg, `${tag} name=${event.name} seq=${JSON.stringify(event.sequence ?? "")} ctrl=${event.ctrl} defaultPrevented=${event.defaultPrevented}\n`);
                } catch { /* debug only */ }
            };
            boot.keyInput.on("keypress", (event: KeyEvent) => {
                debugKeyDown("keypress", event);
                // canon keys first; unmodified fall out to the focused
                // renderable's own (framework-routed) handlers
                if (isEscapeEvent(event)) {
                    event.preventDefault?.();
                    event.stopPropagation?.();
                    live.cancel?.();
                    return;
                }
                if (isCtrlCEvent(event)) {
                    event.preventDefault?.();
                    event.stopPropagation?.();
                    emitInterruptSignal("keypress");
                    return;
                }
                if (isEotEvent(event)) {
                    // inside a native editor keep the framework's own
                    // ctrl-d bindings; a menu prompt → cancel
                    if (live.renderer?.currentFocusedEditor) return;
                    if (sessionState !== "prompt") return;
                    live.cancel?.();
                    return;
                }
                // everything else: the focused renderable sees the same
                // event through its own focus wiring
            });
        })();

        await live.init;
        sessionState = "idle";
    };

    // SIGINT discipline: while idle, ctrl-c must END the process (the
    // user expects terminal default behavior; the make recipes abort).
    // While a prompt is active, runPrompt's per-prompt handler settles
    // the cancel — this last-resort handler steps aside. Registered at
    // session birth, removed at dispose — never per prompt.
    const onSessionSigint = () => {
        if (sessionState === "prompt") return;
        if (_session) void _session.dispose().catch(() => {});
        process.exit(130);
    };

    // KILL TRAP: SIGTERM/SIGHUP (make, systemd stop, terminal hangup)
    // must clean the TUI before returning to the shell — the raw-mode
    // terminal and the alt-screen would leak the renderer otherwise.
    // dispose() is async: run it to completion inside the handler,
    // THEN exit with the conventional shell code. Registered at
    // session birth (like onSessionSigint), removed at dispose.
    const onSessionSignal = (code: number) => () => {
        const running = live.renderer;
        if (!running) process.exit(code);
        void _session?.dispose()
            .catch(() => undefined)
            .finally(() => process.exit(code));
    };
    const onSessionTerm = onSessionSignal(143);
    const onSessionHup = onSessionSignal(129);

    const appendHistoryLines = (lines: string[]) => {
        if (lines.length === 0) return;
        historyEntries.push({ lines: [...lines] });
        live.render?.();
    };

    const flushHistoryToStdout = () => {
        const linesToWrite = historyLines();
        if (linesToWrite.length === 0) return;
        for (const line of linesToWrite) {
            process.stdout.write(`${formatHistoryLineForStdout(line)}\n`);
        }
        historyEntries.length = 0;
    };

    async function runPrompt<T>(args: PromptRunArgs<T>): Promise<T | symbol> {
        await initialize();
        const activeRenderer = live.renderer;
        if (!activeRenderer || sessionState === "disposed") return OPEN_TUI_CANCEL;

        const root = live.root;
        if (!root) return OPEN_TUI_CANCEL;

        return await new Promise<T | symbol>((resolve) => {
            // settle once or die: idempotency carried in records, no let
            const flag: { settled?: true; cleaned?: true } = {};

            const settle: (value: T | symbol) => void = (value) => {
                if (flag.settled) return;
                flag.settled = true;

                if (value !== OPEN_TUI_CANCEL) {
                    const historyLine = args.formatHistoryLine?.(value as T);
                    if (historyLine) appendHistoryLines([historyLine]);
                }

                cleanup();
                resolve(value);
            };

            const onSigint = () => settle(OPEN_TUI_CANCEL);

            const onRendererDestroy = () => {
                if (flag.settled) return;
                flag.settled = true;
                cleanup();
                resolve(OPEN_TUI_CANCEL);
            };

            const cleanup = () => {
                if (flag.cleaned) return;
                flag.cleaned = true;
                if (live.cancel === onSigint) live.cancel = undefined;
                process.off("SIGINT", onSigint);
                activeRenderer.off(depsDestroyEvent, onRendererDestroy);
                // the previous leak: a fresh react root per prompt —
                // createRoot() registers renderer.once(DESTROY, cleanup)
                // per root and never lets go, so every submenu round
                // trip added one irremovable emitter listener →
                // MaxListenersExceeded. Now the root is shared (born at
                // initialize, exactly once) — prompts only re-render
                // and unmount their SUBTREE here, so the idle renderer
                // sits at the empty shell and nothing accumulates.
                root.unmount();
                live.render = undefined;
                sessionState = "idle";
            };

            activeRenderer.on(depsDestroyEvent, onRendererDestroy);
            process.on("SIGINT", onSigint);
            live.cancel = onSigint;
            sessionState = "prompt";

            live.render = () => {
                const linesToRender = historyRenderLines();
                root.render(
                    <OpenTuiPromptShell>
                        <box style={{ flexDirection: "column", gap: 0 }}>
                            {linesToRender.map((line, index) => (
                                <text
                                    key={`history:${index}`}
                                    content={line}
                                    fg={historyLineColor(line)}
                                />
                            ))}
                            {args.render(settle)}
                        </box>
                    </OpenTuiPromptShell>,
                );
            };

            live.render();
        });
    }

    const dispose = async () => {
        if (sessionState === "disposed") return;
        flushHistoryToStdout();
        sessionState = "disposed";
        live.render = undefined;
        live.root?.unmount();
        live.root = undefined;
        live.cancel = undefined;
        process.off("SIGINT", onSessionSigint);
        process.off("SIGTERM", onSessionTerm);
        process.off("SIGHUP", onSessionHup);
        const activeRenderer = live.renderer;
        if (!activeRenderer) {
            forceRestoreShellTerminalModes();
            return;
        }

        try {
            if (!activeRenderer.isDestroyed) {
                try {
                    activeRenderer.suspend();
                } catch {
                    // Best-effort: suspend may throw if renderer is mid-shutdown.
                }
                activeRenderer.currentRenderBuffer.clear();
                activeRenderer.nextRenderBuffer.clear();
                activeRenderer.requestRender();
                await activeRenderer.idle();
            }

            if (!activeRenderer.isDestroyed) activeRenderer.destroy();
        } finally {
            live.renderer = undefined;
            live.init = undefined;
            forceRestoreShellTerminalModes();
        }
    };

    process.on("SIGINT", onSessionSigint);
    process.on("SIGTERM", onSessionTerm);
    process.on("SIGHUP", onSessionHup);
    process.once("beforeExit", () => {
        if (_session) void _session.dispose().catch(() => {});
    });

    return {
        initialize,
        runPrompt,
        appendHistoryLines,
        flushHistoryToStdout,
        dispose,
    };
}

/** the process-lifetime session (created lazily; dispose at exit) */
export function session(): OnDeploySession {
    if (!_session) {
        _session = createSession();
    }
    return _session;
}

/**
 * release the TUI if one exists (configure's wizard hands the terminal
 * to the LINE-READER flow: install confirms + sudo prompts need the
 * shell's canonical mode — stepping the renderer down also flushes the
 * prompt history into scrollback). The next deep prompt re-creates the
 * session lazily.
 */
export async function releaseTui(): Promise<void> {
    const s = _session;
    _session = null;
    sessionState = "unborn";
    if (s) await s.dispose().catch(() => undefined);
}

/** test seam: headless renderer injection (see tests/listener.test.tsx) */
export const __onDeploySessionInternalsForTests = { createSession };
