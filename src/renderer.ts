/**
 * omp settles the
 *   components of a finished message, and a settled root whose props change gets `set` and then its
 *   children deleted and re-added; on a section root that loses the head Tern binds before the re-add,
 *   and a folded section then draws nothing.
 */
import { getMarkdownTheme } from "@oh-my-pi/pi-coding-agent";
import type { Component, DescribeContext, NativeEventTarget, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui";
import { Box, Markdown, node, span, Text } from "@oh-my-pi/pi-tui";
import type { AssistantThinkingRenderContext } from "@oh-my-pi/pi-tui/chat/extension-types";
import type { Theme } from "@oh-my-pi/pi-tui/theme/theme";
import { tr } from "../omomp-shared/i18n.ts";
import { appendCompleteLineBounds, appendLineBound, lineKey } from "./lines.ts";
import type { TranslationCell, TranslationOutcome } from "./translate.ts";

export type CellSource = Readonly<{
	prefix(): string | undefined;
	cell(key: string): TranslationCell | undefined;
	painted(cell: TranslationCell, thinkingIndex: number): void;
	nativeSeen(): void;
	expandThinkingBlocks(): boolean;
}>;

export type BlockRenderer = Readonly<{
	component: Component & NativeEventTarget;
	update(context: AssistantThinkingRenderContext, theme: Theme): void;
}>;

type BoxView = Readonly<{ completed: number; total: number; rows: readonly string[]; rowsVersion: number }>;

const SECTION_KEY = "section";

function cellRow(progress: TranslationOutcome): string {
	switch (progress.status) {
		case "done":
			return progress.translation;
		case "error":
			return `${tr("Translation failed:", "翻译失败：")} ${progress.error.replace(/\s+/g, " ").slice(0, 80)}`;
	}
}

export function createBlockRenderer(
	source: CellSource,
	initialContext: AssistantThinkingRenderContext,
	initialTheme: Theme,
): BlockRenderer {
	let context = initialContext;
	let theme = initialTheme;

	let text = "";
	let scanned = 0;
	const bounds: number[] = [];
	let completeLines = 0;
	const keys: string[] = [];
	let keysPrefix: string | undefined;
	const lineAt = (index: number): string => text.slice(bounds[index * 2], bounds[index * 2 + 1]);
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
	split(initialContext.text);

	const frameCells: TranslationCell[] = [];
	const frameRows: string[] = [];
	const shownRows: string[] = [];
	let rowsVersion = 0;

	const collect = (): BoxView | undefined => {
		const prefix = source.prefix();
		if (prefix === undefined) return undefined;
		if (keysPrefix !== prefix) {
			keys.length = 0;
			keysPrefix = prefix;
		}
		frameCells.length = 0;
		const lineCount = bounds.length / 2;
		for (let index = 0; index < lineCount; index++) {
			let key = index < completeLines ? keys[index] : undefined;
			if (key === undefined) {
				key = prefix + lineKey(lineAt(index));
				if (index < completeLines) keys[index] = key;
			}
			const cell = source.cell(key);
			if (cell) frameCells.push(cell);
		}
		if (frameCells.length === 0) return undefined;
		let completed = 0;
		frameRows.length = 0;
		for (const cell of frameCells) {
			if (cell.progress.status === "pending") continue;
			completed++;
			frameRows.push(cellRow(cell.progress));
			if (cell.progress.status === "done" && !cell.painted) source.painted(cell, context.thinkingIndex);
		}
		if (frameRows.length === 0) return undefined;
		if (frameRows.length !== shownRows.length || frameRows.some((row, index) => row !== shownRows[index])) {
			for (let index = 0; index < frameRows.length; index++) shownRows[index] = frameRows[index]!;
			shownRows.length = frameRows.length;
			rowsVersion++;
		}
		return { completed, total: frameCells.length, rows: shownRows, rowsVersion };
	};

	const heading = (view: BoxView): string =>
		tr(
			`Thinking translation · Block ${context.thinkingIndex + 1} · ${view.completed}/${view.total}`,
			`思考翻译 · 块 ${context.thinkingIndex + 1} · ${view.completed}/${view.total}`,
		);

	const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
	const title = new Text("", 0, 0);
	const body = new Markdown("", 0, 0, getMarkdownTheme());
	box.addChild(title);
	box.addChild(body);
	let bodyVersion = -1;

	let view: BoxView | undefined;
	let labelText = "";
	let labelNode: NativeNode | undefined;
	const label: Component = {
		render: () => [],
		describe(): NativeNode | null {
			if (!view) return null;
			const next = heading(view);
			if (!labelNode || next !== labelText) {
				labelText = next;
				labelNode = node("text", { spans: [span(next, "muted")] });
			}
			return labelNode;
		},
	};
	let contentVersion = -1;
	let contentText = "";
	let contentNode: NativeNode | undefined;
	const content: Component = {
		render: () => [],
		describe(): NativeNode | null {
			if (!view) return null;
			if (!contentNode || view.rowsVersion !== contentVersion) {
				contentVersion = view.rowsVersion;
				const next = view.rows.join("\n\n");
				if (!contentNode || next !== contentText) {
					contentText = next;
					contentNode = node("md", { text: next });
				}
			}
			return contentNode;
		},
	};
	const liveHead = node("row", { gap: "sm" }, [node("spinner", { style: "starburst", role: "omp.thinking.spin" }), label], "head");
	const settledHead = node("row", { gap: "sm" }, [label], "head");
	let userCollapsed: boolean | undefined;
	let rootNode: NativeNode | undefined;
	let sectionSig = "";

	const component: Component & NativeEventTarget = {
		render(width: number): readonly string[] {
			const current = collect();
			if (!current) return [];
			title.setText(theme.fg("accent", heading(current)));
			if (current.rowsVersion !== bodyVersion) {
				bodyVersion = current.rowsVersion;
				body.setText(current.rows.join("\n\n"));
			}
			return box.render(width);
		},
		describe(cx: DescribeContext): NativeNode | null {
			source.nativeSeen();
			if (!cx.supports("section") || !cx.supports("md")) return null;
			view = collect();
			if (!view) return null;
			const live = view.completed < view.total;
			const collapsed = userCollapsed ?? (!live && !source.expandThinkingBlocks());
			const sig = `${live ? "L" : "D"}${collapsed ? "C" : "O"}`;
			if (!rootNode || sig !== sectionSig) {
				sectionSig = sig;
				const section = node(
					"section",
					{ role: live ? "omp.thinking.live" : "omp.thinking", collapsible: true, collapsed },
					[live ? liveHead : settledHead, content],
					SECTION_KEY,
				);
				rootNode = node("col", {}, [section]);
			}
			return rootNode;
		},
		handleNativeEvent(event: NativeUiEvent): void {
			if (event.type !== "toggle" || event.key !== SECTION_KEY) return;
			userCollapsed = event.collapsed;
			context.requestRender();
		},
		invalidate(): void {
			box.invalidate();
		},
	};

	return {
		component,
		update(nextContext, nextTheme): void {
			context = nextContext;
			theme = nextTheme;
			split(nextContext.text);
		},
	};
}
