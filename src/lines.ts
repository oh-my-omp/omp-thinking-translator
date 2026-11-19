const LATIN_LETTER = /[A-Za-z]/;

export function shouldTranslateLine(line: string): boolean {
	const prose = line.replace(/`[^`\n]*`/g, "");
	const latin = (prose.match(/[A-Za-z]/g) ?? []).length;
	if (latin === 0) return false;
	const cjk = (prose.match(/[\u4e00-\u9fff]/g) ?? []).length;
	return latin > cjk;
}

export function lineKey(line: string): string {
	return line.replace(/(?:\.{3}|…|\.)$/, "").trimEnd();
}

export function appendLineBound(text: string, start: number, end: number, bounds: number[]): void {
	const segment = text.slice(start, end);
	const line = segment.trim();
	if (!LATIN_LETTER.test(line)) return;
	const lineStart = start + segment.length - segment.trimStart().length;
	bounds.push(lineStart, lineStart + line.length);
}

export function appendCompleteLineBounds(text: string, from: number, bounds: number[]): number {
	let start = from;
	for (let newline = text.indexOf("\n", start); newline >= 0; newline = text.indexOf("\n", start)) {
		appendLineBound(text, start, newline, bounds);
		start = newline + 1;
	}
	return start;
}

export function latinLines(text: string): string[] {
	const bounds: number[] = [];
	appendLineBound(text, appendCompleteLineBounds(text, 0, bounds), text.length, bounds);
	const lines: string[] = [];
	for (let index = 0; index < bounds.length; index += 2) lines.push(text.slice(bounds[index], bounds[index + 1]));
	return lines;
}
