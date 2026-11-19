/**
 * The translation box under a thinking block. The box only reads: dispatch happens in the session when
 * the block's lines become final, so drawing never starts a request. It looks up every line of the text
 * omp hands the renderer, and shows the lines whose cells finished.
 *
 * - ANSI: `render(width)` draws a Box with a title (`done/total`) and a Markdown body.
 * - Tern Surface Protocol: `describe(cx)` returns a collapsible `section` shaped like omp's own thinking
 *   section. Its root object changes only when its live/collapsed state changes; the label and the body
 *   are child components returning their own cached nodes, so a finished line updates them in place
 *   instead of making the reconciler delete and re-add the whole section.
 */
import { getMarkdownTheme } from "@oh-my-pi/pi-coding-agent";
import type { Component, DescribeContext, NativeEventTarget, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui";
import { Box, Markdown, node, span, Text } from "@oh-my-pi/pi-tui";
import type { AssistantThinkingRenderContext } from "@oh-my-pi/pi-tui/chat/extension-types";
import type { Theme } from "@oh-my-pi/pi-tui/theme/theme";
import { tr } from "../omomp-shared/i18n.ts";
import { appendCompleteLineBounds, appendLineBound, lineKey } from "./lines.ts";
import type { TranslationCell, TranslationOutcome } from "./translate.ts";

/** What a box reads from its session; every call reflects the session's current state. */
export type CellSource = Readonly<{
	/** The cell key prefix; undefined while translation is off (disabled, or the role is unbound). */
	prefix(): string | undefined;
	cell(key: string): TranslationCell | undefined;
	/** Called the first time a box draws a finished cell. */
	painted(cell: TranslationCell, thinkingIndex: number): void;
	/** Called on every `describe`: a Tern surface is drawing, which has no append-only scrollback. */
	nativeSeen(): void;
	/** omp's `expandThinkingBlocks` setting, read on every call. */
	expandThinkingBlocks(): boolean;
}>;

export type BlockRenderer = Readonly<{
	component: Component & NativeEventTarget;
	/** Hand the box the context and theme of omp's latest call for its block. */
	update(context: AssistantThinkingRenderContext, theme: Theme): void;
}>;

/** Finished cells drawn in this frame, and the rows they produce; `rows` changes only when `rowsVersion` does. */
type BoxView = Readonly<{ completed: number; total: number; rows: readonly string[]; rowsVersion: number }>;

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

	// Line splitting state: offsets into the text, extended over the appended part while the new text starts
	// with the old one. Offsets rather than substrings, so old versions of the text are not retained.
	let text = "";
	/** Offset after the last newline of `text`; lines before it are complete. */
	let scanned = 0;
	/** Two entries per line: trimmed start and end. */
	const bounds: number[] = [];
	let completeLines = 0;
	/** Cell key per complete line under `keysPrefix`; computed once per line. */
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
	/** Rows of the last frame that had any; rewritten, and `rowsVersion` bumped, only when they change. */
	const shownRows: string[] = [];
	let rowsVersion = 0;

	/** Shared by `render` and `describe`: look up cells, mark finished ones painted; undefined when nothing is drawable. */
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
			// The last line may still be revealing; its key is computed per frame and never cached.
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
		// Pending lines take no room; they only count in the title.
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

	// ANSI surface.
	const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
	const title = new Text("", 0, 0);
	const body = new Markdown("", 0, 0, getMarkdownTheme());
	box.addChild(title);
	box.addChild(body);
	let bodyVersion = -1;

	// Tern surface: label and body are child components with their own cached nodes.
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
	// Like omp's thinking head: a starburst while lines are pending, only the label once all settled.
	const liveHead = node("row", { gap: "sm" }, [node("spinner", { style: "starburst", role: "omp.thinking.spin" }), label], "head");
	const settledHead = node("row", { gap: "sm" }, [label], "head");
	/** The user's own fold in Tern; until then: open while pending, then folded unless `expandThinkingBlocks` is on. */
	let userCollapsed: boolean | undefined;
	let sectionNode: NativeNode | undefined;
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
			if (!sectionNode || sig !== sectionSig) {
				sectionSig = sig;
				sectionNode = node("section", { role: live ? "omp.thinking.live" : "omp.thinking", collapsible: true, collapsed }, [
					live ? liveHead : settledHead,
					content,
				]);
			}
			return sectionNode;
		},
		handleNativeEvent(event: NativeUiEvent): void {
			// The fold toggle of the section itself (root key "").
			if (event.type !== "toggle" || event.key !== "") return;
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
