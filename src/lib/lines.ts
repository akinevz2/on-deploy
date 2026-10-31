// src/lib/lines.ts — the one-line stdin reader for ALL interactive
// prompts in on-deploy. NOT node:readline: bun's readline wedges or
// rejects ("readline was closed") around spawned processes and stream
// closes. This reader keeps an explicit line queue, so it is correct
// for interactive keystrokes AND burst-piped feeds (each queued read
// consumes the next buffered line; EOF resolves every pending read
// with "").

const pending: string[] = [];
let resolvers: ((line: string) => void)[] = [];
let eof = false;
let attached = false;
const dec = new TextDecoder();

function deliver(line: string): void {
    const r = resolvers.shift();
    if (r) r(line);
    else pending.push(line);
}

function flushEof(): void {
    if (eof) return;
    eof = true;
    while (resolvers.length > 0) (resolvers.shift() as (l: string) => void)("");
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
        // a trailing line without its newline: deliver it ONLY at EOF
        // (interactive terminals flush it on Enter via the \n; a burst
        // feed's last unterminated line is ambiguous)
    });
    process.stdin.once("end", flushEof);
    process.stdin.once("close", flushEof);
}

/** resolve with the next line ("" on EOF when no line remains) */
export function readLine(): Promise<string> {
    if (!attached) {
        attached = true;
        attach();
    }
    if (pending.length > 0) return Promise.resolve(pending.shift()!);
    if (eof) return Promise.resolve("");
    return new Promise((resolve) => resolvers.push(resolve));
}

/** confirmation prompt: [Y/n] semantics — Enter accepts */
export async function confirm(prompt: string): Promise<boolean> {
    process.stdout.write(prompt);
    const a = (await readLine()).trim().toLowerCase();
    return a === "" || a === "y" || a === "yes";
}
