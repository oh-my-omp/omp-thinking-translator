import test from "node:test";
import assert from "node:assert/strict";
import { __testing } from "../extensions/thinking-translator.ts";
import { LANGUAGE_ENV, language, resolveLanguage, tr } from "../extensions/i18n.ts";
import { formatThinkingForDisplay } from "../node_modules/@oh-my-pi/pi-tui/src/chat/thinking-display.ts";

// Error-message assertions below use English regardless of the developer's locale or omomp config.
process.env[LANGUAGE_ENV] = "en";

const blockLabel = (index: number): string => tr(`Block ${index}`, `第 ${index} 块`);
const lateHeader = (labels: readonly string[]): string =>
	tr(`Thinking translation · ${labels.join(", ")}`, `思考翻译 · ${labels.join("、")}`);
test("language resolution follows explicit env, omomp, locale, and call-time changes", () => {
	assert.equal(resolveLanguage({ OMOMP_LANG: " ZH ", LC_ALL: "en_US.UTF-8" }, "en"), "zh");
	assert.equal(resolveLanguage({ OMOMP_LANG: "invalid", LC_ALL: "", LC_MESSAGES: "  ", LANG: "zh_CN.UTF-8" }, "en"), "en");
	assert.equal(resolveLanguage({ OMOMP_LANG: "invalid", LC_ALL: "", LC_MESSAGES: "  ", LANG: "zh_CN.UTF-8" }), "zh");
	assert.equal(resolveLanguage({ OMOMP_LANG: "invalid", LC_ALL: "en_US.UTF-8", LC_MESSAGES: "zh_CN.UTF-8" }), "en");
	assert.equal(resolveLanguage({}), "en");

	const previous = process.env[LANGUAGE_ENV];
	try {
		process.env[LANGUAGE_ENV] = "en";
		assert.equal(language(), "en");
		process.env[LANGUAGE_ENV] = "ZH";
		assert.equal(language(), "zh");
	} finally {
		if (previous === undefined) delete process.env[LANGUAGE_ENV];
		else process.env[LANGUAGE_ENV] = previous;
	}
});


test("config paths honor the active omp agent directory and project root", () => {
	assert.equal(__testing.getGlobalConfigPath("/profiles/work/agent", "/home/user"), "/profiles/work/agent/thinking-translator.json");
	assert.equal(__testing.getGlobalConfigPath(undefined, "/home/user"), "/home/user/.omp/agent/thinking-translator.json");
	assert.equal(__testing.getProjectConfigPath("/projects/demo"), "/projects/demo/.omp/thinking-translator.json");
	assert.equal(__testing.getProjectConfigPath(undefined), undefined);
});

test("a short single-line thinking block is translatable", () => {
	// 复现用户报告：短 thinking 紧接工具调用时整块长度门槛把它整块跳过了。
	const line = "Let me check the session_init entry in the child, it might contain agent info.";
	assert.equal(__testing.shouldTranslateLine(line), true);
	assert.deepEqual(__testing.splitTranslationLines(line), [line]);
});

test("legacy and unknown fields are ignored without losing valid overrides", () => {
	const config = __testing.mergeConfig(__testing.DEFAULT_CONFIG, {
		contentTypes: ["text"], extra: 123, targetLanguage: "Japanese",
		translatorModel: { provider: "old", id: "single" },
		translatorModels: [{ provider: "faux", id: "translator" }],
	});
	assert.equal(config.targetLanguage, "Japanese");
	assert.deepEqual(config.translatorModels, [{ provider: "faux", id: "translator" }]);
	assert.equal("contentTypes" in config, false);
	assert.equal("extra" in config, false);
	assert.equal("translatorModel" in config, false);
});

test("invalid known fields fail closed instead of enabling unexpected requests", () => {
	for (const value of [null, [], { enabled: "yes" }, { targetLanguage: "" }]) {
		assert.throws(() => __testing.mergeConfig(__testing.DEFAULT_CONFIG, value));
	}
	// 拼错或类型不对的 effort 让整份配置无效，而不是静默回落到模型默认强度；报错指明是链上的第几个。
	for (const effort of ["fast", "Low", "", 1, true]) {
		assert.throws(
			() => __testing.mergeConfig(__testing.DEFAULT_CONFIG, { translatorModels: [{ provider: "bansos", id: "a" }, { provider: "bansos", id: "m", effort }] }),
			/translatorModels\[1\]\.effort must be one of: off, minimal, low, medium, high, xhigh, max/,
		);
	}
});

test("the removed minLatinChars key is ignored instead of gating translation", () => {
	const layered = __testing.mergeConfig(__testing.DEFAULT_CONFIG, { targetLanguage: "English", minLatinChars: 250 });
	assert.equal(layered.targetLanguage, "English");
	assert.equal("minLatinChars" in layered, false);
});

test("translatorModels keeps the configured order and effort per entry", () => {
	const chain = __testing.mergeConfig(__testing.DEFAULT_CONFIG, {
		translatorModels: [
			{ provider: "bansos", id: "first", effort: "minimal" },
			{ provider: "deepseek", id: "second" },
			{ provider: "ollama", id: "third", effort: null },
		],
	});
	assert.deepEqual(chain.translatorModels, [
		{ provider: "bansos", id: "first", effort: "minimal" },
		{ provider: "deepseek", id: "second" },
		{ provider: "ollama", id: "third" },
	]);
});

test("a project translatorModels replaces the whole global chain, null clears it, absence keeps it", () => {
	const global = __testing.mergeConfig(__testing.DEFAULT_CONFIG, {
		translatorModels: [{ provider: "bansos", id: "a", effort: "low" }, { provider: "bansos", id: "b" }],
	});
	assert.deepEqual(__testing.mergeConfig(global, { translatorModels: [{ provider: "ollama", id: "c" }] }).translatorModels, [{ provider: "ollama", id: "c" }]);
	assert.deepEqual(__testing.mergeConfig(global, { translatorModels: null }).translatorModels, []);
	assert.deepEqual(__testing.mergeConfig(global, {}).translatorModels, global.translatorModels);
});

test("reasoningOptions leaves the provider default alone when unset and maps off to disabled reasoning", () => {
	// 未设置时不能带任何推理字段，否则会覆盖 provider 的默认强度。
	assert.deepEqual(__testing.reasoningOptions(undefined), {});
	assert.deepEqual(__testing.reasoningOptions("off"), { disableReasoning: true });
	assert.deepEqual(__testing.reasoningOptions("low"), { reasoning: "low" });
});

test("normalizeTranslatorModels rejects non-arrays and incomplete entries instead of dropping them", () => {
	for (const value of [{ provider: "ollama", id: "x" }, "ollama", 123]) {
		assert.throws(() => __testing.normalizeTranslatorModels(value, []), /translatorModels must be an array/);
	}
	// 链里悄悄少一个模型会改变回退顺序，所以不完整的项让配置无效，而不是被跳过。
	assert.throws(() => __testing.normalizeTranslatorModels([{ provider: "ollama", id: "a" }, { provider: "ollama" }], []), /translatorModels\[1\]\.id must be a non-empty string/);
	assert.throws(() => __testing.normalizeTranslatorModels([{ id: "a" }], []), /translatorModels\[0\]\.provider must be a non-empty string/);
	assert.throws(() => __testing.normalizeTranslatorModels([{ provider: " ", id: "a" }], []), /translatorModels\[0\]\.provider/);
	assert.throws(() => __testing.normalizeTranslatorModels(["ollama/a"], []), /translatorModels\[0\] must be an object/);
	assert.deepEqual(__testing.normalizeTranslatorModels([], [{ provider: "ollama", id: "a" }]), []);
});

test("shouldTranslateLine accepts foreign lines of any length and rejects the rest", () => {
	assert.equal(__testing.shouldTranslateLine("OK."), true);
	assert.equal(__testing.shouldTranslateLine("abcde你好"), true);
	assert.equal(__testing.shouldTranslateLine("abcde你好啊你好"), false);
	assert.equal(__testing.shouldTranslateLine("已经确认过了。"), false);
	assert.equal(__testing.shouldTranslateLine("123 —— 456"), false);
	assert.equal(__testing.shouldTranslateLine(""), false);
});

test("shouldTranslateLine ignores inline code when classifying Chinese prose", () => {
	const chineseWithIdentifiers =
		"还有一点：展示文本每次变化都会重建渲染组件，导致 `userCollapsed` 也被重置，核心修复是让默认折叠状态跟随 `expandThinkingBlocks`（`collapsed = userCollapsed ?? (!live && !expand)`）。接下来我会查扩展 API 能否读取该设置，并检查 `CLAUDE.md`、`AGENTS.md` 中的仓库约束。";
	assert.equal(__testing.shouldTranslateLine(chineseWithIdentifiers), false);
	assert.equal(__testing.shouldTranslateLine("Call `registerAssistantThinkingRenderer` after checking the API."), true);
});

test("matchBlockLine returns the raw line for host rewrites and rejects reveal prefixes", () => {
	const raw = "Check the parser first.\n```ts\nconst x = 1;\n```\nThen run the tests.";
	assert.equal(__testing.matchBlockLine(raw, "Check the parser first."), "Check the parser first.");
	assert.equal(__testing.matchBlockLine(raw, "Then run the tests."), "Then run the tests.");
	// 宿主折叠代码围栏时会把前一行改成省略号收尾，有时还吃掉句末句号；都要认回同一原文行。
	assert.equal(__testing.matchBlockLine(raw, "Check the parser first...."), "Check the parser first.");
	assert.equal(__testing.matchBlockLine(raw, "Check the parser first…"), "Check the parser first.");
	// 流式揭示的前缀每次重绘都是新键，必须挡住，否则一行会被翻译成好几份。
	assert.equal(__testing.matchBlockLine(raw, "Check the par"), undefined);
	assert.equal(__testing.matchBlockLine(raw, "Then run the te"), undefined);
	// 历史消息的行不属于当前块，不会被重新分发。
	assert.equal(__testing.matchBlockLine(raw, "A line from an older message."), undefined);
	// 块尾没有换行时末行仍然算完整。
	assert.equal(__testing.matchBlockLine("Only one line here.", "Only one line here."), "Only one line here.");
});

/**
 * 实测的缺陷：揭示到句末句号前一个字符的那一帧，展示行只比原文少一个句号，会被当成完整行接受；
 * 若按展示行做键，它和下一帧的完整行是两个格，同一行翻两次，先完成的那格再也画不上去，只能走迟到通知。
 */
test("a reveal frame missing only the final period shares the full line's cell", () => {
	const raw = "I am trying to recall who Tibo is, possibly focused on screen-time or focus.\n\nActually, this might be Tibo Louis-Lucas.\n";
	const streaming = [{ raw, ended: false }];
	const full = "I am trying to recall who Tibo is, possibly focused on screen-time or focus.";
	assert.equal(__testing.resolveTrackedLine(streaming, full.slice(0, -1)), full);
	assert.equal(__testing.resolveTrackedLine(streaming, full), full);
	assert.equal(
		__testing.cellKey(__testing.DEFAULT_CONFIG, __testing.resolveTrackedLine(streaming, full.slice(0, -1))!),
		__testing.cellKey(__testing.DEFAULT_CONFIG, __testing.resolveTrackedLine(streaming, full)!),
	);
});

/**
 * 实测的缺陷：上一条消息的 thinking 组件在下一条消息里仍会被重绘。
 * 按块下标认原文时，它拿到的是新块的原文，整块思考一句都译不出来。
 */
test("a line still matches while a newer thinking block is in flight", () => {
	const older = { raw: "The queue drains at 120 per second.\nSo the retry budget matters.", ended: true };
	const newer = { raw: "Now I need to compare the three settings", ended: false };
	const blocks = [older, newer];
	assert.equal(__testing.resolveTrackedLine(blocks, "The queue drains at 120 per second."), "The queue drains at 120 per second.");
	assert.equal(__testing.resolveTrackedLine(blocks, "So the retry budget matters."), "So the retry budget matters.");
	// 只看新块时，旧块的行就是"查不到原文"，这正是整段不翻译的现场。
	assert.equal(__testing.resolveTrackedLine([newer], "So the retry budget matters."), undefined);
});

test("the tail of a streaming block waits for that block to end", () => {
	const raw = "The queue drains at 120 per second.\nSo the retry budget";
	// 生成中：原文末尾只是"暂时到这儿"，这一行还会继续长。
	assert.equal(__testing.resolveTrackedLine([{ raw, ended: false }], "So the retry budget"), undefined);
	assert.equal(__testing.resolveTrackedLine([{ raw, ended: false }], "The queue drains at 120 per second."), "The queue drains at 120 per second.");
	// 收尾后（含 provider 漏发 thinking_end、由 message_end 兜底的情况）末行才定型。
	assert.equal(__testing.resolveTrackedLine([{ raw, ended: true }], "So the retry budget"), "So the retry budget");
});

/**
 * 宿主真的会改写展示文本：prose-only 模式下折叠代码围栏、补省略号、吃掉句末句号、丢掉空注释。
 * 这些改写过的行必须仍能认回原文，否则它们在译文框里永远没有自己的格。
 */
test("every line the host still displays matches its raw thinking", () => {
	const samples = [
		"Let me check the config file first.\n```json\n{\"a\": 1}\n```\nThen I will run the tests.",
		"The helper currently looks like this:\n```ts\nfunction parse(input: string) {\n  return input.trim();\n}\n```\nSo trailing whitespace is dropped.",
		"I will sketch the helper now.\n```ts\nfunction f() {",
		"First I confirm the path.\n<!-- -->\n<!--   -->\nThen I read the file.",
	];
	for (const raw of samples) {
		const displayed = __testing.splitTranslationLines(formatThinkingForDisplay(raw, true));
		assert.notEqual(displayed.length, 0, `host displayed nothing for ${JSON.stringify(raw)}`);
		for (const line of displayed) {
			if (!__testing.shouldTranslateLine(line)) continue;
			assert.notEqual(__testing.matchBlockLine(raw, line), undefined, `display line has no slot: ${JSON.stringify(line)}`);
		}
	}
});

test("cellKey separates model chain, order, effort, and target language", () => {
	const first = { provider: "ollama", id: "qwen2.5:7b" };
	const second = { provider: "deepseek", id: "flash" };
	const base = { ...__testing.DEFAULT_CONFIG, translatorModels: [first, second] };
	const line = "Check the parser first.";
	assert.notEqual(__testing.cellKey(base, line), __testing.cellKey({ ...base, targetLanguage: "Japanese" }, line));
	assert.notEqual(__testing.cellKey(base, line), __testing.cellKey({ ...base, translatorModels: [first] }, line));
	// 顺序决定先用谁，换顺序后同一行要重新翻译。
	assert.notEqual(__testing.cellKey(base, line), __testing.cellKey({ ...base, translatorModels: [second, first] }, line));
	// 换推理强度后同一行要重新翻译，不能复用默认强度下的译文。
	const withEffort = (effort: "off" | "low" | "high") => ({ ...base, translatorModels: [{ ...first, effort }, second] });
	assert.notEqual(__testing.cellKey(base, line), __testing.cellKey(withEffort("low"), line));
	assert.notEqual(__testing.cellKey(withEffort("low"), line), __testing.cellKey(withEffort("high"), line));
	assert.notEqual(__testing.cellKey(withEffort("off"), line), __testing.cellKey(withEffort("low"), line));
	assert.equal(__testing.cellKey(base, line), __testing.cellKey({ ...base, translatorModels: [{ ...first }, { ...second }] }, line));
});

test("cleanTranslation removes common model wrappers", () => {
	assert.equal(__testing.cleanTranslation("```markdown\n你好\n```"), "你好");
	assert.equal(__testing.cleanTranslation("<thinking>\n你好\n</thinking>"), "你好");
	assert.equal(__testing.cleanTranslation("<text>\n你好\n</text>"), "你好");
});

test("cleanTranslation preserves normal internal text", () => {
	assert.equal(__testing.cleanTranslation("hello   world"), "hello   world");
	assert.equal(__testing.cleanTranslation("first line\nsecond   line"), "first line\nsecond   line");
	assert.equal(__testing.cleanTranslation("  hello   world  "), "hello   world");
});

test("SOURCE_TEXT_BEGIN aborts the current model attempt so fallback can continue", () => {
	const controller = new AbortController();
	__testing.abortOnSourceTextBegin("SOURCE_TEXT_BEGI", controller);
	assert.equal(controller.signal.aborted, false);
	assert.throws(
		() => __testing.abortOnSourceTextBegin("SOURCE_TEXT_BEGIN\nEchoed source text", controller),
		/Translator returned SOURCE_TEXT_BEGIN/,
	);
	assert.equal(controller.signal.aborted, true);
});

test("line requests preserve order and duplicates while omitting non-Latin lines", () => {
	assert.deepEqual(__testing.splitTranslationLines("\n first\r\n\n中文\n123\nsecond\nfirst\n"), ["first", "second", "first"]);
});

test("splitTranslationLines returns empty for all-whitespace input", () => {
	assert.deepEqual(__testing.splitTranslationLines("   \n \t \n  "), []);
	assert.deepEqual(__testing.splitTranslationLines(""), []);
});

test("splitTranslationLines trims outer indent but keeps internal spacing", () => {
	assert.deepEqual(__testing.splitTranslationLines("  hello   world  "), ["hello   world"]);
	assert.deepEqual(__testing.splitTranslationLines("  foo  bar  \n  baz   qux  "), ["foo  bar", "baz   qux"]);
});

test("buildLateRows omits translations whose boxes were already painted", () => {
	const paintedOnly = __testing.buildLateRows(
		[{ thinkingIndex: 0, text: "已经画进框里", painted: true }],
		undefined,
		false,
	);
	assert.equal(paintedOnly, undefined);

	const mixed = __testing.buildLateRows(
		[
			{ thinkingIndex: 0, text: "已经画进框里", painted: true },
			{ thinkingIndex: 0, text: "还没有画上", painted: false },
		],
		undefined,
		false,
	);
	assert.equal(mixed?.text, `${lateHeader([blockLabel(1)])}\n还没有画上`);
});

test("buildLateRows merges back-to-back late translations into one payload", () => {
	const payload = __testing.buildLateRows(
		[
			{ thinkingIndex: 1, text: "第一段译文", painted: false },
			{ thinkingIndex: 1, text: "第二段译文", painted: false },
		],
		undefined,
		false,
	);
	assert.equal(payload?.text, `${lateHeader([blockLabel(2)])}\n第一段译文\n第二段译文`);
});

test("buildLateRows carries the previous payload only while coalescing is possible", () => {
	const previous = __testing.buildLateRows(
		[{ thinkingIndex: 1, text: "上一段译文", painted: false }],
		undefined,
		false,
	);
	assert.ok(previous);

	const merged = __testing.buildLateRows(
		[{ thinkingIndex: 1, text: "新的一段译文", painted: false }],
		previous,
		true,
	);
	assert.equal(merged?.text, `${lateHeader([blockLabel(2)])}\n上一段译文\n新的一段译文`);

	const fresh = __testing.buildLateRows(
		[{ thinkingIndex: 2, text: "下一块译文", painted: false }],
		previous,
		false,
	);
	assert.equal(fresh?.text, `${lateHeader([blockLabel(3)])}\n下一块译文`);
});

test("buildLateRows keeps distinct block sources in one header line", () => {
	const payload = __testing.buildLateRows(
		[
			{ thinkingIndex: 0, text: "第一块译文", painted: false },
			{ thinkingIndex: 1, text: "第二块译文", painted: false },
		],
		undefined,
		false,
	);
	assert.equal(payload?.text, `${lateHeader([blockLabel(1), blockLabel(2)])}\n第一块译文\n第二块译文`);
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
			const previous = __testing.buildLateRows(queued.slice(0, 1), undefined, false);
			assert.ok(previous);
			assert.deepEqual(previous.rows, [{ thinkingIndex: 1, text: "older" }]);

			process.env[LANGUAGE_ENV] = current;
			const fresh = __testing.buildLateRows(queued, undefined, false);
			const coalesced = __testing.buildLateRows(queued.slice(1), previous, true);
			assert.equal(fresh?.text, `${expectedHeader}\nolder\nnewer\nsame block`);
			assert.equal(coalesced?.text, fresh?.text);
			assert.deepEqual(coalesced?.rows, fresh?.rows);
			assert.equal(
				__testing.buildLateRows(queued.map((row) => ({ ...row, painted: true })), previous, true),
				undefined,
			);
		}
	} finally {
		if (previousLanguage === undefined) delete process.env[LANGUAGE_ENV];
		else process.env[LANGUAGE_ENV] = previousLanguage;
	}
});
