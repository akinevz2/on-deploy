// src/lib/out.ts — the BUFFERED-OUTPUT monad (the 2026-11 sanitisation
// pass). Rendering functions do NOT print: they return an Out<A> — a
// value paired with the lines it WOULD have written. Nothing in this
// file touches stdout; the flush decision lives at explicit boundaries.
//
//	Out<A>          { value: A; lines: string[] }
//	pure(v, ...)    lift a value + its lines
//	tell(...)       lift lines only (Out<void>)
//	bind(oa, f)     Kleisli chain: f's lines APPEND after oa's
//	map(oa, f)      transform the value, lines pass through
//	flush(oa)       THE boundary: write every line (console.log),
//	                return the value
//
// ── FLUSH-DISCIPLINE CONTRACT (every converted call site asserts its
//    class in a comment — grep for FLUSH-CLASS to audit) ──────────────
//
//	[FLUSH-CLASS: buffered]   the default. Lines ride upward inside
//	    Out values; they are NOT on the terminal yet. A function
//	    returning Out may be composed, dropped, or dry-run discarded
//	    with zero terminal effect.
//	[FLUSH-CLASS: prompt]     UNBUFFERABLE. Text must be on the
//	    terminal BEFORE awaiting stdin (confirm/readLine/sudo). Flush
//	    immediately with promptFlush() — buffering here would freeze
//	    the walk with a silent, answerable question.
//	[FLUSH-CLASS: exec]       UNBUFFERABLE. Flush BEFORE spawning a
//	    child with inherited stdio (sudo/apt/make/cargo): the child's
//	    output interleaves on the real terminal, so our queued lines
//	    must land first or the transcript reorders.
//	[FLUSH-CLASS: exit]       the command handler's final act: flush
//	    the accumulated Out, then return/exit. (One flush per
//	    command; the process exit code rides the VALUE, not the
//	    output.)
//
// WHY console.log inside flush() and nowhere else: the say() doctrine
// (lines.ts) — stdout universally, exit codes carry failure. The
// progressive feel of long walks is preserved by flushing at each exec
// or prompt boundary, which is where the old inline prints sat anyway.

import { say } from "./lines";

export interface Out<A> {
    readonly value: A;
    readonly lines: readonly string[];
}

/** lift a value with its lines [FLUSH-CLASS: buffered] */
export function pure<A>(value: A, ...lines: string[]): Out<A> {
    return { value, lines };
}

/** lift lines only (unit over the writer side) [FLUSH-CLASS: buffered] */
export function tell(...lines: string[]): Out<void> {
    return { value: undefined, lines };
}

/** no output, no effect — the unit of the walk loops */
export function quiet<A>(value: A): Out<A> {
    return { value, lines: [] };
}

/** Kleisli bind: run f on the value; its lines append after oa's.
 * [FLUSH-CLASS: buffered] — composition never prints. */
export function bind<A, B>(oa: Out<A>, f: (a: A) => Out<B>): Out<B> {
    const ob = f(oa.value);
    return { value: ob.value, lines: [...oa.lines, ...ob.lines] };
}

/** functor map: lines pass through untouched [FLUSH-CLASS: buffered] */
export function map<A, B>(oa: Out<A>, f: (a: A) => B): Out<B> {
    return { value: f(oa.value), lines: oa.lines };
}

/** merge two Outs (e.g. a walk step + its accumulated prefix) */
export function concat<A, B>(oa: Out<A>, ob: Out<B>): Out<[A, B]> {
    return { value: [oa.value, ob.value] as [A, B], lines: [...oa.lines, ...ob.lines] };
}

/** THE flush boundary — write every line, return the value.
 * Callers must assert which class authorizes the flush in a comment. */
export function flush<A>(oa: Out<A>): A {
    if (oa.lines.length > 0) say(...oa.lines);
    return oa.value;
}

/** flush and THROW on !ok — the hard-failure shape for walks whose
 * caller only sees the exit code. [FLUSH-CLASS: exit] */
export function flushOrThrow<A>(oa: Out<A>): A {
    flush(oa);
    if (oa.value === null || oa.value === false) {
        throw new Error("out: flushOrThrow on a falsy value");
    }
    return oa.value;
}
