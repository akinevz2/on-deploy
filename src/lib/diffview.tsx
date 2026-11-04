// src/lib/diffview.tsx — the full-screen diff viewer for the preserve
// conflict resolver, rendered as a native opentui-react TSX component
// through a dedicated opentui renderer (the whole file is TSX — the
// tsconfig sets jsx=react-jsx + jsxImportSource=@opentui/react).
//
// Colorscheme (the herbst theme family — reload_theme / alacritty):
//   ubuntu magenta   #a55eea   headers, accents
//   ubuntu aubergine #2c001e   background (the herbst BACKGROUND_HEX)
//   golden yellow    #feef69   highlights, the added-line marker
//   white            #eeeeee   body text (theme's frame inner)
//   gray             #333333   chrome: borders, footer, captions
//
// Keys:
//   d / space   toggle side-by-side <-> inline (unified) diff
//   up/down     line scroll
//   q / escape  close (the per-file decision menu resumes)
//
// Feeding it: two pre-computed texts pass in — the side-by-side rows
// (diff -y, left/right pairs) and the unified lines (git diff
// --no-index). The component colors unified lines; side-by-side gets
// content-based coloring per cell.

/** @jsxImportSource @opentui/react */

import { useState } from "react";
import { useKeyboard } from "@opentui/react";

export interface SideRow {
    left: string;
    right: string;
}

export interface DiffViewData {
    rel: string;
    /** side-by-side rows (already paired left/right) */
    side: SideRow[];
    /** unified diff lines */
    unified: string[];
}

export interface DiffViewProps extends DiffViewData {
    resolve: (v: undefined | symbol) => void;
}

// the palette (see the header comment)
const BG = "#2c001e";       // ubuntu aubergine (herbst BACKGROUND_HEX)
const MAGENTA = "#a55eea";  // ubuntu magenta (bright)
const GOLD = "#feef69";     // golden yellow (herbst active title)
const WHITE = "#eeeeee";    // white (herbst frame inner)
const GRAY = "#333333";     // gray (herbst tiling fill / chrome)

/** color a side cell by its diff -y marker semantics */
function sideColor(cell: string): string {
    if (cell.includes(">")) return GOLD;
    if (cell.includes("<")) return WHITE;
    if (cell.includes("|")) return MAGENTA;
    return GRAY;
}

function unifiedColor(line: string): string {
    if (line.startsWith("+")) return GOLD;
    if (line.startsWith("-")) return WHITE;
    if (line.startsWith("@@")) return MAGENTA;
    if (line.startsWith("diff ") || line.startsWith("index ")) return MAGENTA;
    return WHITE;
}

export function DiffViewer(props: DiffViewProps) {
    const [mode, setMode] = useState<"side" | "inline">("side");
    useKeyboard((key) => {
        if (key.name === "q" || key.name === "escape") props.resolve(undefined);
        else if (key.name === "d" || key.name === "space") {
            setMode((m) => (m === "side" ? "inline" : "side"));
        }
        // up/down scroll inside the focused scrollbox (its own bindings)
    });

    return (
        <box
            style={{
                flexDirection: "column",
                backgroundColor: BG,
                flexGrow: 1,
                padding: 1,
            }}
        >
            <box
                style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    marginBottom: 1,
                    flexShrink: 0,
                }}
            >
                <text fg={MAGENTA}>{`diff: ${props.rel}`}</text>
                <text fg={GRAY}>
                    {`[d/space] ${mode === "side" ? "side-by-side" : "inline"}   [up/down] scroll   [q] close`}
                </text>
            </box>
            <box style={{ flexGrow: 1, flexDirection: "column", backgroundColor: GRAY }}>
                <scrollbox
                    focused={true}
                    style={{ flexGrow: 1 }}
                >
                    {mode === "side" ? (
                        props.side.map((r, i) => (
                            <box key={i} style={{ flexDirection: "row", backgroundColor: BG }}>
                                <text fg={sideColor(r.left)} style={{ width: "50%" }}>
                                    {r.left || " "}
                                </text>
                                <text fg={sideColor(r.right)} style={{ width: "50%" }}>
                                    {r.right || " "}
                                </text>
                            </box>
                        ))
                    ) : (
                        props.unified.map((l, i) => (
                            <text key={i} fg={unifiedColor(l)}>
                                {l || " "}
                            </text>
                        ))
                    )}
                </scrollbox>
            </box>
            <text fg={GOLD} style={{ flexShrink: 0 }}>
                {mode === "side"
                    ? `${props.side.length} row(s) — d: inline`
                    : `${props.unified.length} line(s) — d: side-by-side`}
                {"  "}
            </text>
        </box>
    );
}

// The driver: a dedicated opentui renderer session (alternate screen)
// hosting the viewer until the user closes it — then cooked mode and
// the inline prompt frames of @bunli/runtime continue. Non-fatal to the
// caller (the resolver falls back to the unified-diff text display).
export async function showDiffView(data: DiffViewData): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("diff viewer needs a tty");
    }
    const { createCliRenderer } = await import("@opentui/core");
    const { createRoot } = await import("@opentui/react");
    let resolveDone: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; }); // resolves on destroy
    const renderer = await createCliRenderer({
        screenMode: "alternate-screen",
        exitOnCtrlC: false,
        onDestroy: () => resolveDone(),
    });
    const root = createRoot(renderer);
    root.render(
        <DiffViewer
            {...data}
            resolve={() => renderer.destroy()}
        />,
    );
    await done;
}
