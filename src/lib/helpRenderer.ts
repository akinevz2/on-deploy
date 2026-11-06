// src/lib/helpRenderer.ts — the bunli custom help renderer: the
// command DESCRIPTIONS wrap at 35 columns (the wrapped lines are the
// continuation of the entry above them), so the help reads like a
// rule list: a command name per line, its description text indented
// below it.
//
//   on-deploy help            the root (35-wrapped command list)
//   on-deploy <cmd> --help    the same rendering for a single command


const DESC_WIDTH = 35;

/** wrap to DESC_WIDTH: whole words, single-token overflow hard-breaks */
interface CommandLike {
    name: string;
    description?: string;
    options?: Record<string, unknown>;
}

// the renderer's context, loosely typed (the Command type's generics
// would collide with the Recast casts below)
interface HelpRendererCtx {
    cliName: string;
    version: string;
    description?: string;
    command?: CommandLike;
    path: string[];
    commands: CommandLike[];
}


function wrapDesc(text: string, width = DESC_WIDTH): string[] {
    const out: string[] = [];
    for (const para of text.split("\n")) {
        let line = "";
        const push = () => { if (line.length) { out.push(line); line = ""; } };
        for (const originalWord of para.split(/\s+/).filter(Boolean)) {
            let word = originalWord;
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

interface RowLike { label: string; desc: string }

function printDescs(rows: RowLike[]): void {
    const labelWidth = Math.max(...rows.map((l) => l.label.length), 0) + 2;
    let first = true;
    for (const { label, desc } of rows) {
        if (!first) console.log("");
        first = false;
        const wrapped = wrapDesc(desc);
        if (wrapped.length === 0) { console.log(label); continue; }
        console.log(`${label.padEnd(labelWidth)}${wrapped[0]}`);
        for (const line of wrapped.slice(1)) {
            console.log(`${" ".repeat(labelWidth)}${line}`);
        }
    }
}

export function helpRenderer(ctx: HelpRendererCtx): void {
    // a single command: the usage + the description (wrapped) + options
    if (ctx.command) {
        const cmd: CommandLike = ctx.command as unknown as CommandLike;
        const fullPath = [...ctx.path, cmd.name].join(" ");
        console.log(`Usage: ${ctx.cliName} ${fullPath} [options]`);
        console.log("");
        for (const line of wrapDesc(cmd.description ?? "")) console.log(line);
        const entries = Object.entries(cmd.options ?? {})
            .map(([name, raw]) => {
                const opt = raw as { short?: string; description?: string };
                return { label: `--${name}${opt.short ? `, -${opt.short}` : ""}`, desc: opt.description ?? "" };
            });
        if (entries.length > 0) {
            console.log("");
            console.log("Options:");
            printDescs(entries);
        }
        return;
    }

    // the root: the command list, 35-wrapped descriptions
    console.log(`${ctx.cliName} v${ctx.version}`);
    if (ctx.description) {
        console.log("");
        for (const line of wrapDesc(ctx.description)) console.log(line);
    }
    const commands = ctx.commands as CommandLike[];
    if (commands.length > 0) {
        console.log("");
        console.log("commands:");
        printDescs(commands.filter((c) => c.name)
            .map((c) => ({ label: c.name, desc: c.description ?? "" })));
    }
}
