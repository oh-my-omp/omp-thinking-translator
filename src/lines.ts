/** Line-level rules shared by the block tracker (what to dispatch) and the renderer (what to look up). */

const LATIN_LETTER = /[A-Za-z]/;

/**
 * Whether a display line is foreign prose worth translating: with inline-code spans removed, its Latin
 * letters outnumber its CJK characters. Identifiers, paths and commands therefore cannot make Chinese
 * prose look foreign. Short lines count too.
 */
export function shouldTranslateLine(line: string): boolean {
	const prose = line.replace(/`[^`\n]*`/g, "");
	const latin = (prose.match(/[A-Za-z]/g) ?? []).length;
	if (latin === 0) return false;
	const cjk = (prose.match(/[\u4e00-\u9fff]/g) ?? []).length;
	return latin > cjk;
}

/**
 * The part of a display line a cell is keyed by. In prose-only mode omp rewrites the line before a
 * code fence to end in `...` (eating its final period) once the fence arrives, and during the reveal a
 * frame can show a line without its final period; all of these variants share one cell, so a line is
 * never translated twice and the box finds it in every frame.
 */
export function lineKey(line: string): string {
	return line.replace(/(?:\.{3}|…|\.)$/, "").trimEnd();
}

/** Appends the trimmed bounds of `text[start, end)` to `bounds` when the trimmed segment has a Latin letter. */
export function appendLineBound(text: string, start: number, end: number, bounds: number[]): void {
	const segment = text.slice(start, end);
	const line = segment.trim();
	if (!LATIN_LETTER.test(line)) return;
	const lineStart = start + segment.length - segment.trimStart().length;
	bounds.push(lineStart, lineStart + line.length);
}

/** Appends the bounds of every newline-terminated line from `from` on; returns the offset after the last newline. */
export function appendCompleteLineBounds(text: string, from: number, bounds: number[]): number {
	let start = from;
	for (let newline = text.indexOf("\n", start); newline >= 0; newline = text.indexOf("\n", start)) {
		appendLineBound(text, start, newline, bounds);
		start = newline + 1;
	}
	return start;
}

/** Every line of `text` with a Latin letter, trimmed, in order, duplicates kept. */
export function latinLines(text: string): string[] {
	const bounds: number[] = [];
	appendLineBound(text, appendCompleteLineBounds(text, 0, bounds), text.length, bounds);
	const lines: string[] = [];
	for (let index = 0; index < bounds.length; index += 2) lines.push(text.slice(bounds[index], bounds[index + 1]));
	return lines;
}
