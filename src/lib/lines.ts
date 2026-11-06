// src/lib/lines.ts — the one-line stdin reader for ALL interactive
// prompts in on-deploy. NOT node:readline: bun's readline wedges or
// rejects ("readline was closed") around spawned processes and stream
// closes. This reader keeps an explicit line queue, so it is correct
// for interactive keystrokes AND burst-piped feeds (each queued read
// consumes the next buffered line; EOF resolves every pending read
// with null AFTER the trailing unterminated line — delivered only now,
// when the terminal flushes it).
//
// SIGNAL CONTRACT (const): readLine() resolves null on EOF — the
// terminal's ctrl-d at an empty line (canonical mode) or a closed
// stdin. Callers MUST branch on null: confirm() maps EOF to "abort",
// never an implicit yes (the old reader's empty-string resolution made
// "install?" treat ctrl-d as a YES — the "signals resume the script"
// bug).

const pending: string[] = [];
let resolvers: ((line: string | null) => void)[] = [];
let eof = false;
let attached = false;
const dec = new TextDecoder();
/** an unterminated final line, delivered at EOF (canonical flush) */
let trailing: string | null = null;

function deliver(line: string | null): void {
    const r = resolvers.shift();
    if (r) r(line);
    else if (line !== null) pending.push(line);
}

function flushEof(): void {
    if (eof) return;
    eof = true;
    if (trailing !== null) {
        const t = trailing;
        trailing = null;
        deliver(t);
    }
    while (resolvers.length > 0) (resolvers.shift() as (l: string | null) => void)(null);
}

function attach(): void {
    process.stdin.on("data", (chunk: Uint8Array | string) => {
        let buf = typeof chunk === "string" ? chunk : dec.decode(chunk);
        let i = buf.indexOf("\n");
        while (i >= 0) {
            deliver(buf.slice(0, i));
            buf = buf.slice(i + 1);
            i = buf.indexOf("\n");
        }
        // a trailing line without its newline: buffered; delivered ONLY
        // at EOF (interactive terminals flush it on Enter via the \n)
        trailing = buf.length > 0 ? buf : trailing;
    });
    process.stdin.once("end", flushEof);
    process.stdin.once("close", flushEof);
}

/** resolve with the next line, or null at EOF (terminal ctrl-d /
 *  closed stdin). The null branch must abort, never assume. */
export function readLine(): Promise<string | null> {
    if (!attached) {
        attached = true;
        attach();
    }
    if (pending.length > 0) return Promise.resolve(pending.shift()!);
    if (eof) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => resolvers.push(resolve));
}

/** [Y/n] semantics — Enter accepts. EOF (ctrl-d / closed stdin) →
 *  "abort": the caller must STOP instead of continuing silently. */
export async function confirm(prompt: string): Promise<"yes" | "no" | "abort"> {
    process.stdout.write(prompt);
    const a = await readLine();
    if (a === null) return "abort";
    const t = a.trim().toLowerCase();
    if (t === "" || t === "y" || t === "yes") return "yes";
    return "no";
}

/** non-null line read: retries past the EOF case with a message (for
 *  prompts where skipping is NOT an option). Loop-safe on EOF? No —
 *  returns null when stdin is over; callers exit. */
export async function readLineRequired(prompt: string): Promise<string | null> {
    process.stdout.write(prompt);
    return await readLine();
}

// ── the help + doctrine helpers ────────────────────────────────────────
export const HELP_WIDTH = 35;

/** word-wrap to the width; an overlong single token hard-breaks */
export function wrapHelp(text: string, width = HELP_WIDTH): string[] {
    const out: string[] = [];
    for (const para of text.split("\n")) {
        let line = "";
        const push = () => { if (line.length) { out.push(line); line = ""; } };
        for (const original of para.split(/\s+/).filter(Boolean)) {
            let word = original;
            while (word.length > width) {
                push();
                out.push(word.slice(0, width));
                word = word.slice(width);
            }
            if (line.length === 0) line = word;
            else if (line.length + 1 + word.length <= width) line += " " + word;
            else { push(); line = word; }
        }
        push();
    }
    return out;
}

/** the usage + subcommand list: greedy two-per-line when the pair fits
 *  the narrow width; otherwise one per line, each wrapped */
export function echoHelpList(module: string, usage: string, entries: string[]): void {
    console.error(`${module}:\t${usage}`);
    let index = 0;
    while (index < entries.length) {
        const pivot = entries[index];
        const joined = entries[index + 1]
            ? `${pivot}\t${entries[index + 1]}`
            : pivot;
        if (pivot.length + (entries[index + 1]?.length ?? 0) + 2 <= HELP_WIDTH) {
            console.error(`${module}:\t${joined}`);
            index += 2;
        } else {
            for (const line of wrapHelp(pivot)) console.error(`${module}:\t${line}`);
            index += 1;
        }
    }
}

/** the doctrined multi-line error group: LONGEST message first,
 *  shortest last */
export function echoOrdered(lines: string[]): void {
    const ordered = [...lines.filter(Boolean)].sort((a, b) => b.length - a.length);
    for (const line of ordered) console.error(line);
}
