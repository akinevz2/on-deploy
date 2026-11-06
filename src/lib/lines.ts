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
        let i = 0;
        // terminate on \n OR \r (RAW-MODE compat: a bare CR is what
        // Enter delivers with the TUI renderer's raw mode still
        // set on the terminal — waiting for \n there was the confirm
        // freeze). A CRLF pair is ONE line, never two.
        for (;;) {
            const nl = buf.indexOf("\n", i);
            const cr = buf.indexOf("\r", i);
            const at = (nl < 0 ? cr : cr < 0 ? nl : Math.min(nl, cr));
            if (at < 0) break;
            deliver(buf.slice(i, at));
            // \r\n consumed as a single terminator
            if (buf[at] === "\r" && buf[at + 1] === "\n") i = at + 2;
            else i = at + 1;
        }
        buf = buf.slice(i);
        // a trailing line without its newline: buffered; delivered ONLY
        // at EOF (interactive terminals flush it on Enter via the \n)
        trailing = buf.length > 0 ? buf : trailing;
    });
    process.stdin.once("end", flushEof);
    process.stdin.once("close", flushEof);
}

/** resolve with the next line, or null at EOF (terminal ctrl-d /
 * closed stdin). The null branch must abort, never assume. */
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
 * prompts where skipping is NOT an option). Loop-safe on EOF? No —
 * returns null when stdin is over; callers exit. */
export async function readLineRequired(prompt: string): Promise<string | null> {
    process.stdout.write(prompt);
    return await readLine();
}
