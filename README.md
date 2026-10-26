# omp-thinking-translator

English | [简体中文](README.zh-CN.md)

An omp extension that translates visible assistant thinking blocks into another language for display only.

It renders one translation box directly below each visible assistant thinking block. In a Tern Surface Protocol terminal (Tern) the box is a native collapsible `omp.thinking` section with the same shape as the host's own thinking: open while translations are arriving, and once they settle it follows the host's `expandThinkingBlocks` setting — folded when that is off (the default), kept open when it is on. In every other terminal it is the ANSI box. If a translation finishes after an ANSI box can no longer be repainted, it emits a debounced in-flow transcript row at the current transcript tail. Translations stay in extension memory: they are never written to the session file, never part of the next model request, and never part of compaction input. See [Context Boundary](#context-boundary) for the mechanism, the runtime evidence, and what is explicitly not covered. The one file the extension does write is a diagnostic trace next to the session file (`trace` option below), which records the extension's own steps and never the session content.

## Features

- Translates the lines the host actually displays. The renderer receives the display text of each visible thinking block, and that text is the single source of truth for both what gets translated and where each translation is drawn — so a line the host rewrote (prose-only fence elision, empty reasoning-summary comments, streaming reveal) can no longer end up with no slot. That contract is pinned by a test that runs the host's own `formatThinkingForDisplay` over fenced and comment-bearing thinking and requires every still-displayed line to resolve back to its raw line.
- Gates per line, not per block: after excluding Markdown inline-code spans (identifiers, paths, and commands rather than prose), a line is translated when it contains Latin letters and more Latin letters than Chinese characters. This prevents Chinese reasoning with long identifiers such as `expandThinkingBlocks` from being translated into duplicate Chinese. A one-sentence thinking block right before a tool call is translated like any other.
- Translates while the block is still streaming. The host recreates the renderer on every display-text change, so each completed line is dispatched as soon as it appears — measured at 3 ms after `thinking_end` for a one-line block. A line is dispatched only once it is a complete line of an observed block: while the block is open its trailing line is still being revealed, and every revealed prefix would otherwise become its own request.
- Dispatches only lines of thinking blocks this process actually observed streaming, matched by content against every tracked block (`resolveTrackedLine`), and keys each cell by the **raw line it matched**, not by the display text. The host reveals a line character by character and the matcher tolerates a missing final period (the host's code-fence fold eats one), so the frame one character short of the period is already accepted as a complete line; keying by display text would translate that line twice — the box would show the second result while the first, never painted, surfaced as a stray late row. Block identity is deliberately *not* the host's `contentIndex`: every assistant message numbers its thinking blocks from 0, a tool result is its own message, and the previous message's thinking component keeps being repainted afterwards — so an index-keyed lookup hands that component the *next* block's raw text and the whole block silently goes untranslated. Replayed history matches no tracked block and is rendered without being re-translated.
- Falls back across an ordered list of translator models. Every request starts at the first model in `translatorModels` and moves to the next only when the current one fails — not in the registry after a discovery attempt, a credential error, a stream error, an empty response, or a response that echoes the internal `SOURCE_TEXT_BEGIN` input marker. Marker detection aborts only that model's in-flight request and throws into the existing fallback path; its partial text is discarded before the next model starts. Nothing remembers which model failed or succeeded: the next line, and the next retry round, start at the first model again. When every model in the chain fails, the whole chain is retried with backoff (500 ms, 2 s, 6 s), each round again from the first model, before the line gives up. A translator model that is offline, rate-limited, mid-restart, or returning the source envelope therefore yields to the next model instead of leaving a permanent error or protocol marker row; the line stays silent until real text exists.
- Each box shows a `思考翻译 · 块 N · done/total` title (N counts thinking blocks within the same message) and only rows that already have translated text. Pending lines occupy no rows at all — progress lives in the title count — so a five-line block does not first expand into five placeholder rows, and no frozen placeholder is left behind in scrollback. A line that exhausted its retries shows a failure row. Translation updates repaint through the requesting component's own `requestRender`, and the effective config is only ever replaced, never cleared — otherwise the key material for the lookup vanishes and every box on screen blanks out the moment the host starts the next message, which a tool result also is.
- Renders natively in Tern. The component returned from the renderer also implements `describe(cx)` (Tern Surface Protocol), so a Tern pane gets a `section` with role `omp.thinking.live` while any line is still being translated and `omp.thinking` once all have settled, a `思考翻译 · 块 N · done/total` head, and an `md` body. Unless you toggled it yourself, the section folds when the translation completes only while the host setting `expandThinkingBlocks` (Settings → Model → Thinking → Expand Thinking Blocks, or `omp config set expandThinkingBlocks true`) is off; with it on, the section stays open exactly like the host's own thinking. The setting is read from the host on every describe, so changing it takes effect on the next frame. Terminals without the protocol never call `describe` and keep the ANSI box unchanged; a Tern that does not list `section` and `md` falls back to the ANSI rows. A native surface has no append-only scrollback, so once Tern has described the component the late-notify row is not emitted.
- Emits late translations through `ctx.ui.notify` as one debounced, dim in-flow transcript row. This is the only extension-accessible surface that appends a real transcript row without entering LLM context or the session file. The row is intentionally placed at the current transcript tail — after any tool output that already arrived — rather than pretending it can sit under the frozen thinking block; consecutive flushes re-include the prior payload only while no host chat event could have broken `notify`'s identity coalescing.
- Supports a global config with per-project overrides.

## Requirements

- omp (`@oh-my-pi/pi-coding-agent`), verified with 18.8.7. The host build must provide `registerAssistantThinkingRenderer` and `modelRegistry.refreshDiscoverableProviders`; native rendering in Tern additionally needs a host that routes `Component.describe` to the Tern Surface Protocol backend.

This extension is omp-only, not a pi extension. It is built on omp's extension API: the translation box attaches through `pi.registerAssistantThinkingRenderer`, which upstream pi does not provide, and every import resolves against omp's `@oh-my-pi/*` packages rather than pi's own. Running it on pi would mean a different display surface, not a configuration change.

## Install

This extension is installed from git; it is not published to any package registry.

```bash
omp plugin install git:github.com/oh-my-omp/omp-thinking-translator
```

For local development, either load the extension file directly:

```bash
omp -e /absolute/path/to/omp-thinking-translator/extensions/thinking-translator.ts
```

or install from a local checkout:

```bash
omp plugin install /absolute/path/to/omp-thinking-translator
```

The manifest key is `omp.extensions`, and the pinned `@oh-my-pi/*` 18.8.7 packages live in `devDependencies` only: the host already provides them, so installing this extension adds no `@oh-my-pi` packages under the plugin directory.

## Quick Start

1. Install the extension:

   ```bash
   omp plugin install git:github.com/oh-my-omp/omp-thinking-translator
   ```

2. Create a global config template from inside omp:

   ```text
   /thinking-translator init --global
   ```

3. Edit the generated file:

   ```text
   ~/.omp/agent/thinking-translator.json
   ```

4. Point the extension at one or more translator models, in the order they should be tried, and enable it:

   ```json
   {
     "enabled": true,
     "translatorModels": [
       { "provider": "deepseek", "id": "deepseek-v4-flash" },
       { "provider": "ollama", "id": "qwen2.5:7b" }
     ]
   }
   ```

5. Check the effective config:

   ```text
   /thinking-translator status
   ```

The `provider` and `id` must match a model visible to omp, for example a model from the host model registry. Under `omp --profile <name>`, omp points the agent directory at `~/.omp/profiles/<name>/agent`, so the global config for that profile lives there instead.

## Commands

```text
/thinking-translator
/thinking-translator status
/thinking-translator init
/thinking-translator init --global
/thinking-translator init --project
```

- `/thinking-translator` and `/thinking-translator status` show the effective config, config file paths, and translator model availability.
- `/thinking-translator init` creates the global config, same as `/thinking-translator init --global`.
- `/thinking-translator init --global` creates `<agentDir>/thinking-translator.json` (default `~/.omp/agent/thinking-translator.json`) if it does not already exist.
- `/thinking-translator init --project` creates `<cwd>/.omp/thinking-translator.json` in the current project if it does not already exist.

The init commands write a disabled template and do not choose a model. You must explicitly set `translatorModels` and set `enabled` to `true`.

## UI language

The extension resolves its UI language when it needs to render or report text. Set `OMOMP_LANG` to `en` or `zh` (case-insensitive) to choose explicitly. Otherwise, an OMP-only extension reads `omomp-lang: { language: en|zh }` from the one `omomp.yml`, `omomp.yaml`, `omomp.json`, or `omomp.toml` file in omp's agent directory; no file, multiple files, or invalid content is ignored. If that has no value, the first non-empty `LC_ALL`, `LC_MESSAGES`, or `LANG` selects Chinese when it starts with `zh`, otherwise English, with English as the final fallback. The omomp setting is read once per process and takes effect on the next start. This changes UI chrome only; thinking content and the translation prompt are not rewritten.


## Configuration

The extension never writes config files on its own; files are created only by the `init` commands, and built-in defaults apply until you override them. Files hold partial overrides that merge over the defaults:

1. Built-in defaults
2. Global config: `<agentDir>/thinking-translator.json`, where `<agentDir>` is `$PI_CODING_AGENT_DIR` when set, otherwise `~/.omp/agent` (default `~/.omp/agent/thinking-translator.json`)
3. Project config: `<cwd>/.omp/thinking-translator.json`

The project file is read after the global file, so it wins on every field it sets. `translatorModels` is an ordered chain and is replaced as a whole: a project list is the project's complete chain, `null` clears it, and leaving it out keeps the global chain.

A complete config looks like this:

```json
{
  "enabled": true,
  "targetLanguage": "Simplified Chinese",
  "translatorModels": [
    { "provider": "deepseek", "id": "deepseek-v4-flash", "effort": "low" },
    { "provider": "ollama", "id": "qwen2.5:7b" }
  ]
}
```

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enables translation processing. If `translatorModels` is empty, translation is skipped with a warning. |
| `targetLanguage` | string | `"Simplified Chinese"` | Target language passed to the translator model. Must be a non-empty string. |
| `translatorModels` | array | `[]` | Ordered translator model chain; each entry is `{ "provider": "...", "id": "...", "effort": "..." }`. `provider` and `id` are required non-empty strings in every entry; `effort` is optional (see below). Every request tries the entries in this order (see [Features](#features)). An entry that is not an object or lacks `provider`/`id` makes the config file invalid instead of being dropped, because a silently missing entry would change the fallback order. |
| `trace` | string \| boolean | `true` | Diagnostic record. `true` appends one JSONL record per step (`session_start`, `message_start`, `thinking_end`, `factory`, `dispatch`, `request`, `modelFailed` for each model that failed before the next one is tried, `done`/`translateError`, `render` on every cell-state change, `painted`, `settled`, `lateFlush`, `reset`, `missingModel`) to `<session file without .jsonl>.thinking-translator-trace.jsonl` next to the session file; `--no-session` processes write nothing. A string sets an explicit path; `false` disables. |

`contentTypes`, `minLatinChars`, and the single-model `translatorModel` key, left over from older config shapes, are silently ignored: only thinking blocks are translated, translatability is decided per line rather than by a block-length threshold, and the translator models come only from `translatorModels`.

Each entry's `effort` sets the reasoning effort of the requests sent to that model: `off`, or one of the host's levels `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Left unset, no reasoning field is sent and the model or provider default applies. Requests go through pi-ai's `streamSimple`, which maps the level to the provider's own field — `"reasoning": { "effort": "low" }` on an OpenAI Responses endpoint, for example — and turns `off` into pi-ai's reasoning-off request, which on generic effort endpoints is the model's lowest supported level. Each request caps output at 1024–8192 tokens (scaled to the line length), so a reasoning model whose default effort spends that budget on hidden reasoning returns empty text; a low level avoids it. Any other value makes that config file invalid, exactly like a parse error, and the error names the entry (`translatorModels[1].effort …`). A level the model does not support is rejected by pi-ai before anything is sent and counts as that model's failure, so the next model in the chain is tried; `/thinking-translator status` prints each entry's effective effort next to the levels its model declares.

If any config file fails to parse, the extension shows a one-time warning naming that path and forces `enabled` to `false`, so nothing is translated under a broken config. If translation is enabled but `translatorModels` is empty, the extension warns once and skips translation without affecting the main assistant message. Each request looks its model up in the host model registry at the moment it is sent; if the model is not there (typical for `discovery: proxy` providers, whose models the host only re-discovers for the main model and drops from the registry on cache invalidation or static reload), the extension asks the host to re-discover that provider (`refreshDiscoverableProviders`) and looks the model up again. There is no cooldown and no memory of the miss — the next request runs the same lookup and discovery again; concurrent requests only join a discovery of the same provider that is already in flight. A model still missing after discovery warns once per session and counts as that model's failure, so the next model in the chain is tried. `/thinking-translator status` lists every entry in chain order with its availability, running the same discovery for entries not in the registry. A line whose whole chain keeps failing through every retry round leaves the original thinking untouched and surfaces each model's error inside that line's row.

## How It Works

1. The extension tracks thinking blocks as it sees them stream: `message_start` reloads the effective config and bumps the message counter, `message_update` records each block's raw text under `message:contentIndex` (marking it closed on `thinking_end`), and `message_end` closes whatever the provider left open so its trailing line can still be translated. Records are kept across messages — the previous message's thinking component is still being repainted — and bounded to the most recent 32 blocks. Note that a tool result is its own message, so `message_start` fires mid-turn, which is why the config is replaced there rather than cleared.
2. The host resolves the display text of every visible thinking block and calls the registered renderer factory with it, again on every change to that text.
3. On each render the extension splits that display text on newlines and trims the lines.
4. Each line is checked against the per-line gate and against every tracked block: after Markdown inline-code spans are excluded from language classification, its prose must contain Latin letters and more Latin letters than Chinese characters, and it must be a complete line of one observed block. "Complete" means followed by a newline, or by the end of a block that has closed. A half-written line still being revealed therefore waits instead of being translated as a stream of throwaway fragments, and replayed history — which matches no tracked block — is never dispatched.
5. Each line text is translated at most once per translator model chain (models, their order, and their efforts) and target language: the first dispatch creates its slot and fires one independent streaming request through the chain, and every later render reuses that slot. Slow lines never block their siblings, and every line lands back in original order.
6. `render()` (ANSI terminals) and `describe()` (Tern) both go through the same `collect()`: dispatch, look each displayed line up in the table, mark finished cells painted, and return the rows that already have text with a `done/total` count. `render()` draws the box beneath that block; `describe()` returns the native section described above and the same node object while nothing changed. A failing model hands the request to the next model in the chain, discarding any partial text it streamed. If the accumulated stream contains the prompt's internal `SOURCE_TEXT_BEGIN` marker, the extension immediately aborts that model attempt and treats it as the same kind of failure, so the marker and echoed source cannot become a completed translation. A chain that fails as a whole is retried with backoff (500 ms, 2 s, 6 s) from the first model and only then becomes a failure row. Every translation arrival or failure calls the host-provided `requestRender`, so a box or section the host still renders keeps filling in.
7. When a translation completes, the extension checks whether the box ever drew that cell. If not, and Tern has not described the component, it queues the text for a short debounce and emits one `ctx.ui.notify` payload containing the queued translations and a `思考翻译 · 第 N 块` header. A repaint before the flush marks the cell painted and removes it from that payload. If no host chat event intervened, the next notify re-includes the previous payload because the host may otherwise replace the same status row; `message_start`, `message_update`, or `message_end` starts a fresh payload after chat content has mounted or changed.
8. Translations live only in an in-memory table and are dropped on session start, session switch, and session shutdown, together with the pending notify queue and prior payload. Nothing is appended to the session transcript and no translation is ever fed back as model input; see [Context Boundary](#context-boundary).

## Context Boundary

The translation box is presentation output, not conversation content. The canonical assistant thinking — what omp persists, sends on the next turn, and feeds to compaction — stays the original text the model produced.

Mechanism:

- Translations live in a module-local `Map` keyed by the raw thinking line plus translator model chain and target language (`extensions/thinking-translator.ts:121`, `cellKey` `:577`), read only by the component returned from `pi.registerAssistantThinkingRenderer` and by the in-flow notify fallback (`extensions/thinking-translator.ts:153-259`, `:274-301`). Those rows flow into the TUI container tree and terminate at the terminal write; on host 18.1.19 no consumer of them reached a session writer, the provider request builder, or compaction (`assistant-message.ts:841-860` → `pi-tui/src/tui.ts:486-513` → `tui.ts:2735-2781`), and 18.2.0's `#appendThinkingExtensions` (`assistant-message.ts:841-860`) still hands the renderer a fresh context object and only mounts the returned component.
- The `context.text` handed to the renderer is a resolved display string in a freshly allocated object (`assistant-message.ts:841-852`), not a reference into the stored `AgentMessage`, so a renderer cannot mutate the message through it.
- Persistence writes typed `SessionEntry.message` values to the session JSONL (`session-manager.ts:2288-2305`, `:817-818`); the next request is rebuilt from those entries (`session-context.ts:216-272`, `agent-loop.ts:1627-1673`); compaction partitions the same branch entries (`compaction.ts:1328-1382`). None of the three reads rendered rows.
- The hooks that can change model-visible data in this host are `context`, `before_provider_request`, `before_agent_start`, `session_before_compact`, and `session_stop`. The extension registers none of them; its only handlers are session reset, per-message state tracking, chat-content generation, and the thinking-block bookkeeping in `message_start`/`message_update`/`message_end` (`extensions/thinking-translator.ts:338-442`).

The original context-boundary checks below ran on omp 18.1.19, driving the real TUI with a throwaway read-only observer extension attached to `before_provider_request` (the final pre-send payload hook) and `session_before_compact`, using high-entropy fragments of the rendered Chinese plus the box labels `思考翻译` / `等待翻译` / `翻译失败` as canaries. The notify-specific check was repeated on omp 18.1.21 as described below:

- **Next turn, before any compaction.** The provider payload of the turn that directly followed a completed translation box carried the assistant `thinking` part unchanged (5209 chars, SHA-256 `068c357d54f0d1b0b84453a10c2a3c5c2acc445d2d116b1f39d1dd34f1923b55`) plus its text; a recursive scan of every string in the serialized payload counted 0 occurrences of every canary. This request was observed before any compaction ran, so nothing ephemeral could have been stripped by it; a second run showed the same for its own pre-compaction turn (assistant `thinking` 4491 chars, SHA-256 `e9cb8a43…`, 0 canaries).
- **Compaction input.** A `/compact` whose summarized set contained the translated block — `messagesToSummarize` = 13, `messagesToSummarize[0]` the same assistant message with the identical thinking hash — had 0 canary occurrences in the whole `CompactionPreparation`, in the 3958-char summary omp then persisted, and in the following provider payload.
- **Session store.** Structural scan of every record, message, and content part of the target session JSONL: 0 canary occurrences, and the persisted thinking hash equals the one sent to the provider. `agent.db` holds settings/auth/usage tables, not transcript messages, and its raw file plus WAL/SHM also had 0 occurrences.
- **Notify runtime.** A real omp 18.1.21 TUI run with this checkout loaded through `-e` produced a 4650-character thinking block followed by a `read package.json` tool call. The TUI showed the checkout's in-flow `思考翻译 · 第 1 块` row; a structural scan of the resulting session JSONL found zero occurrences of that header, `全面分析如何安全地检查该TypeScript项目`, or any notify payload.

Minimal reproduction:

1. Write a throwaway extension that registers `pi.on("before_provider_request", ...)` and `pi.on("session_before_compact", ...)`, appends `JSON.stringify` of the payload and of `event.preparation` to two files, and returns `undefined` from both handlers.
2. Start `omp -e /path/to/extensions/thinking-translator.ts -e /path/to/observer.ts` in a scratch directory.
3. Send an English prompt that produces a multi-line thinking block, and wait until the box reads `思考翻译 · 块 N · M/M`. Copy two distinctive fragments of the rendered Chinese — they must not occur in the prompt or in the thinking itself.
4. Send another turn, then search the newest `before_provider_request` payload recursively for those fragments and for the three box labels. Expect zero, and expect the assistant `thinking` string to hash to the same value the session JSONL stores.
5. Add filler turns until `/compact` reports a non-empty `messagesToSummarize`, run it, and search the recorded `preparation` and the persisted compaction summary the same way. Expect zero while the summarized assistant message still carries the original thinking hash.
6. Parse the session JSONL and search every content part. Expect zero.

Not covered by this boundary:

- **The translation request itself.** Each eligible thinking line is sent to the configured translator models as its own standalone request (`extensions/thinking-translator.ts:358-566`), separate from the agent conversation; when a model fails, the same line goes to the next model in the chain, so every provider in `translatorModels` can receive it. "Not in the agent context" does not mean "not sent to any model": those providers see your thinking text and retain it under their own policy.
- **Display-derived artifacts.** Terminal scrollback, in-flow notify rows, a terminal recorder, and omp's own `/debug-transcript` (which dumps rendered rows to a temp file, `command-controller.ts:225-236`) contain translated rows by design. That is an observability surface, not conversation context.
- **Untested paths.** The compaction check ran on a resumed persisted session, so resume is covered to the extent that its canonical messages, provider payloads, and compaction input were inspected — not that historical translations re-render or that every resume UI path was exercised. Session export/import serializers and branch switching were not exercised at all.
- **Version scope.** The evidence is for this extension revision on omp 18.1.19 (notify check repeated on 18.1.21). The guarantee rests on the host renderer contract and on the request/compaction paths cited above, not on a documented API promise, so re-verify after a host upgrade; the current pin is 18.8.7, and the canary runs and cited host code paths date from the earlier versions and were not repeated there.

## Limitations

- If a thinking block is not visible (for example folded away by the host so it never renders), the host never invokes the translation renderer and no box appears for it.
- Diagnostics: every session-saving process appends `<session file without .jsonl>.thinking-translator-trace.jsonl` beside the session JSONL (see the `trace` option). It contains event names, line counts, the first 40–60 characters of each source line and translation, model ids and file paths — enough to see where a session's translation stopped. Set `trace: false` if that is not acceptable.
- Terminal scrollback is immutable in ANSI terminals. The host commits a thinking block's rows once the assistant message reaches its tool call, and after that the box is frozen at whatever it showed — measured: a 998 ms translation landed in the box, a 1567 ms one did not. The in-flow notify row is the fallback for exactly that case, so the translation remains readable at the current transcript tail after whatever tool output already arrived, not directly under its thinking block. A Tern native surface has no append-only scrollback: the section stays live and the fallback row is not used.
- Translations exist only in memory: quitting omp or switching sessions discards them, and previously shown messages are not backfilled when a session reopens.
- Within one session, two identical lines share a single translation as long as the translator model chain and target language are unchanged.

## Security Notes

omp extensions run with full system permissions. Review extension source before installing third-party packages.

Translation backends receive the eligible thinking lines, so use a local model if that content should not leave your machine.

## Development

```bash
pnpm install
pnpm check
```

`pnpm check` runs the TypeScript check plus the test file. Tests run under Bun because the host packages expose TypeScript sources as their entries.

## Package Layout

- `extensions/thinking-translator.ts` — the extension: renderer registration, event handling, translation fan-out, and config commands.
- `tests/thinking-translator.test.ts` — unit tests for config handling and the translation helpers.
- `package.json` — manifest declaring the `omp.extensions` entry and pinned `devDependencies`.
- `README.md` — this file; `README.zh-CN.md` is its Simplified Chinese version.
