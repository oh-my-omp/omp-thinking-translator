import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { emptyUsage } from "@oh-my-pi/pi-ai/images/shared";
import { buildDisplayMessage } from "@oh-my-pi/pi-coding-agent/modes/controllers/streaming-reveal";
import { formatThinkingForDisplay } from "@oh-my-pi/pi-tui/chat/thinking-display";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { LANGUAGE_ENV, tr } from "../omomp-shared/i18n.ts";
import { resolveBlock, takeFinalLines, trackedBlock } from "../src/blocks.ts";
import { buildLateRows } from "../src/late-notify.ts";
import { latinLines, lineKey, shouldTranslateLine } from "../src/lines.ts";
import { bindingProviders, reasoningOptions } from "../src/role.ts";
import { cellKeyPrefix } from "../src/session.ts";
import { DEFAULT_SETTINGS, parseSettings } from "../src/settings.ts";
import { cleanTranslation, scanForSourceTextBegin } from "../src/translate.ts";

process.env[LANGUAGE_ENV] = "en";

const blockLabel = (index: number): string => tr(`Block ${index}`, `第 ${index} 块`);
const lateHeader = (labels: readonly string[]): string =>
	tr(`Thinking translation · ${labels.join(", ")}`, `思考翻译 · ${labels.join("、")}`);

const REWRITTEN_SAMPLES = [
	'Let me check the config file first.\n```json\n{"a": 1}\n```\nThen I will run the tests.',
	"The helper currently looks like this:\n```ts\nfunction parse(input: string) {\n  return input.trim();\n}\n```\nSo trailing whitespace is dropped.",
	"I will sketch the helper now.\n```ts\nfunction f() {",
	"First I confirm the path.\n<!-- -->\n<!--   -->\nThen I read the file.",
	"Plain line one.\nPlain line two.\n\nPlain line three after a blank line.",
];

function streamed(raw: string, size: number): string[] {
	const prefixes: string[] = [];
	for (let end = size; end < raw.length; end += size) prefixes.push(raw.slice(0, end));
	prefixes.push(raw);
	return prefixes;
}

test("plugin settings fall back to their defaults for unset and invalid values", () => {
	assert.deepEqual(parseSettings({}), { settings: DEFAULT_SETTINGS, invalid: [] });
	assert.deepEqual(parseSettings({ enabled: false, targetLanguage: "  Japanese ", lateNotify: true, extra: 1 }), {
		settings: { enabled: false, targetLanguage: "Japanese", lateNotify: true },
		invalid: [],
	});
	assert.deepEqual(parseSettings({ enabled: "yes", targetLanguage: "   ", lateNotify: 1 }), {
		settings: DEFAULT_SETTINGS,
		invalid: ["targetLanguage", "enabled", "lateNotify"],
	});
});

test("a selector's thinking level maps onto streamSimple's reasoning options", () => {
	assert.deepEqual(reasoningOptions(undefined), {});
	assert.deepEqual(reasoningOptions(parseConfiguredThinkingLevel("auto")), {});
	assert.deepEqual(reasoningOptions(parseConfiguredThinkingLevel("off")), { disableReasoning: true });
	assert.deepEqual(reasoningOptions(parseConfiguredThinkingLevel("low")), { reasoning: "low" });
	assert.deepEqual(reasoningOptions(parseConfiguredThinkingLevel("max")), { reasoning: "max" });
});

test("discovery covers every provider the binding names, once each", () => {
	assert.deepEqual(bindingProviders({ primary: "litellm/qwen3:low", fallbacks: ["deepseek/flash", "litellm/other", "@smol", "bare-id"] }), [
		"litellm",
		"deepseek",
	]);
	assert.deepEqual(bindingProviders({ primary: "@smol", fallbacks: [] }), []);
});

test("the cell key prefix separates binding, fallback order and level, and target language", () => {
	const base = { primary: "ollama/qwen2.5:7b", fallbacks: ["deepseek/flash", "openai/mini"] };
	const prefix = cellKeyPrefix(base, "Simplified Chinese");
	assert.equal(prefix, cellKeyPrefix({ primary: base.primary, fallbacks: [...base.fallbacks] }, "Simplified Chinese"));
	assert.notEqual(prefix, cellKeyPrefix(base, "Japanese"));
	assert.notEqual(prefix, cellKeyPrefix({ ...base, primary: "ollama/qwen2.5:7b:low" }, "Simplified Chinese"));
	assert.notEqual(prefix, cellKeyPrefix({ ...base, fallbacks: ["openai/mini", "deepseek/flash"] }, "Simplified Chinese"));
	assert.notEqual(prefix, cellKeyPrefix({ ...base, fallbacks: ["deepseek/flash"] }, "Simplified Chinese"));
});

test("shouldTranslateLine accepts foreign lines of any length and rejects the rest", () => {
	assert.equal(shouldTranslateLine("Let me check the session_init entry in the child, it might contain agent info."), true);
	assert.equal(shouldTranslateLine("OK."), true);
	assert.equal(shouldTranslateLine("abcde你好"), true);
	assert.equal(shouldTranslateLine("abcde你好啊你好"), false);
	assert.equal(shouldTranslateLine("已经确认过了。"), false);
	assert.equal(shouldTranslateLine("123 —— 456"), false);
	assert.equal(shouldTranslateLine(""), false);
});

test("shouldTranslateLine ignores inline code when classifying Chinese prose", () => {
	const chineseWithIdentifiers =
		"还有一点：展示文本每次变化都会重建渲染组件，导致 `userCollapsed` 也被重置，核心修复是让默认折叠状态跟随 `expandThinkingBlocks`（`collapsed = userCollapsed ?? (!live && !expand)`）。接下来我会查扩展 API 能否读取该设置，并检查 `CLAUDE.md`、`AGENTS.md` 中的仓库约束。";
	assert.equal(shouldTranslateLine(chineseWithIdentifiers), false);
	assert.equal(shouldTranslateLine("Call `registerAssistantThinkingRenderer` after checking the API."), true);
});

test("latinLines keeps order and duplicates, trims, and drops lines without a Latin letter", () => {
	assert.deepEqual(latinLines("\n first\r\n\n中文\n123\nsecond\nfirst\n"), ["first", "second", "first"]);
	assert.deepEqual(latinLines(" \n\t\n"), []);
	assert.deepEqual(latinLines("   indented   words  "), ["indented   words"]);
});

test("a line, its reveal frame without the final period, and its fence-folded form share one key", () => {
	assert.equal(lineKey("Let me check the config file first."), "Let me check the config file first");
	assert.equal(lineKey("Let me check the config file first"), "Let me check the config file first");
	assert.equal(lineKey("Let me check the config file first..."), "Let me check the config file first");
	assert.equal(lineKey("Let me check the config file first…"), "Let me check the config file first");
	assert.notEqual(lineKey("Let me check the config"), lineKey("Let me check the config file first."));
});

test("final lines taken while a block streams are exactly the finished block's display lines", () => {
	for (const raw of REWRITTEN_SAMPLES)
		for (const size of [1, 7, 40]) {
			const block = trackedBlock("1:0", 0, "", false);
			const taken = new Set<string>();
			for (const prefix of streamed(raw, size)) {
				block.raw = prefix;
				for (const line of takeFinalLines(block, true)) taken.add(lineKey(line));
			}
			block.ended = true;
			for (const line of takeFinalLines(block, true)) taken.add(lineKey(line));
			const expected = new Set(latinLines(formatThinkingForDisplay(raw, true).trim()).map(lineKey));
			assert.deepEqual([...taken].sort(), [...expected].sort(), `chunk ${size}: ${JSON.stringify(raw)}`);
		}
});

test("a growing block's last line waits for a newline or the block's end", () => {
	const block = trackedBlock("1:0", 0, "First line is done.\nSecond line is still", false);
	assert.deepEqual(takeFinalLines(block, true), ["First line is done."]);
	block.raw = "First line is done.\nSecond line is still growing.";
	assert.deepEqual(takeFinalLines(block, true), ["First line is done."]);
	block.ended = true;
	assert.deepEqual(takeFinalLines(block, true), ["First line is done.", "Second line is still growing."]);
});

test("every reveal frame omp draws resolves to the block that produced it", () => {
	for (const raw of REWRITTEN_SAMPLES)
		for (const proseOnly of [true, false]) {
			const prefixes = streamed(raw, 5);
			for (const [index, prefix] of prefixes.entries()) {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "thinking", thinking: prefix }],
					api: "openai-completions",
					provider: "test",
					model: "test",
					usage: emptyUsage(),
					stopReason: "stop",
					timestamp: 0,
				};
				const units = [...new Intl.Segmenter().segment(formatThinkingForDisplay(prefix, proseOnly))].length;
				const later = trackedBlock("1:0", 0, prefixes[index + 1] ?? prefix, false);
				const current = trackedBlock("1:0", 0, prefix, false);
				const other = trackedBlock("0:0", 0, "An unrelated earlier thought.", true);
				for (let revealed = 1; revealed <= units; revealed += 3) {
					const shown = buildDisplayMessage(message, revealed, false, proseOnly).content[0];
					assert.equal(shown?.type, "thinking");
					const text = shown?.type === "thinking" ? shown.thinking.trim() : "";
					if (!text) continue;
					assert.equal(resolveBlock([other, current], text, 0, proseOnly), current, `frame ${JSON.stringify(text)}`);
					assert.equal(resolveBlock([other, later], text, 0, proseOnly), later, `stale frame ${JSON.stringify(text)}`);
				}
			}
		}
});

test("a block is resolved by content first and by content index only among matches", () => {
	const older = trackedBlock("1:0", 0, "Shared opening line.\nOlder ending.", true);
	const newer = trackedBlock("2:1", 1, "Shared opening line.\nNewer ending.", true);
	assert.equal(resolveBlock([older, newer], "Shared opening line.\nOlder", 1, true), older);
	assert.equal(resolveBlock([older, newer], "Shared opening line.", 0, true), older);
	assert.equal(resolveBlock([older, newer], "Shared opening line.", 1, true), newer);
	assert.equal(resolveBlock([older, newer], "Text from another session.", 0, true), undefined);
	assert.equal(resolveBlock([older, newer], "", 0, true), undefined);
});

test("a new block's first frames are not taken for an older drawn block that starts the same way", () => {
	const older = trackedBlock("2:0", 0, "The user asks which product is larger.\nSo 19*21 is larger.", true);
	older.view = { thinkingIndex: 0, requestRender: () => {}, text: "The user asks which product is larger.\nSo 19*21 is larger." };
	assert.equal(resolveBlock([older], "The user asks", 0, true), undefined);
	const newer = trackedBlock("4:0", 0, "The user asks whether 91 is prime.", false);
	assert.equal(resolveBlock([older, newer], "The user asks", 0, true), newer);
	assert.equal(resolveBlock([older, newer], "The user asks which product is larger.\nSo 19*21 is larger.", 0, true), older);
	older.raw = "The user asks which product is larger.";
	assert.equal(resolveBlock([older, newer], "The user asks which product is larger.", 0, true), older);
	newer.view = { thinkingIndex: 0, requestRender: () => {}, text: "The user asks" };
	assert.equal(resolveBlock([older, newer], "The user asks whether", 0, true), newer);
});

test("cleanTranslation removes common model wrappers and keeps the text inside", () => {
	assert.equal(cleanTranslation("```markdown\n你好\n```"), "你好");
	assert.equal(cleanTranslation("<thinking>\n你好\n</thinking>"), "你好");
	assert.equal(cleanTranslation("<text>\n你好\n</text>"), "你好");
	assert.equal(cleanTranslation("  hello   world  "), "hello   world");
	assert.equal(cleanTranslation("first line\nsecond   line"), "first line\nsecond   line");
});

test("SOURCE_TEXT_BEGIN aborts only the current attempt, also when split across two deltas", () => {
	const whole = new AbortController();
	assert.throws(() => scanForSourceTextBegin("", "SOURCE_TEXT_BEGIN\nEchoed source text", whole), /Translator returned SOURCE_TEXT_BEGIN/);
	assert.equal(whole.signal.aborted, true);

	const split = new AbortController();
	const tail = scanForSourceTextBegin("", "Here the model echoes SOURCE_TE", split);
	assert.equal(split.signal.aborted, false);
	assert.throws(() => scanForSourceTextBegin(tail, "XT_BEGIN and the input", split), /Translator returned SOURCE_TEXT_BEGIN/);
	assert.equal(split.signal.aborted, true);
});

test("the marker window carries only the characters a split marker can need", () => {
	const attempt = new AbortController();
	let tail = "";
	for (const delta of ["一段很长的译文，", "没有协议标记，", "只有 SOURCE_TEXT", "_END 这样的近似文字。"])
		tail = scanForSourceTextBegin(tail, delta, attempt);
	assert.equal(attempt.signal.aborted, false);
	assert.equal(tail.length, "SOURCE_TEXT_BEGIN".length - 1);
});

test("buildLateRows omits translations whose boxes were already painted", () => {
	assert.equal(buildLateRows([{ thinkingIndex: 0, text: "已经画进框里", painted: true }], undefined, false), undefined);
	const mixed = buildLateRows(
		[
			{ thinkingIndex: 0, text: "已经画进框里", painted: true },
			{ thinkingIndex: 0, text: "还没有画上", painted: false },
		],
		undefined,
		false,
	);
	assert.equal(mixed?.text, `${lateHeader([blockLabel(1)])}\n还没有画上`);
});

test("buildLateRows carries the previous payload only while coalescing is possible", () => {
	const previous = buildLateRows([{ thinkingIndex: 1, text: "上一段译文", painted: false }], undefined, false);
	assert.ok(previous);
	assert.equal(
		buildLateRows([{ thinkingIndex: 1, text: "新的一段译文", painted: false }], previous, true)?.text,
		`${lateHeader([blockLabel(2)])}\n上一段译文\n新的一段译文`,
	);
	assert.equal(
		buildLateRows([{ thinkingIndex: 2, text: "下一块译文", painted: false }], previous, false)?.text,
		`${lateHeader([blockLabel(3)])}\n下一块译文`,
	);
	assert.equal(
		buildLateRows(
			[
				{ thinkingIndex: 0, text: "第一块译文", painted: false },
				{ thinkingIndex: 1, text: "第二块译文", painted: false },
			],
			undefined,
			false,
		)?.text,
		`${lateHeader([blockLabel(1), blockLabel(2)])}\n第一块译文\n第二块译文`,
	);
});

test("buildLateRows localizes queued and coalesced block indices at notification time", () => {
	const previousLanguage = process.env[LANGUAGE_ENV];
	try {
		for (const [initial, current, expectedHeader] of [
			["en", "zh", "思考翻译 · 第 2 块、第 1 块"],
			["zh", "en", "Thinking translation · Block 2, Block 1"],
		]) {
			process.env[LANGUAGE_ENV] = initial;
			const queued = [
				{ thinkingIndex: 1, text: "older", painted: false },
				{ thinkingIndex: 0, text: "newer", painted: false },
				{ thinkingIndex: 1, text: "same block", painted: false },
			];
			const previous = buildLateRows(queued.slice(0, 1), undefined, false);
			assert.ok(previous);
			process.env[LANGUAGE_ENV] = current;
			const fresh = buildLateRows(queued, undefined, false);
			const coalesced = buildLateRows(queued.slice(1), previous, true);
			assert.equal(fresh?.text, `${expectedHeader}\nolder\nnewer\nsame block`);
			assert.equal(coalesced?.text, fresh?.text);
			assert.deepEqual(coalesced?.rows, fresh?.rows);
		}
	} finally {
		if (previousLanguage === undefined) delete process.env[LANGUAGE_ENV];
		else process.env[LANGUAGE_ENV] = previousLanguage;
	}
});
