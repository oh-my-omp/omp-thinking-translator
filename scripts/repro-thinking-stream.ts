#!/usr/bin/env bun
/**
 * Reproducible thinking-stream load for the render-time dispatch pipeline
 * (oh-my-omp/omp-thinking-translator#12).
 *
 * The driver stands in for the host: it feeds a seeded sequence of thinking deltas through the
 * extension's real event handlers, calls the renderer factory with the host's own display text
 * (`formatThinkingForDisplay`, prose-only) on every delta, renders every mounted component of the
 * current message once per frame, and repaints when the extension asks for it. Translations come
 * from a deterministic in-process provider registered through pi-ai's custom-API registry, so no
 * network, no model and nothing under ~/.omp is involved: each worker runs with
 * `PI_CODING_AGENT_DIR` and its project config inside a fresh temp directory.
 *
 *   bun scripts/repro-thinking-stream.ts --rows 200 [--baseline <extension.ts>] [--gc-off]
 *       GC-heap allocation and pause time from JSC's GC log, post-GC heap and active time; medians
 *       of --runs workers (default 5) for the extension, the null control and, if given, the baseline.
 *       `--gc-off` adds total allocation (GC heap + malloc'd string payloads) from workers that run
 *       with the collector disabled; such a worker holds every byte it allocates until it exits.
 *   bun scripts/repro-thinking-stream.ts --rows 800 --snapshot
 *       retained memory of the cell map's key/value strings against their own length
 *   bun scripts/repro-thinking-stream.ts --rows 200 --trace-diff --baseline <extension.ts>
 *       trace records and notify payloads of both extensions, factory records counted apart
 *   bun scripts/repro-thinking-stream.ts --rows 40 --frames <out.json>
 *       per-frame output (title + rows of every rendered component) for consistency checks
 *
 * `--shape block` (default) streams all rows as one thinking block, the reveal the findings
 * are about; `--shape session` spreads them over messages of two 25-row blocks.
 */
import { heapStats, memoryUsage as jscMemory } from "bun:jsc";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Shape = "block" | "session";
/** `ansi`: the host draws each component with `render(width)`; `native`: a Tern surface calls `describe(cx)` and its nested components. */
type Surface = "ansi" | "native";
type Mode = "measure" | "snapshot" | "frames";
/** The part of a host component the driver calls. */
type HostComponent = { render(width: number): readonly string[]; describe?(cx: { supports(kind: string): boolean }): unknown };
type Options = {
	rows: number;
	runs: number;
	shape: Shape;
	surface: Surface;
	extension: string;
	baseline: string | undefined;
	traceDiff: boolean;
	snapshot: boolean;
	gcOff: boolean;
	frames: string | undefined;
	worker: Mode | undefined;
	out: string | undefined;
};
/** One rendered frame of one component: which block, and the lines it drew. */
type Frame = { frame: number; thinkingIndex: number; lines: readonly string[] };
type WorkerResult = {
	/** Bytes allocated during the drive with the collector disabled (GC-heap cells plus malloc'd string payloads); 0 unless the worker ran with GC off. */
	allocBytes: number;
	heapAfterGc: number;
	mallocAfterGc: number;
	activeMs: number;
	frames: number;
	factoryCalls: number;
	notifies: number;
};
/** What JSC's own GC log says about the drive window: bytes allocated into the GC heap and total pause time. */
type GcLog = { gcAllocBytes: number; gcPauseMs: number; collections: number };
type WorkerOutput = { result: WorkerResult; traceFile: string; notifies: readonly string[]; frames?: readonly Frame[] };

const SCRIPT = resolve(import.meta.path);
const DEFAULT_EXTENSION = resolve(dirname(SCRIPT), "../extensions/thinking-translator.ts");
const NULL_EXTENSION = "null";
const PROVIDER = "ott-repro";
const SEED = 0x7a11;
const WIDTH = 100;
/** Rows per block in the session shape. */
const SESSION_BLOCK_ROWS = 25;
/** The extension's late-notify debounce is 400 ms; wait past it so every flush lands at a message boundary. */
const LATE_FLUSH_WAIT_MS = 450;
/** Microtask turns a landed translation needs to reach the cell: pi-ai stream wrappers plus the extension's awaits, with margin. */
const DRAIN_TURNS = 200;
/** Lines the worker writes to stderr around the measured drive, so the parent can cut the JSC GC log to it. */
const MARK_START = "OTT-REPRO drive start";
const MARK_END = "OTT-REPRO drive end";

function parseArgs(argv: readonly string[]): Options {
	const options: Options = {
		rows: 200,
		runs: 5,
		shape: "block",
		surface: "ansi",
		extension: DEFAULT_EXTENSION,
		baseline: undefined,
		traceDiff: false,
		snapshot: false,
		gcOff: false,
		frames: undefined,
		worker: undefined,
		out: undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		const value = (): string => {
			const next = argv[++i];
			if (next === undefined) throw new Error(`${arg} needs a value`);
			return next;
		};
		switch (arg) {
			case "--rows":
				options.rows = Number.parseInt(value(), 10);
				break;
			case "--runs":
				options.runs = Number.parseInt(value(), 10);
				break;
			case "--shape": {
				const shape = value();
				if (shape !== "block" && shape !== "session") throw new Error(`--shape must be block or session, got ${shape}`);
				options.shape = shape;
				break;
			}
			case "--surface": {
				const surface = value();
				if (surface !== "ansi" && surface !== "native") throw new Error(`--surface must be ansi or native, got ${surface}`);
				options.surface = surface;
				break;
			}
			case "--extension":
				options.extension = value();
				break;
			case "--baseline":
				options.baseline = resolve(value());
				break;
			case "--trace-diff":
				options.traceDiff = true;
				break;
			case "--gc-off":
				options.gcOff = true;
				break;
			case "--snapshot":
				options.snapshot = true;
				break;
			case "--frames":
				options.frames = resolve(value());
				break;
			case "--worker": {
				const mode = value();
				if (mode !== "measure" && mode !== "snapshot" && mode !== "frames") throw new Error(`unknown worker mode ${mode}`);
				options.worker = mode;
				break;
			}
			case "--out":
				options.out = value();
				break;
			default:
				throw new Error(`unknown argument ${arg}`);
		}
	}
	if (!Number.isInteger(options.rows) || options.rows <= 0) throw new Error("--rows must be a positive integer");
	if (!Number.isInteger(options.runs) || options.runs <= 0) throw new Error("--runs must be a positive integer");
	return options;
}

// ---------------------------------------------------------------- load

/** mulberry32: small, seedable, identical on every run. */
function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS =
	"the config loader reads every path before merging project overrides so a stale cache could hide the newest value which means I should check whether the renderer keeps its component identity across frames and if the dispatch still sends each finished line exactly once while the stream keeps growing at the tail".split(
		" ",
	);
const CODE = ["`loadConfig()`", "`liveBlocks`", "`matchBlockLine`", "`src/index.ts`", "`bun test`"];
const CJK = ["这里先确认配置路径是否正确。", "然后再看渲染器有没有复用组件。", "最后检查分发是否只发一次。"];

type Block = { raw: string; cuts: readonly number[] };
type Message = { blocks: readonly Block[] };

/** One thinking block of `rows` Latin rows with paragraph breaks, Chinese rows, inline code, a fenced snippet and a repeated row. */
function makeBlock(next: () => number, rows: number, serial: { value: number }): Block {
	const lines: string[] = [];
	const written: string[] = [];
	for (let row = 0; row < rows; row++) {
		const roll = next();
		if (roll < 0.04 && written.length > 3) {
			lines.push(written[Math.floor(next() * written.length)]!);
		} else {
			const count = 8 + Math.floor(next() * 14);
			const words: string[] = [];
			for (let w = 0; w < count; w++) words.push(next() < 0.06 ? CODE[Math.floor(next() * CODE.length)]! : WORDS[Math.floor(next() * WORDS.length)]!);
			words.push(`(step ${serial.value++})`);
			const sentence = words.join(" ");
			const line = sentence[0]!.toUpperCase() + sentence.slice(1) + ".";
			lines.push(line);
			written.push(line);
		}
		if (next() < 0.08) lines.push(CJK[Math.floor(next() * CJK.length)]!);
		if (next() < 0.03) lines.push("```ts", "const value = loadConfig(path);", "```");
		if (next() < 0.18) lines.push("");
	}
	const raw = lines.join("\n");
	const cuts: number[] = [];
	for (let at = 0; at < raw.length; ) {
		at = Math.min(raw.length, at + 16 + Math.floor(next() * 33));
		cuts.push(at);
	}
	return { raw, cuts };
}

function makeLoad(rows: number, shape: Shape): Message[] {
	const next = rng(SEED);
	const serial = { value: 1 };
	if (shape === "block") return [{ blocks: [makeBlock(next, rows, serial)] }];
	const messages: Message[] = [];
	for (let left = rows; left > 0; ) {
		const blocks: Block[] = [];
		for (let b = 0; b < 2 && left > 0; b++) {
			const size = Math.min(SESSION_BLOCK_ROWS, left);
			blocks.push(makeBlock(next, size, serial));
			left -= size;
		}
		messages.push({ blocks });
	}
	return messages;
}

/** Deterministic stand-in translation; the extension only sees its text. */
function translate(source: string): string {
	return `【译】${source.split(" ").reverse().join(" ")}`;
}

/** Frames a request waits before its translation lands; a pure function of the source, so both extensions see the same schedule. */
function latency(source: string): number {
	let hash = 0;
	for (let i = 0; i < source.length; i++) hash = (Math.imul(hash, 31) + source.charCodeAt(i)) | 0;
	return (hash >>> 0) % 4;
}

// ---------------------------------------------------------------- worker

async function runWorker(options: Options, mode: Mode): Promise<WorkerOutput> {
	// Imported here, not at the top: the orchestrating parent process never loads the host packages.
	const { AssistantMessageEventStream, registerCustomApi } = await import("@oh-my-pi/pi-ai");
	const { formatThinkingForDisplay } = await import("@oh-my-pi/pi-tui/chat/thinking-display");
	const { Settings } = await import("@oh-my-pi/pi-coding-agent");

	const root = process.env.OTT_REPRO_ROOT;
	if (!root) throw new Error("worker needs OTT_REPRO_ROOT");
	const traceFile = join(root, "trace.jsonl");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".omp"), { recursive: true });
	writeFileSync(
		join(cwd, ".omp", "thinking-translator.json"),
		JSON.stringify({ enabled: true, targetLanguage: "Simplified Chinese", translatorModels: [{ provider: PROVIDER, id: "echo" }], trace: traceFile }),
	);

	// ---- fake provider: requests wait `latency` frames, then stream the translation in three deltas.
	let frame = 0;
	type Pending = { due: number; source: string; stream: InstanceType<typeof AssistantMessageEventStream> };
	const pending: Pending[] = [];
	const model = {
		id: "echo",
		name: "echo",
		api: PROVIDER,
		provider: PROVIDER,
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 8_192,
	};
	const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const assistant = (text: string) => ({
		role: "assistant" as const,
		content: text ? [{ type: "text" as const, text }] : [],
		api: PROVIDER,
		provider: PROVIDER,
		model: "echo",
		usage: emptyUsage,
		stopReason: "stop" as const,
		timestamp: 0,
	});
	registerCustomApi(PROVIDER, (_model, context) => {
		const message = context.messages[0];
		const prompt = message && message.role === "user" && Array.isArray(message.content) && message.content[0]?.type === "text" ? message.content[0].text : "";
		const source = prompt.slice(prompt.indexOf("SOURCE_TEXT_BEGIN\n") + "SOURCE_TEXT_BEGIN\n".length, prompt.lastIndexOf("\nSOURCE_TEXT_END"));
		const stream = new AssistantMessageEventStream();
		pending.push({ due: frame + latency(source), source, stream });
		return stream;
	});
	const land = (entry: Pending): void => {
		const text = translate(entry.source);
		const third = Math.ceil(text.length / 3);
		let sent = "";
		entry.stream.push({ type: "start", partial: assistant("") });
		for (let at = 0; at < text.length; at += third) {
			const delta = text.slice(at, at + third);
			sent += delta;
			entry.stream.push({ type: "text_delta", contentIndex: 0, delta, partial: assistant(sent) });
		}
		entry.stream.push({ type: "done", reason: "stop", message: assistant(text) });
	};
	const landDue = (all: boolean): number => {
		let landed = 0;
		for (let i = 0; i < pending.length; ) {
			if (all || pending[i]!.due <= frame) {
				land(pending[i]!);
				pending.splice(i, 1);
				landed++;
			} else i++;
		}
		return landed;
	};
	/**
	 * Lets every promise chain the landed translations started run to completion. Microtasks only:
	 * a macrotask turn would also let the 400 ms late-notify timer fire between a translation landing
	 * and its repaint whenever a slow frame ate the window, which makes notify output depend on speed.
	 */
	const drain = async (): Promise<void> => {
		for (let i = 0; i < DRAIN_TURNS; i++) await Promise.resolve();
	};

	// ---- fake host
	const notifies: string[] = [];
	type Handler = (event: unknown, ctx: unknown) => void;
	type Renderer = (context: { contentIndex: number; thinkingIndex: number; text: string; requestRender(): void }, theme: unknown) => HostComponent | undefined;
	const handlers = new Map<string, Handler[]>();
	let renderer: Renderer | undefined;
	const sessionFile = join(root, "session.jsonl");
	const ctx = {
		cwd,
		hasUI: true,
		ui: { notify: (text: string) => notifies.push(text) },
		sessionManager: { getSessionFile: () => sessionFile },
		modelRegistry: {
			find: (provider: string, id: string) => (provider === PROVIDER && id === "echo" ? model : undefined),
			refreshDiscoverableProviders: async () => {},
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "repro" }),
		},
	};
	const api = {
		registerAssistantThinkingRenderer: (fn: Renderer) => {
			renderer = fn;
		},
		registerCommand: () => {},
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		pi: { settings: Settings.isolated() },
	};
	const emit = (event: string, payload: unknown): void => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
	const theme = { bg: (_name: string, text: string) => text, fg: (_name: string, text: string) => text };

	if (options.extension === NULL_EXTENSION) {
		// Control: the host-side work of this driver (display formatting, events, frames) with an extension that does nothing.
		const lines: readonly string[] = [];
		renderer = () => ({ render: () => lines, describe: () => null });
	} else {
		// The extension under test is chosen on the command line (current tree, baseline checkout).
		const mod: { default: (pi: typeof api) => void } = await import(resolve(options.extension));
		mod.default(api);
	}
	if (!renderer) throw new Error("extension registered no thinking renderer");
	const factory = renderer;

	const load = makeLoad(options.rows, options.shape);
	const record = mode === "frames";
	const frames: Frame[] = [];
	let renderRequested = false;
	let factoryCalls = 0;
	let activeMs = 0;
	const requestRender = (): void => {
		renderRequested = true;
	};
	type Mounted = { thinkingIndex: number; component: HostComponent };
	const cx = { supports: () => true };
	/** What a native backend does with a described node: describe nested components, keep the node tree. */
	const describeTree = (value: unknown): unknown => {
		if (value === null || typeof value !== "object") return value;
		if (!("k" in value)) return "describe" in value && typeof value.describe === "function" ? describeTree(value.describe(cx)) : value;
		return { ...value, c: "c" in value && Array.isArray(value.c) ? value.c.map(describeTree) : undefined };
	};

	const renderAll = (mounted: readonly Mounted[]): void => {
		frame++;
		renderRequested = false;
		for (const entry of mounted) {
			const lines = options.surface === "ansi" ? entry.component.render(WIDTH) : [JSON.stringify(describeTree(entry.component.describe?.(cx) ?? null))];
			if (record) frames.push({ frame, thinkingIndex: entry.thinkingIndex, lines: [...lines] });
		}
	};
	/** One host tick: due translations land, promise chains settle, and a requested repaint is drawn. */
	const settle = async (mounted: readonly Mounted[]): Promise<void> => {
		landDue(false);
		const started = performance.now();
		await drain();
		if (renderRequested) renderAll(mounted);
		activeMs += performance.now() - started;
	};

	Bun.gc(true);
	if (process.env.BUN_JSC_logGC) writeSync(2, `${MARK_START}\n`);
	const startAlloc = process.memoryUsage().heapUsed + jscMemory().current;
	emit("session_start", {});
	let messageSeq = 0;
	const history: { thinkingIndex: number; contentIndex: number; display: string }[] = [];
	for (const message of load) {
		messageSeq++;
		emit("message_start", { message: { role: "assistant" } });
		const mounted: Mounted[] = [];
		const content: { type: "thinking"; thinking: string }[] = [];
		for (const [thinkingIndex, block] of message.blocks.entries()) {
			const contentIndex = thinkingIndex * 2;
			const slot: Mounted = { thinkingIndex, component: { render: () => [] } };
			let mountedSlot = false;
			let display = "";
			for (const cut of block.cuts) {
				const raw = block.raw.slice(0, cut);
				content[contentIndex] = { type: "thinking", thinking: raw };
				const started = performance.now();
				emit("message_update", { assistantMessageEvent: { type: "thinking_delta", contentIndex, delta: "", partial: { content } } });
				const nextDisplay = formatThinkingForDisplay(raw, true);
				if (nextDisplay !== display) {
					// The host's own thinking body gets the new text first (pi-tui Markdown.setText compares it with
					// the previous text by `startsWith`), so the string reaches the factory already flattened.
					nextDisplay.startsWith(display);
					display = nextDisplay;
					factoryCalls++;
					const component = factory({ contentIndex, thinkingIndex, text: display, requestRender }, theme);
					if (component) {
						slot.component = component;
						if (!mountedSlot) {
							mounted.push(slot);
							mountedSlot = true;
						}
					}
				}
				renderAll(mounted);
				activeMs += performance.now() - started;
				await settle(mounted);
			}
			const started = performance.now();
			emit("message_update", { assistantMessageEvent: { type: "thinking_end", contentIndex, content: block.raw, partial: { content } } });
			activeMs += performance.now() - started;
			await settle(mounted);
			history.push({ thinkingIndex, contentIndex, display });
		}
		const started = performance.now();
		emit("message_end", { message: { role: "assistant" } });
		renderAll(mounted);
		activeMs += performance.now() - started;
		// The message is committed: its components are not drawn again, and whatever is still in flight lands late.
		await drain();
		landDue(true);
		await drain();
		const wait = Promise.withResolvers<void>();
		setTimeout(wait.resolve, LATE_FLUSH_WAIT_MS);
		await wait.promise;
	}
	// History replay: the host rebuilds old messages and calls the factory again with their final display text.
	for (const entry of history) {
		const started = performance.now();
		factoryCalls++;
		const component = factory({ contentIndex: entry.contentIndex, thinkingIndex: entry.thinkingIndex, text: entry.display, requestRender }, theme);
		if (component) renderAll([{ thinkingIndex: entry.thinkingIndex, component }]);
		activeMs += performance.now() - started;
	}
	await drain();
	const endAlloc = process.memoryUsage().heapUsed + jscMemory().current;
	if (process.env.BUN_JSC_logGC) writeSync(2, `${MARK_END}\n`);
	Bun.gc(true);
	Bun.gc(true);
	const result: WorkerResult = {
		allocBytes: endAlloc - startAlloc,
		heapAfterGc: process.memoryUsage().heapUsed,
		mallocAfterGc: jscMemory().current,
		activeMs,
		frames: frame,
		factoryCalls,
		notifies: notifies.length,
	};
	return { result, traceFile, notifies, ...(record ? { frames } : {}) };
}

// ---------------------------------------------------------------- snapshot (F8)

/**
 * Retained memory of the cell map's keys and values, built through the extension's own key path
 * (`splitTranslationLines` → `matchBlockLine` → `cellKey` → `Map.set`). Every block carries a
 * 1 MB Chinese preamble the Latin gate skips, so a key or value that still points into its block's
 * raw text would hold far more than its own characters. The driver keeps no reference to the raw
 * text; the retained size is what the heap gives back when the map is cleared.
 */
async function runSnapshot(options: Options): Promise<{ ownBytes: number; retainedBytes: number; controlBytes: number; rawBytes: number }> {
	// The extension under test is chosen on the command line (current tree, baseline checkout).
	const mod: { __testing: { cellKey(config: unknown, line: string): string; matchBlockLine(raw: string, line: string, ended?: boolean): string | undefined; splitTranslationLines(text: string): string[]; DEFAULT_CONFIG: unknown } } =
		await import(resolve(options.extension));
	const { cellKey, matchBlockLine, splitTranslationLines, DEFAULT_CONFIG } = mod.__testing;
	const config = { ...(DEFAULT_CONFIG as object), translatorModels: [{ provider: PROVIDER, id: "echo" }] };
	const retained = (): number => {
		Bun.gc(true);
		Bun.gc(true);
		return heapStats().heapSize + heapStats().extraMemorySize;
	};
	const preamble = `${CJK.join("").repeat(Math.ceil(1_048_576 / (CJK.join("").length * 2)))}\n`;
	/**
	 * Builds the map once through the extension's path; with `copyLines` every canonical line is first
	 * re-encoded into a string of its own, so that map can hold nothing of the raw text (the control).
	 */
	const build = (copyLines: boolean): { bytes: number; own: number; raw: number } => {
		const map = new Map<string, { progress: { status: "done"; translation: string }; painted: boolean }>();
		let own = 0;
		let raw = 0;
		const before = retained();
		for (const message of makeLoad(options.rows, "session")) {
			for (const block of message.blocks) {
				// A fresh string per block, as the host accumulates its own; nothing here keeps it past this iteration.
				const text = preamble + block.raw;
				raw += text.length * 2;
				for (const line of splitTranslationLines(text)) {
					const matched = matchBlockLine(text, line, true);
					if (matched === undefined) continue;
					const canonical = copyLines ? Buffer.from(matched, "utf8").toString("utf8") : matched;
					const key = cellKey(config, canonical);
					if (map.has(key)) continue;
					const translation = translate(canonical);
					map.set(key, { progress: { status: "done", translation }, painted: true });
					// Characters as stored: Latin-only strings take one byte each, strings with CJK two.
					own += key.length * (/[^\u0000-\u00ff]/.test(key) ? 2 : 1) + translation.length * 2;
				}
			}
		}
		if (map.size === 0) throw new Error("snapshot load produced no cells");
		const bytes = retained() - before;
		map.clear();
		return { bytes, own, raw };
	};
	const real = build(false);
	const control = build(true);
	return { ownBytes: real.own, retainedBytes: real.bytes, controlBytes: control.bytes, rawBytes: real.raw };
}

// ---------------------------------------------------------------- orchestration

/**
 * Sums the GC log between the two marks: every collection's heap size at start minus the size the
 * previous one left, the last term being the forced collection right after the end mark.
 */
function parseGcLog(stderr: string): GcLog {
	let inside = false;
	let closing = false;
	let previousAfter: number | undefined;
	let gcAllocBytes = 0;
	let gcPauseMs = 0;
	let collections = 0;
	for (const line of stderr.split("\n")) {
		if (line === MARK_START) {
			inside = true;
			continue;
		}
		if (line === MARK_END) {
			closing = true;
			continue;
		}
		const start = /START M (\d+)kb/.exec(line);
		const end = /=> ([\d.]+)kb, p=([\d.]+)ms/.exec(line);
		if (start && inside && previousAfter !== undefined) {
			gcAllocBytes += (Number(start[1]) - previousAfter) * 1024;
			if (closing) return { gcAllocBytes, gcPauseMs, collections };
		}
		if (end) {
			previousAfter = Number(end[1]);
			if (inside && !closing) {
				gcPauseMs += Number(end[2]);
				collections++;
			}
		}
	}
	throw new Error("GC log has no collection after the end mark");
}

function spawnWorker(options: Options, extension: string, mode: Mode, gc: "off" | "on" | "logged"): WorkerOutput & { gcLog?: GcLog } {
	const root = mkdtempSync(join(tmpdir(), "ott-repro-"));
	const out = join(root, "result.json");
	const env: Record<string, string | undefined> = { ...process.env, OTT_REPRO_ROOT: root, PI_CODING_AGENT_DIR: join(root, "agent"), BUN_JSC_useGC: undefined, BUN_JSC_logGC: undefined };
	if (gc === "off") env.BUN_JSC_useGC = "0";
	if (gc === "logged") env.BUN_JSC_logGC = "1";
	mkdirSync(join(root, "agent"), { recursive: true });
	const child = Bun.spawnSync(
		[process.execPath, SCRIPT, "--worker", mode, "--rows", String(options.rows), "--shape", options.shape, "--surface", options.surface, "--extension", extension, "--out", out],
		{ env, stdout: "inherit", stderr: gc === "logged" ? "pipe" : "inherit" },
	);
	if (child.exitCode !== 0) throw new Error(`worker ${mode} ${extension} exited ${child.exitCode}: ${child.stderr?.toString().slice(-2000) ?? ""}`);
	const output = JSON.parse(readFileSync(out, "utf8")) as WorkerOutput;
	return gc === "logged" ? { ...output, gcLog: parseGcLog(child.stderr.toString()) } : output;
}

const median = (values: readonly number[]): number => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(2)} MB`;

function measure(options: Options): void {
	const targets: [string, string][] = [["extension", options.extension], ["null control", NULL_EXTENSION]];
	if (options.baseline) targets.push(["baseline", options.baseline]);
	const summary: Record<string, Record<string, number>> = {};
	for (const [label, extension] of targets) {
		const gcAlloc: number[] = [];
		const gcPause: number[] = [];
		const alloc: number[] = [];
		const heap: number[] = [];
		const malloc: number[] = [];
		const time: number[] = [];
		let last: WorkerResult | undefined;
		for (let run = 0; run < options.runs; run++) {
			const logged = spawnWorker(options, extension, "measure", "logged");
			gcAlloc.push(logged.gcLog!.gcAllocBytes);
			gcPause.push(logged.gcLog!.gcPauseMs);
			heap.push(logged.result.heapAfterGc);
			malloc.push(logged.result.mallocAfterGc);
			time.push(logged.result.activeMs);
			last = logged.result;
			if (options.gcOff) alloc.push(spawnWorker(options, extension, "measure", "off").result.allocBytes);
		}
		summary[label] = {
			gcHeapAllocBytes: median(gcAlloc),
			gcPauseMs: median(gcPause),
			...(options.gcOff ? { allocBytesGcOff: median(alloc) } : {}),
			heapAfterGc: median(heap),
			mallocAfterGc: median(malloc),
			activeMs: median(time),
			frames: last!.frames,
			factoryCalls: last!.factoryCalls,
			notifies: last!.notifies,
		};
		console.log(
			`${label.padEnd(12)} rows=${options.rows} shape=${options.shape} runs=${options.runs}  GC-heap alloc median ${mb(median(gcAlloc))} [${gcAlloc.map(mb).join(", ")}]  GC pause ${median(gcPause).toFixed(1)} ms` +
				(options.gcOff ? `  total alloc (GC off) median ${mb(median(alloc))} [${alloc.map(mb).join(", ")}]` : "") +
				`  heap after GC ${mb(median(heap))}  malloc after GC ${mb(median(malloc))}  active ${median(time).toFixed(0)} ms  frames ${last!.frames} factory ${last!.factoryCalls} notifies ${last!.notifies}`,
		);
	}
	console.log(JSON.stringify({ rows: options.rows, shape: options.shape, runs: options.runs, summary }));
}

/** Trace records without timestamp and pid, the worker's temp directory replaced by `<root>`; factory records only counted. */
function normalizeTrace(file: string): { factory: number; other: string[] } {
	const root = dirname(file);
	let factory = 0;
	const other: string[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		const { t: _t, pid: _pid, ...record } = JSON.parse(line.split(root).join("<root>")) as Record<string, unknown>;
		if (record.tag === "factory") factory++;
		else if (record.tag === "activate") continue;
		else other.push(JSON.stringify(record));
	}
	return { factory, other };
}

function traceDiff(options: Options): void {
	if (!options.baseline) throw new Error("--trace-diff needs --baseline <extension.ts>");
	const current = spawnWorker(options, options.extension, "frames", "on");
	const base = spawnWorker(options, options.baseline, "frames", "on");
	const a = normalizeTrace(base.traceFile);
	const b = normalizeTrace(current.traceFile);
	const otherSame = a.other.length === b.other.length && a.other.every((line, i) => line === b.other[i]);
	const notifySame = base.notifies.length === current.notifies.length && base.notifies.every((text, i) => text === current.notifies[i]);
	const framesSame = JSON.stringify(base.frames) === JSON.stringify(current.frames);
	console.log(`factory records: baseline ${a.factory}, extension ${b.factory} (factory calls ${base.result.factoryCalls})`);
	console.log(`other trace records: baseline ${a.other.length}, extension ${b.other.length}, identical: ${otherSame}`);
	console.log(`notify payloads: baseline ${base.notifies.length}, extension ${current.notifies.length}, identical: ${notifySame}`);
	console.log(`rendered frames: baseline ${base.frames?.length ?? 0}, extension ${current.frames?.length ?? 0}, identical: ${framesSame}`);
	if (!otherSame) {
		const at = a.other.findIndex((line, i) => line !== b.other[i]);
		console.log(`first difference at record ${at}:\n  baseline:  ${a.other[at]}\n  extension: ${b.other[at]}`);
	}
	if (!otherSame || !notifySame || !framesSame) process.exitCode = 1;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options.worker) {
		if (!options.out) throw new Error("worker needs --out");
		const output = options.worker === "snapshot" ? await runSnapshot(options) : await runWorker(options, options.worker);
		writeFileSync(options.out, JSON.stringify(output));
		process.exit(0);
	}
	if (options.snapshot) {
		const label = (extension: string): string => (extension === options.extension ? "extension" : "baseline");
		for (const extension of options.baseline ? [options.extension, options.baseline] : [options.extension]) {
			const root = mkdtempSync(join(tmpdir(), "ott-repro-"));
			const out = join(root, "result.json");
			const child = Bun.spawnSync([process.execPath, SCRIPT, "--worker", "snapshot", "--rows", String(options.rows), "--extension", extension, "--out", out], {
				env: { ...process.env, OTT_REPRO_ROOT: root, PI_CODING_AGENT_DIR: join(root, "agent") },
				stdout: "inherit",
				stderr: "inherit",
			});
			if (child.exitCode !== 0) throw new Error(`snapshot worker exited ${child.exitCode}`);
			const { ownBytes, retainedBytes, controlBytes, rawBytes } = JSON.parse(readFileSync(out, "utf8")) as { ownBytes: number; retainedBytes: number; controlBytes: number; rawBytes: number };
			console.log(
				`${label(extension).padEnd(10)} rows=${options.rows} cell map own key/value bytes ${mb(ownBytes)}, retained ${mb(retainedBytes)} (${(retainedBytes / ownBytes).toFixed(2)}× own); control with copied lines retained ${mb(controlBytes)} (${(controlBytes / ownBytes).toFixed(2)}× own); raw text streamed ${mb(rawBytes)}`,
			);
		}
		return;
	}
	if (options.traceDiff) return traceDiff(options);
	if (options.frames) {
		const output = spawnWorker(options, options.extension, "frames", "on");
		writeFileSync(options.frames, JSON.stringify({ rows: options.rows, shape: options.shape, frames: output.frames, notifies: output.notifies }));
		console.log(`wrote ${output.frames?.length ?? 0} frames and ${output.notifies.length} notify payloads to ${options.frames}`);
		return;
	}
	measure(options);
}

await main();
