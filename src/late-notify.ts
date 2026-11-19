import { tr } from "../omomp-shared/i18n.ts";
import type { TranslationCell } from "./translate.ts";

type LateRowCandidate = Readonly<{ thinkingIndex: number; text: string; painted: boolean }>;
type LatePayloadRow = Readonly<{ thinkingIndex: number; text: string }>;
export type LateRowsPayload = Readonly<{ text: string; rows: readonly LatePayloadRow[] }>;

const DEBOUNCE_MS = 400;

export function buildLateRows(
	queued: readonly LateRowCandidate[],
	previousPayload: LateRowsPayload | undefined,
	coalescing: boolean,
): LateRowsPayload | undefined {
	const pending = queued.filter((row) => !row.painted);
	if (pending.length === 0) return undefined;
	const currentRows = pending.map(({ thinkingIndex, text }) => ({ thinkingIndex, text }));
	const rows = coalescing && previousPayload ? [...previousPayload.rows, ...currentRows] : currentRows;
	const blockLabels = [...new Set(rows.map((row) => row.thinkingIndex))].map((index) => tr(`Block ${index + 1}`, `第 ${index + 1} 块`));
	return {
		text: [
			tr(`Thinking translation · ${blockLabels.join(", ")}`, `思考翻译 · ${blockLabels.join("、")}`),
			...rows.map((row) => row.text),
		].join("\n"),
		rows,
	};
}

export type LateNotifierDeps = Readonly<{
	notify(text: string): void;
	setTimeout(callback: () => void, ms: number): Timer;
	clearTimer(timer: Timer): void;
	log(event: string, data: Record<string, unknown>): void;
}>;

export type LateNotifier = Readonly<{
	enqueue(thinkingIndex: number, cell: TranslationCell, text: string): void;
	noteMounted(): void;
	reset(): void;
}>;

export function createLateNotifier(deps: LateNotifierDeps): LateNotifier {
	const queue: { thinkingIndex: number; text: string; cell: TranslationCell; dueAt: number }[] = [];
	let timer: Timer | undefined;
	let lastPayload: LateRowsPayload | undefined;
	let generation = 0;
	let lastGeneration: number | undefined;

	const flush = (): void => {
		const now = performance.now();
		const dueCount = queue.findIndex(({ dueAt }) => dueAt > now);
		const due = queue.splice(0, dueCount === -1 ? queue.length : dueCount);
		if (due.length === 0) return;
		const payload = buildLateRows(
			due.map(({ thinkingIndex, text, cell }) => ({ thinkingIndex, text, painted: cell.painted })),
			lastPayload,
			lastPayload !== undefined && lastGeneration === generation,
		);
		deps.log("lateFlush", { queued: due.length, rows: payload?.rows.length ?? 0, waiting: queue.length, generation });
		if (!payload) return;
		deps.notify(payload.text);
		lastPayload = payload;
		lastGeneration = generation;
	};

	const schedule = (): void => {
		const head = queue[0];
		if (timer !== undefined || head === undefined) return;
		timer = deps.setTimeout(
			() => {
				timer = undefined;
				flush();
				schedule();
			},
			Math.max(1, Math.ceil(head.dueAt - performance.now())),
		);
	};

	return {
		enqueue(thinkingIndex, cell, text) {
			queue.push({ thinkingIndex, text, cell, dueAt: performance.now() + DEBOUNCE_MS });
			schedule();
		},
		noteMounted() {
			generation++;
		},
		reset() {
			queue.length = 0;
			if (timer !== undefined) deps.clearTimer(timer);
			timer = undefined;
			lastPayload = undefined;
			lastGeneration = undefined;
			generation = 0;
		},
	};
}
