// tests/help.test.ts — the width contract of the custom help surfaces
// (the per-verb `help` groups + the usage errors in lib/lines.ts)
import { describe, expect, test } from "bun:test";
import { helpWidth, wrapHelp, echoHelpList, echoOrdered } from "../src/lib/lines";

// echoHelpList/echoOrdered print through console.error; capture it
function capture(fn: () => void): string[] {
	const seen: string[] = [];
	const err = console.error;
	console.error = (line: unknown): void => { seen.push(`${line}`); };
	try { fn(); } finally { console.error = err; }
	return seen;
}

describe("lines.helpWidth", () => {
	const cols = process.stdout.columns;
	function withCols(v: number | undefined, fn: () => void): void {
		// the width reads the live property; drive it directly
		Object.defineProperty(process.stdout, "columns", { value: v, configurable: true });
		try { fn(); } finally {
			Object.defineProperty(process.stdout, "columns", {
				value: cols, configurable: true,
			});
		}
	}

	test("no columns (not a tty) defaults to 80", () => {
		withCols(undefined, () => expect(helpWidth()).toBe(80));
		withCols(0, () => expect(helpWidth()).toBe(80));
	});

	test("narrow panes floor at 40", () => {
		withCols(30, () => expect(helpWidth()).toBe(40));
	});

	test("a wide terminal uses its real column count", () => {
		withCols(120, () => expect(helpWidth()).toBe(120));
	});
});

describe("lines.wrapHelp", () => {
	test("breaks before the width, on words", () => {
		const lines = wrapHelp("alpha beta gamma", 11);
		expect(lines.join("\n")).toBe("alpha beta\ngamma");
	});

	test("an overlong single token hard-breaks", () => {
		const lines = wrapHelp("0123456789abcdef", 10);
		expect(lines).toEqual(["0123456789", "abcdef"]);
	});

	test("blank paragraphs collapse (empty lines are not separators)", () => {
		expect(wrapHelp("a\n\nb", 10)).toEqual(["a", "b"]);
	});
});

describe("lines.echoHelpList", () => {
	test("pairs join two-per-line when the pair fits the width", () => {
		const out = capture(() => echoHelpList(
			"pkg", "usage\ton-deploy pkg <op>", [
			"installed\tprobe the deploy state",
			"search\tresolve the package",
		]));
		// width 80: both entries pair on a single line
		expect(out[1]).toContain("\t");
		expect(out).toHaveLength(2);
	});

	test("a pair wider than the width wraps each entry separately", () => {
		const long1 = "aaaa\t" + "x".repeat(60);
		const long2 = "bbbb\t" + "y".repeat(60);
		const out = capture(() => echoHelpList("pkg", "usage", [long1, long2]));
		// the usage line plus one wrapped line per entry (each fits the
		// width alone)
		expect(out).toHaveLength(3);
		for (const line of out) expect(line.length).toBeLessThanOrEqual(80);
	});
});

describe("lines.echoOrdered", () => {
	test("echoes the doctrined group longest-first", () => {
		const out = capture(() => echoOrdered(["short", "the longest of all", "mid one"]));
		expect(out).toEqual(["the longest of all", "mid one", "short"]);
	});

	test("drops empty lines", () => {
		const out = capture(() => echoOrdered(["a", "", "b"]));
		expect(out).toEqual(["a", "b"]);
	});
});
