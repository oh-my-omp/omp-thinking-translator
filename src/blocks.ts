/**
 * Thinking blocks this session watched being generated. The raw text comes from message events; the
 * display text is omp's own `formatThinkingForDisplay` over it, the same function that produces what the
 * host draws, so the plugin never guesses what the host showed:
 *
 * - The text a thinking renderer receives is a prefix of a block's display text (omp formats the raw
 *   thinking, then the streaming reveal slices it), so the renderer finds its block by prefix.
 * - The lines to translate are the complete lines of the display text, taken as the raw text grows,
 *   ahead of the reveal.
 */
import { formatThinkingForDisplay } from "@oh-my-pi/pi-tui/chat/thinking-display";
import { appendLineBound } from "./lines.ts";

/** What omp's latest renderer call for the block reported; updated in place on every call. */
export type BlockView = { thinkingIndex: number; requestRender: () => void };

export type TrackedBlock = {
	/** `<message sequence>:<content index>`, unique within the session. */
	readonly id: string;
	readonly contentIndex: number;
	raw: string;
	/** True once `thinking_end` or `message_end` fixed the raw text; the last line is complete from then on. */
	ended: boolean;
	/** Undefined until the host draws the block. Blocks it never draws (hidden thinking) are never translated. */
	view: BlockView | undefined;
	/** Display text memo and the inputs it was computed from. */
	display: string;
	displayRaw: string | undefined;
	displayProse: boolean;
	/** Start of the last line `takeFinalLines` returned; the next call scans from here. */
	scanFrom: number;
	/** `display.slice(0, scanFrom)` at that call: a display text not starting with it was rewritten, so the scan restarts. */
	scanHead: string;
};

export function trackedBlock(id: string, contentIndex: number, raw: string, ended: boolean): TrackedBlock {
	return {
		id,
		contentIndex,
		raw,
		ended,
		view: undefined,
		display: "",
		displayRaw: undefined,
		displayProse: true,
		scanFrom: 0,
		scanHead: "",
	};
}

/** The block's display text as the host draws it once fully revealed; recomputed only when its raw text or the mode changed. */
export function displayOf(block: TrackedBlock, proseOnly: boolean): string {
	if (block.displayRaw !== block.raw || block.displayProse !== proseOnly) {
		block.display = formatThinkingForDisplay(block.raw, proseOnly).trim();
		block.displayRaw = block.raw;
		block.displayProse = proseOnly;
	}
	return block.display;
}

/**
 * Display lines of the block that can no longer change, with a Latin letter, trimmed: every
 * newline-terminated line, plus the last line once the block ended. Each call scans only from the start
 * of the last line it returned, which it returns again: omp may still rewrite that line's ending when a
 * code fence follows it, and `lineKey` maps both forms to one cell. A display text that no longer starts
 * with the scanned part is scanned from the beginning.
 */
export function takeFinalLines(block: TrackedBlock, proseOnly: boolean): string[] {
	const display = displayOf(block, proseOnly);
	if (!display.startsWith(block.scanHead)) block.scanFrom = 0;
	const bounds: number[] = [];
	let start = block.scanFrom;
	let lastStart = start;
	for (let newline = display.indexOf("\n", start); newline >= 0; newline = display.indexOf("\n", start)) {
		appendLineBound(display, start, newline, bounds);
		lastStart = start;
		start = newline + 1;
	}
	if (block.ended) {
		appendLineBound(display, start, display.length, bounds);
		lastStart = start;
	}
	block.scanFrom = lastStart;
	block.scanHead = display.slice(0, lastStart);
	const lines: string[] = [];
	for (let index = 0; index < bounds.length; index += 2) lines.push(display.slice(bounds[index], bounds[index + 1]));
	return lines;
}

/** Forget the scan position, e.g. after the cell key prefix changed and every line must be dispatched again. */
export function restartScan(block: TrackedBlock): void {
	block.scanFrom = 0;
	block.scanHead = "";
}

/** A collection that can be walked more than once: the session's block map, or an array. */
type Blocks = Readonly<{ values(): Iterable<TrackedBlock> }>;

/**
 * The block a renderer's text belongs to: the newest block whose display text starts with it, preferring
 * one at the same content index. Only when no block starts with the whole text (omp rewrote the text's
 * last line after that frame was built, because a fence arrived after it) is the text without its last
 * line tried, with the same preferences. Undefined for text no watched block produced, such as history
 * from before this session.
 */
export function resolveBlock(blocks: Blocks, text: string, contentIndex: number, proseOnly: boolean): TrackedBlock | undefined {
	if (!text) return undefined;
	const exact = newestStartingWith(blocks, text, contentIndex, proseOnly);
	if (exact !== undefined) return exact;
	const head = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
	return head === "" ? undefined : newestStartingWith(blocks, head, contentIndex, proseOnly);
}

function newestStartingWith(blocks: Blocks, text: string, contentIndex: number, proseOnly: boolean): TrackedBlock | undefined {
	let sameIndex: TrackedBlock | undefined;
	let any: TrackedBlock | undefined;
	for (const block of blocks.values()) {
		if (!displayOf(block, proseOnly).startsWith(text)) continue;
		any = block;
		if (block.contentIndex === contentIndex) sameIndex = block;
	}
	return sameIndex ?? any;
}
