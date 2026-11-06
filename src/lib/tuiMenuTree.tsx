// src/lib/tuiMenuTree.tsx — the fold-button menu machinery.
//
// DESIGN (framework-native): every menu row is a FoldButtonRenderable —
// a focusable BoxRenderable subclass whose key handling lives in the
// overridden handleKeyPress(). The route is focus-driven: keyInput
// emits global listeners first (the session dispatcher in
// lib/tuiSession.tsx owns esc/ctrl-c/ctrl-d), then the FOCUSED
// renderable's keypressHandler — focus() attaches it, blur() removes
// it, and the framework manages both. NOTHING subscribes/unsubscribes
// per prompt, so the react-unmount listener leak class cannot occur.
//
// Keys per button:
//	enter → folder folds / single-mode picks / check-mode submits
//	space → toggle the check (check rows only)
//	o	→ toggle fold on a folder row (children attach/detach)
//   up/down/j/k → adjacent VISIBLE row (collapsed subtrees don't
//	break adjacency); disabled rows are stepped over
//
// React renders ONLY the shell (message, row container, hint). The
// MenuTree mediator (plain JS) owns ALL state — rows, checks, folds,
// focus — imperatively through core primitives (add/remove/focus),
// never through react state. refreshDom() is the single DOM
// synchronization point: every child is removed and the visible rows
// re-added ascending with the error line anchoring position zero, so
// add(obj, index) (= insert before the current index-th child) keeps
// DOM order == visible order at every fold change. Button
// renderables are created once per row and REUSED across folds.
//
// The wrapper (lib/tui.ts) wires resolve() into the mediator's done
// callback and folds the answer into the prompt history.

/** @jsxImportSource @opentui/react */
import {
    BoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

const TEXT = "#f4f7fb";
const ACCENT = "#6ac4ff";
const DISABLED_FG = "#4a5568";
const FOCUS_BG = "#16324a";

export interface RowSpec {
    key: string;
    label: string;
    /** folder row: foldable children live under it */
    folder?: boolean;
    /** child specs (folders may nest) */
    children?: RowSpec[];
    /** pre-checked (check rows only) */
    checked?: boolean;
    disabled?: boolean;
    hint?: string;
}

type RowKind = "action" | "check" | "folder";

export interface RuntimeRow {
    spec: RowSpec;
    kind: RowKind;
    checked: boolean;
    folded: boolean;
    button: FoldButtonRenderable;
    parent: RuntimeRow | null;
    children: RuntimeRow[];
}

type KeyLike = { name?: string; ctrl?: boolean; shift?: boolean; sequence?: string };

// ── the renderable ────────────────────────────────────────────────────────

export class FoldButtonRenderable extends BoxRenderable {
    private kind: RowKind;
    private checked = false;
    private folded = false;
    private disabled = false;
    private label: string;
    private hint?: string;
    private textChild: TextRenderable;

    // mediator callbacks (plain fields; the reconciler never touches
    // them — the mediator constructs buttons directly)
    onActivate: (row: FoldButtonRenderable) => void = () => {};
    onToggle: (row: FoldButtonRenderable) => void = () => {};
    onNavigate: (row: FoldButtonRenderable, delta: number) => void = () => {};
    onToggleAll: () => void = () => {};

    constructor(
        ctx: RenderContext,
        args: {
            spec: RowSpec;
            kind: RowKind;
            checked: boolean;
            folded: boolean;
            onActivate: (row: FoldButtonRenderable) => void;
            onToggle: (row: FoldButtonRenderable) => void;
            onNavigate: (row: FoldButtonRenderable, delta: number) => void;
            onToggleAll?: () => void;
        },
    ) {
        super(ctx, {
            flexDirection: "row",
            backgroundColor: "#000000",
            focusable: true,
        });
        this.kind = args.kind;
        this.checked = args.checked;
        this.folded = args.folded;
        this.disabled = !!args.spec.disabled;
        this.label = args.spec.label;
        this.hint = args.spec.hint;
        this.onActivate = args.onActivate;
        this.onToggle = args.onToggle;
        this.onNavigate = args.onNavigate;
        if (args.onToggleAll) this.onToggleAll = args.onToggleAll;
        this.textChild = new TextRenderable(ctx, { content: "" });
        this.add(this.textChild);
        this.refresh();
    }

    private contentLine(): string {
        const check = this.kind === "check" ? (this.checked ? "[x] " : "[ ] ") : "";
        const fold = this.kind === "folder" ? (this.folded ? "▸ " : "▾ ") : "";
        const hint = this.hint ? `  (${this.hint})` : "";
        const focus = this.focused ? "> " : "  ";
        return `${focus}${check}${fold}${this.label}${hint}`;
    }

    refresh(): void {
        // rows removed from the DOM (fold) auto-blur AFTER their text
        // buffer is destroyed — never touch them then
        if (this._isDestroyed || this.textChild.isDestroyed) return;
        this.textChild.content = this.contentLine();
        this.textChild.fg = this.disabled
            ? DISABLED_FG
            : this.kind === "folder" ? ACCENT : TEXT;
    }

    // focus()/blur() are the framework's own attach/detach points for
    // the per-button key handler; here they also repaint the row
    override focus(): void {
        super.focus();
        if (!this.disabled) this.backgroundColor = FOCUS_BG;
        this.refresh();
    }

    override blur(): void {
        super.blur();
        this.backgroundColor = this.disabled ? "#0a0a0a" : "#000000";
        this.refresh();
    }

    toggleChecked(): void {
        this.checked = !this.checked;
        this.refresh();
    }

    setChecked(v: boolean): void {
        this.checked = v;
        this.refresh();
    }

    toggleFolded(): void {
        this.folded = !this.folded;
        this.refresh();
    }

    // called ONLY while focused (the framework attaches the handler on
    // focus and removes it on blur); unhandled keys fall through
    override handleKeyPress(key: KeyLike): boolean {
        const name = key.name?.toLowerCase() ?? "";
        if (name === "return" || name === "enter" || (key.sequence ?? "") === "\r") {
            this.onActivate(this);
            return true;
        }
        if (name === "space") {
            if (this.kind === "check" && !this.disabled) this.onToggle(this);
            return true;
        }
        if (key.ctrl && name === "a") {
            this.onToggleAll();
            return true;
        }
        if (name === "o" && !key.ctrl) {
            if (this.kind === "folder") this.onActivate(this);
            return true;
        }
        if (name === "up" || (name === "k" && !key.ctrl)) {
            this.onNavigate(this, -1);
            return true;
        }
        if (name === "down" || (name === "j" && !key.ctrl)) {
            this.onNavigate(this, 1);
            return true;
        }
        return false;
    }
}

// ── the mediator ──────────────────────────────────────────────────────────

export interface MenuTreeOptions {
    specs: RowSpec[];
    mode: "single" | "multi";
    /** multi mode: ≥1 checked to submit (default true) */
    required?: boolean;
    /** folders start expanded (default folded) */
    startExpanded?: boolean;
    /** row key to seed focus / initial selection (single mode) */
    initialKey?: string;
    /** completion (the wrapper settles the prompt here) */
    onDone: (result: { keys: string[]; values: string[] }) => void;
    onError: (message: string) => void;
}

export class MenuTree {
    private rows: RuntimeRow[] = [];
    private visible: RuntimeRow[] = [];
    private focusIndex = 0;
    private host: BoxRenderable | null = null;
    private errorLine: TextRenderable | null = null;
    private attached = false;
    private options: MenuTreeOptions;

    constructor(options: MenuTreeOptions) {
        this.options = options;
        this.rows = this.buildRuntime(options.specs, null);
    }

    /**
     * recursive runtime build (spec tree == row tree); buttons are
     * created LAZILY in attach() — the ctx lives on the host box,
     * which react mounts only after render starts
     */
    private buildRuntime(specs: RowSpec[], parent: RuntimeRow | null): RuntimeRow[] {
        const created: RuntimeRow[] = [];
        for (const spec of specs) {
            const row: RuntimeRow = {
                spec,
                kind: spec.folder ? "folder" : this.options.mode === "multi" ? "check" : "action",
                checked: spec.checked ?? false,
                folded: !(this.options.startExpanded ?? false),
                button: null as unknown as FoldButtonRenderable,
                parent,
                children: [],
            };
            row.children = spec.children?.length
                ? this.buildRuntime(spec.children, row)
                : [];
            created.push(row);
        }
        return created;
    }

    /** called by the react shell once the host box exists */
    attach(host: BoxRenderable): void {
        if (this.attached) return;
        this.attached = true;
        this.host = host;
        this.errorLine = new TextRenderable(host.ctx, {
            content: "",
            fg: "#ff6b6b",
        });
        this.materializeButtons(this.rows, host.ctx);
        this.refreshDom();
        const seed = this.visible.findIndex(
            (r) => r.spec.key === this.options.initialKey,
        );
        this.focusRow(seed >= 0 ? seed : 0);
    }

    private materializeButtons(rows: RuntimeRow[], ctx: RenderContext): void {
        for (const row of rows) {
            row.button = new FoldButtonRenderable(ctx, {
                spec: row.spec,
                kind: row.kind,
                checked: row.checked,
                folded: row.folded,
                onActivate: () => this.activate(),
                onToggle: () => this.toggleRow(),
                onNavigate: (_b, d) => this.navigate(d),
                onToggleAll: () => this.toggleAll(),
            });
            this.materializeButtons(row.children, ctx);
        }
    }

    /** the VISIBLE rows: preorder walk, folded subtrees skipped */
    private preorderView(): RuntimeRow[] {
        const out: RuntimeRow[] = [];
        const walk = (rows: RuntimeRow[]) => {
            for (const row of rows) {
                out.push(row);
                if (row.children.length > 0 && !row.folded) walk(row.children);
            }
        };
        walk(this.rows);
        return out;
    }

    /**
     * the single DOM sync point: children removed, error line
     * re-anchored, visible rows re-added ascending — add(obj, index)
     * inserts before the current index-th child, so with the error
     * line at zero the DOM ends in exactly visible order
     */
    private refreshDom(): void {
        const current = this.host!.getChildren();
        for (const child of current) this.host!.remove(child.id);
        if (!this.errorLine) return;
        this.host!.add(this.errorLine); // index 0 anchor
        this.visible = this.preorderView();
        for (let i = 0; i < this.visible.length; i++) {
            this.host!.add(this.visible[i].button, i);
        }
        // focus guard: must live on a VISIBLE row
        if (this.focusIndex >= this.visible.length) {
            this.focusIndex = Math.max(0, this.visible.length - 1);
        }
        this.focusRow(this.focusIndex);
        this.host!.requestRender();
    }

    private focusRow(index: number): void {
        const n = this.visible.length;
        if (n === 0) return;
        let idx = ((index % n) + n) % n;
        if (this.visible[idx].spec.disabled) {
            for (let step = 1; step < n; step++) {
                const probe = (idx + step) % n;
                if (!this.visible[probe].spec.disabled) {
                    idx = probe;
                    break;
                }
            }
        }
        this.focusIndex = idx;
        this.visible[idx].button.focus();
    }

    private navigate(delta: number): void {
        this.focusRow(this.focusIndex + delta);
    }

    private toggleRow(): void {
        const row = this.visible[this.focusIndex];
        if (!row || row.spec.disabled) return;
        this.errorLine!.content = "";
        this.host!.requestRender();
        if (row.kind !== "check") return;
        row.checked = !row.checked;
        row.button.toggleChecked();
    }

    private activate(): void {
        const row = this.visible[this.focusIndex];
        if (!row || row.spec.disabled) return;
        this.errorLine!.content = "";
        this.host!.requestRender();
        if (row.kind === "folder") {
            this.toggleFold(row);
            return;
        }
        if (this.options.mode === "multi") {
            // check rows: enter SUBMITS (the space/ctrl-a path toggles)
            this.submit();
            return;
        }
        // single-mode action
        this.options.onDone({ keys: [row.spec.key], values: [row.spec.key] });
    }

    private toggleAll(): void {
        const checks = this.visible.filter(
            (r) => r.kind === "check" && !r.spec.disabled,
        );
        const anyUnchecked = checks.some((r) => !r.checked);
        for (const row of checks) {
            row.checked = anyUnchecked;
            row.button.setChecked(anyUnchecked);
        }
        this.host!.requestRender();
    }

    private toggleFold(row: RuntimeRow): void {
        row.folded = !row.folded;
        row.button.toggleFolded();
        this.refreshDom();
        const kept = this.visible.indexOf(row);
        if (kept >= 0) this.focusRow(kept);
    }

    submit(): void {
        const checked = this.rows.filter(
            (r) => r.kind === "check" && r.checked && !r.spec.disabled,
        );
        if (checked.length === 0 && this.options.required !== false) {
            this.errorLine!.content =
                "ERR Select at least one option (space to check).";
            this.host!.requestRender();
            this.options.onError("Select at least one option.");
            return;
        }
        this.options.onDone({
            keys: checked.map((r) => r.spec.key),
            values: checked.map((r) => r.spec.key),
        });
    }
}
