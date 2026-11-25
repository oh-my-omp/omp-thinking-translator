import type { AssistantThinkingRenderContext } from "@oh-my-pi/pi-coding-agent";
import { type JSX, type JSXNode, jsx, nativeRendering } from "@oh-my-pi/pi-tui";
import { tr } from "../omomp-shared/i18n.ts";
import { appendCompleteLineBounds, appendLineBound, lineKey } from "./lines.ts";
import type { TranslationCell, TranslationOutcome } from "./translate.ts";

export type CellSource = Readonly<{
	prefix(): string | undefined;
	cell(key: string): TranslationCell | undefined;
	painted(cell: TranslationCell, thinkingIndex: number): void;
	expandThinkingBlocks(): boolean;
}>;

export type BlockRenderer = Readonly<{
	render(context: AssistantThinkingRenderContext): JSXNode | undefined;
}>;

type BoxView = Readonly<{ completed: number; total: number; rows: readonly string[] }>;

function node<K extends keyof JSX.IntrinsicElements>(
	kind: K,
	attributes: JSX.IntrinsicElements[K] & Readonly<Record<string, unknown>>,
): JSXNode {
	return jsx(kind, attributes);
}

function cellRow(progress: TranslationOutcome): string {
	switch (progress.status) {
		case "done":
			return progress.translation;
		case "error":
			return `${tr("Translation failed:", "翻译失败：")} ${progress.error.replace(/\s+/g, " ").slice(0, 80)}`;
	}
}

export function createBlockRenderer(source: CellSource): BlockRenderer {
	let text = "";
	let scanned = 0;
	const bounds: number[] = [];
	let completeLines = 0;
	const keys: string[] = [];
	let keysPrefix: string | undefined;
	const split = (next: string): void => {
		if (next === text) return;
		if (!next.startsWith(text.slice(0, scanned))) {
			scanned = 0;
			completeLines = 0;
			keys.length = 0;
		}
		text = next;
		bounds.length = completeLines * 2;
		scanned = appendCompleteLineBounds(text, scanned, bounds);
		completeLines = bounds.length / 2;
		appendLineBound(text, scanned, text.length, bounds);
	};

	const collect = (thinkingIndex: number): BoxView | undefined => {
		const prefix = source.prefix();
		if (prefix === undefined) return undefined;
		if (keysPrefix !== prefix) {
			keys.length = 0;
			keysPrefix = prefix;
		}
		const cells: TranslationCell[] = [];
		const lineCount = bounds.length / 2;
		for (let index = 0; index < lineCount; index++) {
			let key = index < completeLines ? keys[index] : undefined;
			if (key === undefined) {
				key = prefix + lineKey(text.slice(bounds[index * 2], bounds[index * 2 + 1]));
				if (index < completeLines) keys[index] = key;
			}
			const cell = source.cell(key);
			if (cell) cells.push(cell);
		}
		const rows: string[] = [];
		for (const cell of cells) {
			if (cell.progress.status === "pending") continue;
			rows.push(cellRow(cell.progress));
			if (cell.progress.status === "done" && !cell.painted) source.painted(cell, thinkingIndex);
		}
		return rows.length === 0 ? undefined : { completed: rows.length, total: cells.length, rows };
	};

	let userCollapsed: boolean | undefined;

	return {
		render(context) {
			split(context.text);
			const view = collect(context.thinkingIndex);
			if (!view) return undefined;
			const live = view.completed < view.total;
			const heading = tr(
				`Thinking translation · Block ${context.thinkingIndex + 1} · ${view.completed}/${view.total}`,
				`思考翻译 · 块 ${context.thinkingIndex + 1} · ${view.completed}/${view.total}`,
			);
			return node("section", {
				key: "section",
				role: live ? "omp.thinking.live" : "omp.thinking",
				collapsible: nativeRendering,
				collapsed: () => nativeRendering() && (userCollapsed ?? (!live && !source.expandThinkingBlocks())),
				onToggle: (collapsed) => {
					userCollapsed = collapsed;
					context.requestRender();
				},
				children: [
					node("row", {
						key: "head",
						gap: "sm",
						children: [
							live && node("spinner", { style: "starburst", role: "omp.thinking.spin" }),
							node("text", { spans: [{ t: heading, s: "muted" }] }),
						],
					}),
					node("md", { key: "body", text: view.rows.join("\n\n") }),
				],
			});
		},
	};
}
