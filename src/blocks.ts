import { formatThinkingForDisplay } from "@oh-my-pi/pi-coding-agent/session/transcript/thinking-display";
import { appendLineBound } from "./lines.ts";

export type BlockView = { thinkingIndex: number; requestRender: () => void; text: string };

export type TrackedBlock = {
	readonly id: string;
	readonly contentIndex: number;
	raw: string;
	ended: boolean;
	view: BlockView | undefined;
	display: string;
	displayRaw: string | undefined;
	displayProse: boolean;
	scanFrom: number;
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

export function displayOf(block: TrackedBlock, proseOnly: boolean): string {
	if (block.displayRaw !== block.raw || block.displayProse !== proseOnly) {
		block.display = formatThinkingForDisplay(block.raw, proseOnly).trim();
		block.displayRaw = block.raw;
		block.displayProse = proseOnly;
	}
	return block.display;
}

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

export function restartScan(block: TrackedBlock): void {
	block.scanFrom = 0;
	block.scanHead = "";
}

type Blocks = Readonly<{ values(): Iterable<TrackedBlock> }>;

export function resolveBlock(blocks: Blocks, text: string, contentIndex: number, proseOnly: boolean): TrackedBlock | undefined {
	if (!text) return undefined;
	const exact = newestStartingWith(blocks, text, text, contentIndex, proseOnly);
	if (exact !== undefined) return exact;
	const head = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
	return head === "" ? undefined : newestStartingWith(blocks, head, text, contentIndex, proseOnly);
}

function newestStartingWith(
	blocks: Blocks,
	prefix: string,
	text: string,
	contentIndex: number,
	proseOnly: boolean,
): TrackedBlock | undefined {
	let sameIndex: TrackedBlock | undefined;
	let any: TrackedBlock | undefined;
	for (const block of blocks.values()) {
		const display = displayOf(block, proseOnly);
		if (!display.startsWith(prefix)) continue;
		const shown = block.view?.text;
		if (shown !== undefined && shown.length > text.length && shown.startsWith(text) && text !== display) continue;
		any = block;
		if (block.contentIndex === contentIndex) sameIndex = block;
	}
	return sameIndex ?? any;
}
