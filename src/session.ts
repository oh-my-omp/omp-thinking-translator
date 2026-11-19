/**
 * Nothing lives in module scope: omp evaluates the module once and binds the factory again for every
 * subagent session, so module state would be shared across sessions.
 */
import type { ExtensionAPI, ExtensionContext, MessageEndEvent, MessageUpdateEvent } from "@oh-my-pi/pi-coding-agent";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { cfgExpandThinkingBlocks, cfgProseOnlyThinking, cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { Component } from "@oh-my-pi/pi-tui";
import type { AssistantThinkingRenderContext } from "@oh-my-pi/pi-tui/chat/extension-types";
import type { Theme } from "@oh-my-pi/pi-tui/theme/theme";
import { tr } from "../omomp-shared/i18n.ts";
import { resolveBlock, restartScan, type TrackedBlock, takeFinalLines, trackedBlock } from "./blocks.ts";
import { createLateNotifier } from "./late-notify.ts";
import { latinLines, lineKey, shouldTranslateLine } from "./lines.ts";
import { type BlockRenderer, type CellSource, createBlockRenderer } from "./renderer.ts";
import { type RoleBinding, resolveChain, roleBinding } from "./role.ts";
import { readSettings, sameSettings, type TranslatorSettings } from "./settings.ts";
import { type TranslateDeps, type TranslationCell, translateLine } from "./translate.ts";

const MAX_TRACKED_BLOCKS = 32;

export type TranslatorSession = Readonly<{
	render(context: AssistantThinkingRenderContext, theme: Theme): Component | undefined;
	agentStart(ctx: ExtensionContext): void;
	messageStart(ctx: ExtensionContext): void;
	messageUpdate(event: MessageUpdateEvent, ctx: ExtensionContext): void;
	messageEnd(event: MessageEndEvent, ctx: ExtensionContext): void;
	dispose(): void;
}>;

export function cellKeyPrefix(binding: RoleBinding, targetLanguage: string): string {
	return `${binding.primary}\u0000${binding.fallbacks.join("\u0001")}\u0000${targetLanguage}\u0000`;
}

export function createSession(pi: ExtensionAPI, initialContext: ExtensionContext): TranslatorSession {
	const host = pi.pi.settings;
	const log = (event: string, data: Record<string, unknown>): void => pi.logger.debug(`thinking-translator: ${event}`, data);
	let ctx = initialContext;
	let disposed = false;
	const controller = new AbortController();
	let settings: TranslatorSettings | undefined;
	let prefix: string | undefined;
	const cells = new Map<string, TranslationCell>();
	const blocks = new Map<string, TrackedBlock>();
	const renderers = new Map<string, BlockRenderer>();
	const discoveries = new Map<string, Promise<void>>();
	const notified = new Set<string>();
	let messageSeq = 0;
	let nativeSeen = false;

	const notifyOnce = (key: string, message: string, level: "info" | "warning"): void => {
		if (notified.has(key)) return;
		notified.add(key);
		ctx.ui.notify(message, level);
	};

	const late = createLateNotifier({
		notify: (text) => ctx.ui.notify(text, "info"),
		setTimeout: (callback, ms) => ctx.setTimeout(callback, ms),
		clearTimer: (timer) => ctx.clearTimer(timer),
		log,
	});

	const deps: TranslateDeps = {
		resolveChain: () => resolveChain(host, ctx, discover),
		async auth(model) {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (auth.ok === false) throw new Error(auth.error || tr("Failed to get translator model credentials", "获取翻译模型凭据失败"));
			return { apiKey: auth.apiKey, headers: auth.headers };
		},
		sleep(ms, signal) {
			const { promise, resolve } = Promise.withResolvers<boolean>();
			if (signal.aborted) return Promise.resolve(false);
			const onAbort = (): void => {
				ctx.clearTimer(timer);
				resolve(false);
			};
			const timer = ctx.setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve(true);
			}, ms);
			signal.addEventListener("abort", onAbort, { once: true });
			return promise;
		},
		log,
	};

	async function discover(providers: readonly string[]): Promise<void> {
		await Promise.all(
			providers.map((provider) => {
				let running = discoveries.get(provider);
				if (!running) {
					log("discover", { provider });
					running = ctx.modelRegistry
						.refreshDiscoverableProviders([provider], "online")
						.catch(() => undefined)
						.finally(() => discoveries.delete(provider));
					discoveries.set(provider, running);
				}
				return running;
			}),
		);
	}

	const proseOnly = (): boolean => cfgProseOnlyThinking.get(host);

	function dispatch(block: TrackedBlock): void {
		const view = block.view;
		if (disposed || view === undefined || settings === undefined) return;
		if (prefix === undefined) {
			if (settings.enabled && !roleBinding(host))
				notifyOnce(
					"unbound",
					tr(
						"thinking-translator: bind the @omp-thinking-translator model role in /model to translate thinking",
						"thinking-translator：在 /model 中绑定 @omp-thinking-translator 模型角色后才会翻译 thinking",
					),
					"info",
				);
			return;
		}
		const current = prefix;
		const targetLanguage = settings.targetLanguage;
		let started = 0;
		for (const line of takeFinalLines(block, proseOnly())) {
			if (!shouldTranslateLine(line)) continue;
			const key = current + lineKey(line);
			if (cells.has(key)) continue;
			const cell: TranslationCell = { progress: { status: "pending" }, painted: false };
			cells.set(key, cell);
			started++;
			void translateLine(line, targetLanguage, deps, controller.signal).then((outcome) => {
				if (outcome === undefined || disposed) return;
				cell.progress = outcome;
				view.requestRender();
				switch (outcome.status) {
					case "done":
						if (settings?.lateNotify && !nativeSeen && !cell.painted) late.enqueue(view.thinkingIndex, cell, outcome.translation);
						return;
					case "error":
						notifyOnce(
							`failure:${outcome.models.join(",")}`,
							tr("Thinking translation failed: ", "思考翻译失败：") + outcome.error,
							"warning",
						);
						return;
				}
			});
		}
		if (started > 0) log("dispatch", { block: block.id, started });
	}

	function redispatchAll(): void {
		for (const block of blocks.values()) {
			restartScan(block);
			dispatch(block);
			block.view?.requestRender();
		}
	}

	function activate(): void {
		const binding = settings?.enabled ? roleBinding(host) : undefined;
		const next = binding && settings ? cellKeyPrefix(binding, settings.targetLanguage) : undefined;
		if (next === prefix) return;
		prefix = next;
		log("activate", { translating: next !== undefined, binding: binding?.primary, targetLanguage: settings?.targetLanguage });
		redispatchAll();
	}

	function reloadSettings(cwd: string): void {
		void readSettings(pi.logger, cwd).then((next) => {
			if (disposed) return;
			const previous = settings;
			settings = next;
			if (!next.lateNotify) late.reset();
			if (previous === undefined || !sameSettings(previous, next)) activate();
		});
	}

	function upsert(contentIndex: number, raw: string, ended: boolean): TrackedBlock {
		const id = `${messageSeq}:${contentIndex}`;
		let block = blocks.get(id);
		if (block) {
			block.raw = raw;
			block.ended = ended;
		} else {
			block = trackedBlock(id, contentIndex, raw, ended);
			blocks.set(id, block);
		}
		return block;
	}

	const source: CellSource = {
		prefix: () => prefix,
		cell: (key) => cells.get(key),
		painted(cell, thinkingIndex) {
			cell.painted = true;
			log("painted", { thinkingIndex });
		},
		nativeSeen() {
			nativeSeen = true;
		},
		expandThinkingBlocks: () => cfgExpandThinkingBlocks.get(host),
	};

	const unsubscribe = [
		cfgProseOnlyThinking.listen(host, redispatchAll),
		cfgModelRoles.listen(host, activate),
		cfgRetryFallbackChains.listen(host, activate),
	];
	reloadSettings(initialContext.cwd);

	return {
		render(context, theme) {
			const block = resolveBlock(blocks, context.text, context.contentIndex, proseOnly());
			if (block === undefined) {
				const current = prefix;
				if (current === undefined || !latinLines(context.text).some((line) => cells.has(current + lineKey(line)))) return undefined;
				return createBlockRenderer(source, context, theme).component;
			}
			const firstDraw = block.view === undefined;
			if (block.view) {
				block.view.thinkingIndex = context.thinkingIndex;
				block.view.requestRender = context.requestRender;
				block.view.text = context.text;
			} else block.view = { thinkingIndex: context.thinkingIndex, requestRender: context.requestRender, text: context.text };
			// One box per block: omp calls the factory on every display change, and a new component each time
			// would get a new native id, making the reconciler delete and re-add the whole section per frame.
			let renderer = renderers.get(block.id);
			if (renderer) renderer.update(context, theme);
			else {
				renderer = createBlockRenderer(source, context, theme);
				renderers.set(block.id, renderer);
			}
			if (firstDraw) queueMicrotask(() => dispatch(block));
			return renderer.component;
		},
		agentStart(next) {
			ctx = next;
			reloadSettings(next.cwd);
		},
		messageStart(next) {
			ctx = next;
			messageSeq++;
			late.noteMounted();
			for (const id of blocks.keys()) {
				if (blocks.size <= MAX_TRACKED_BLOCKS) break;
				blocks.delete(id);
				renderers.delete(id);
			}
		},
		messageUpdate(event, next) {
			ctx = next;
			const update = event.assistantMessageEvent;
			switch (update.type) {
				case "toolcall_start":
					late.noteMounted();
					return;
				case "thinking_delta": {
					const content = update.partial.content[update.contentIndex];
					if (content?.type !== "thinking") return;
					const block = upsert(update.contentIndex, content.thinking, false);
					if (update.delta.includes("\n")) dispatch(block);
					return;
				}
				case "thinking_end":
					dispatch(upsert(update.contentIndex, update.content, true));
					return;
				default:
					return;
			}
		},
		messageEnd(event, next) {
			ctx = next;
			if (event.message.role === "assistant")
				for (const [contentIndex, content] of event.message.content.entries())
					if (content.type === "thinking") dispatch(upsert(contentIndex, content.thinking, true));
		},
		dispose() {
			disposed = true;
			controller.abort();
			for (const stop of unsubscribe) stop();
			late.reset();
			cells.clear();
			blocks.clear();
			renderers.clear();
		},
	};
}
