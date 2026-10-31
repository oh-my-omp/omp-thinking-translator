# Repository Guidelines

## Project Overview

`omp-thinking-translator` is a single-file [Oh My Pi](https://github.com/oh-my-pi) (omp) extension that renders a translated copy of each visible assistant *thinking* block underneath it in the TUI. Translation is **display-only and memory-only**: it is never written to the session file, model requests, or compaction input. The only file the extension writes by default is a diagnostic trace, `<session file without .jsonl>.thinking-translator-trace.jsonl` next to the session JSONL (config `trace: false` disables it; the session file itself is never touched). Default target language is Simplified Chinese; the translator models are an ordered fallback chain chosen by config (`translatorModels: [{ provider, id, effort? }, …]`), each resolved through the host model registry at request time, with the extension triggering provider discovery itself when a model is absent.

Package is `private` (not published to npm); it is installed into omp directly from git. `CLAUDE.md` holds two hard rules — keep `@oh-my-pi/*` on the latest release, and the version policy (CI bumps the patch on every push to `main`; minor bumps are set by hand) — read it before touching deps or committing.

## Architecture & Data Flow

Everything lives in `extensions/thinking-translator.ts` (default export `thinkingTranslator(api: ExtensionAPI)`); closure-scoped state, no classes.

```mermaid
flowchart LR
  H[host thinking events] -->|message_start / thinking_delta / thinking_end / message_end| T[tracked blocks map<br/>partial text + ended flag, cap 32]
  H -->|registerAssistantThinkingRenderer<br/>context.text = host display text| R[renderer component: render() Box + Text title + Markdown body, describe() native section]
  R --> D[dispatch: split lines → shouldTranslateLine → resolveTrackedLine → canonical raw line]
  T --> D
  D -->|uncached canonical line| C[cells Map<br/>key = chain of provider/id@effort + targetLanguage + raw line]
  C --> S[translateLine: each round tries translatorModels 1→N<br/>resolveModel → streamTranslation (pi-ai streamSimple + effort)<br/>SOURCE_TEXT_BEGIN echo → abort attempt + next model<br/>whole chain failed → backoff 500/2000/6000 ms, restart at 1]
  S -->|deltas → requestRender| R
  C -->|done but never painted| L[lateQueue → 400 ms debounce → buildLateRows → ctx.ui.notify]
```

Key invariants (deliberate; do not "simplify" them):

- **Host display text is the source of truth.** The renderer translates `context.text` (post-`formatThinkingForDisplay`), not raw event text. `tests/thinking-translator.test.ts:163-178` pins the host rewrite contract by importing the host source from `node_modules`.
- **Block matching is by content, not `contentIndex`, and yields the canonical raw line.** `matchBlockLine`/`resolveTrackedLine` accept a display line only when it is a *complete* line of a tracked block, tolerating host ellipsis/punctuation rewrites and rejecting a growing block's partial last line, and return the raw line it matched. The raw line — not the display variant — is the cell key and translation source: during the reveal a frame that lacks only the final period is also accepted, and keying by display text would translate that line twice (the first cell never gets painted and leaks into a late notify row). Index-based matching mis-attributes blocks across renderer rebuilds.
- **Per-line Latin gate.** `shouldTranslateLine` excludes Markdown inline-code spans from language classification, then requires the remaining prose's Latin chars to outnumber its CJK chars. Identifiers, paths, and commands therefore cannot make Chinese prose look foreign.
- **Cache key** includes the whole model chain (order and each entry's effort) and the language so switching any of them invalidates; the cell map survives message boundaries so history still renders. The cell map holds display state per line, never model choice.
- **Fallback is stateless.** Every round of every line starts at `translatorModels[0]` and moves on only when that model fails; an accumulated stream containing the internal `SOURCE_TEXT_BEGIN` marker aborts only that model's in-flight request and counts as such a failure. Nothing records which model failed or succeeded (no sticky model, no circuit breaker, no discovery cooldown). The only shared state on this path is `discoveryInFlight`, which joins concurrent requests to a discovery of the same provider that is already running and is deleted when it settles. Do not add memory of failures to "save" requests: it breaks the "always try 1 first" contract.
- **No placeholders.** Pending/empty rows are omitted; box title shows `done/total`; repaint via `context.requestRender`.
- **Late rows.** Cells finishing after the scrollback froze (typically at a tool call) go through `ctx.ui.notify`; the queue and coalesced rows retain numeric `thinkingIndex`, and `buildLateRows` resolves every block label in the current UI language when generating the notification. Payloads coalesce only while `chatContentGeneration` is unchanged, and generation advances only on `message_start`/`toolcall_start` — not on thinking deltas.
- **Native (Tern) surface.** The component also implements `describe(cx)` (Tern Surface Protocol): a collapsible `section` (role `omp.thinking.live` while any cell is open, `omp.thinking` once all settle; when settled it folds by default only while the host setting `expandThinkingBlocks` is off — read through `cfgExpandThinkingBlocks.get(pi.pi.settings)` on every describe, never cached, so the host stays its only source — and a user `toggle` on the root key `""` overrides either way) holding a `head` and an `md` body, the shape the host uses for its own thinking. `render()` and `describe()` share `collect()` (dispatch, cell lookup, `painted`), so a native surface, which never calls `render()`, still triggers translation. `describe` returns the same node object while its signature is unchanged, and `null` (→ host `rows` fallback) when nothing is paintable or the terminal does not list `section`/`md`. The first `describe` call sets `nativeSeen`, which disables the late-notify fallback because a TSP surface has no append-only scrollback. `isNativeRendering()` is deliberately not used: it is module state and reads false when the extension and host resolve different `pi-tui` copies. The settings read goes through `pi.pi.settings` (the host instance injected into the API) for the same reason; the `cfgExpandThinkingBlocks` handle reads by its id path, so it returns the host value even from a duplicate module copy.
- **Each qualifying line streams independently**; no concurrency limit or per-block queue.
- **Config is loaded once per `message_start`**, replaced never cleared. `session_start`/`session_switch`/`session_shutdown` abort the shared `AbortController` and clear all state.
- **Failure policy.** Bad config JSON, a `translatorModels` that is not an array, an entry without non-empty `provider`/`id`, or an entry `effort` outside `off` + the host's `Effort` levels → warn once per path, force `enabled: false` (an invalid entry is never dropped, since that would shift the fallback order). Empty chain → warn once, nothing dispatched. Per model attempt: registry `find`; absent → `refreshDiscoverableProviders([provider], "online")` (joined while in flight, no cooldown), re-`find`; still absent → warn once per model per session and count it as that model's failure. Auth/stream/empty response, a response containing the prompt's internal `SOURCE_TEXT_BEGIN` marker, or an effort level the model does not support (pi-ai's `requireSupportedEffort` throws before sending) → also that model's failure. Marker detection aborts the per-attempt controller before throwing; the outer session signal remains live so `translateLine` can continue with the next configured model. A failure resets any partial streamed text before the next model. After the whole chain fails, retry it from the first model after 500/2000/6000 ms; only exhaustion becomes an error cell and one deduplicated UI notification.
- **Effort goes through pi-ai, not around it.** Requests use `streamSimple`, the only pi-ai entry that maps `reasoning`/`disableReasoning` onto each provider's wire field; unset effort sends neither. Which levels a model supports is pi-ai's and the model catalog's call (`model.thinking.efforts`); the extension keeps no copy and only lists them in `status`. `EFFORT_LEVELS` is a ``Record<`${Effort}`, true>`` so a host that adds or drops a level fails the typecheck there.

Host APIs relied on: `api.registerAssistantThinkingRenderer`, `api.registerCommand`, `api.on(...)` lifecycle/message events, `api.pi.settings` (the host `Settings` instance), `ctx.modelRegistry.find`, `ctx.modelRegistry.refreshDiscoverableProviders`, `getApiKeyAndHeaders`, `ctx.ui.notify`, `ctx.cwd`; `streamSimple`/`SimpleStreamOptions`/`Api`/`Model` from `@oh-my-pi/pi-ai` (the `Effort` type is taken from `SimpleStreamOptions["reasoning"]` because extensions cannot resolve `@oh-my-pi/pi-catalog`); `Box`/`Markdown`/`Text`/`node`/`span` from `@oh-my-pi/pi-tui` plus the `Component.describe` / `NativeEventTarget` / `DescribeContext` / `NativeNode` / `NativeUiEvent` types; `getMarkdownTheme` from `@oh-my-pi/pi-coding-agent` and `cfgExpandThinkingBlocks` from `@oh-my-pi/pi-coding-agent/session/settings` (a host-bundled module key). The extension is omp-only (needs the thinking renderer hook); it does not run on plain pi.

## Key Directories

| Path | Purpose |
| --- | --- |
| `extensions/thinking-translator.ts` | The whole extension: state, renderer, dispatch, streaming, config, `/thinking-translator` command, `__testing` exports |
| `tests/thinking-translator.test.ts` | Unit tests over `__testing` pure helpers + one host contract test |
| `README.md`, `README.zh-CN.md` | User docs in English (default) and Simplified Chinese, same content: install, config keys, pipeline, boundary evidence, limitations |
| `TODO.md` | Open work: display polish, non-LLM translation providers |
| `CLAUDE.md` | Dependency and version-bump policy (mandatory) |

No `src/`, no build output; the `.ts` file is loaded by omp as-is.

## Development Commands

```bash
pnpm install                      # pnpm is the package manager (no packageManager pin; pnpm 11 / bun 1.4 observed)
pnpm typecheck                    # tsc --noEmit on the single entry file; all flags on the CLI, no tsconfig
pnpm test                         # bun test tests/thinking-translator.test.ts
pnpm check                        # typecheck && test — the required gate before commit / install
bun test tests/thinking-translator.test.ts -t "config paths"   # single test by name substring

# Run against a live omp without installing
omp -e /absolute/path/to/extensions/thinking-translator.ts

# Install / refresh the plugin after the bump-version run on main finishes (see CLAUDE.md)
omp plugin install git:github.com/oh-my-omp/omp-thinking-translator
omp plugin list                   # confirm the displayed version matches package.json
```

In-app: `/thinking-translator status | init | init --global | init --project`. `init` writes a **disabled** template (`<agentDir>/thinking-translator.json` or `<cwd>/.omp/thinking-translator.json`) and refuses to overwrite.

Config precedence: defaults < global < project, merged per field; `translatorModels` is replaced as a whole. Keys: `enabled` (default `true`), `targetLanguage` (default `"Simplified Chinese"`), `translatorModels: [{ provider, id, effort? }, …]` (ordered fallback chain, default `[]`; at least one entry needed for any translation to happen; `effort` is `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`, unset or `null` = model default; `null` for the whole key clears the chain), `trace` (default `true` = sibling of the session file; string = explicit path; `false` = off). The old single-model `translatorModel` key is ignored like other legacy keys.

## Code Conventions & Common Patterns

- **TypeScript ESM, strict-ish, no lint/format config** (no Biome/ESLint/Prettier, no tsconfig). Match the existing style by eye: 2-space indent, double quotes, trailing semicolons, `const` arrow/function declarations.
- **Closure-based module state**, not classes: `Map`s for cells/blocks, a `lateQueue`, timers (`unref`'d), one shared `AbortController`. Helpers are plain functions defined after the export.
- **Types over runtime checks inside; parse at the boundary.** Config JSON is read as `unknown` and normalized by `mergeConfig`/`normalizeTranslatorModels`/`parseModelRef`/`parseEffortSetting` into a resolved record. `TranslationProgress` is a discriminated union (`pending | streaming | done | error`); payloads are `Readonly`.
- **Small isolated helpers are test-exported** through the `__testing` object at the bottom of the file (`mergeConfig`, `normalizeTranslatorModels`, `reasoningOptions`, `shouldTranslateLine`, `matchBlockLine`, `resolveTrackedLine`, `splitTranslationLines`, `cellKey`, `cleanTranslation`, `abortOnSourceTextBegin`, `buildLateRows`, config path helpers, `DEFAULT_CONFIG`). Most are pure; `abortOnSourceTextBegin` deliberately owns the one per-attempt side effect being tested — aborting its supplied controller before throwing. New helper logic gets a behavioral test in the same file; do not test extension lifecycle wiring there.
- **Errors are values or one-shot notifications.** Expected failures (bad config, missing model, exhausted retries) become state (`enabled:false`, `error` cell) plus a deduplicated `ctx.ui.notify`; nothing throws into the host. Credential lookup failures are wrapped in diagnostic `Error`s for retry handling.
- **Async: fire-and-forget per line**, streaming via `for await` over pi-ai events, redraw on every accepted text delta, abort-aware (`signal.aborted` checks return early without erroring). Each model attempt combines the session signal with its own `AbortController`, so protocol-marker detection can cancel one provider request without cancelling the line's fallback chain.
- **Prompting.** The translator prompt treats the source as inert data and forbids answering/summarizing/adding code; `SOURCE_TEXT_BEGIN` / `SOURCE_TEXT_END` delimit that input. Returning `SOURCE_TEXT_BEGIN` is a protocol error that aborts the current model attempt. `cleanTranslation` strips code fences, `<thinking>`/`<text>` wrappers and the "原文保持不变" phrase. Keep the prompt and marker guard aligned if either changes.
- Comments in source/tests reference user-reported regressions (e.g. short-block, partial-line, coalescing); keep those tests green rather than rewriting them.

## Important Files

- `extensions/thinking-translator.ts` — entry point declared in `package.json` `omp.extensions`.
  - `~:10-70` types (incl. `Effort`/`EffortSetting`, `TranslationView`, `translatorModels` and `trace` in `ResolvedTranslatorConfig`); `~:72-111` constants (`EFFORT_LEVELS`), `trace()`/`resolveTraceFile`, `discoveryInFlight`; `~:112-263` state + renderer component (`render`, `describe`, `handleNativeEvent`) + command registration; `~:264-343` late-row queue/notify/reset; `~:344-456` session/message hooks, `dispatch`, `cellBody`; `~:458-628` model-chain loop + retry + streaming, cache key, `reasoningOptions`, block matching (`matchBlockLine`, `resolveTrackedLine`); `~:630-836` command, config load/validate/init (incl. `normalizeTranslatorModels`/`parseModelRef`/`parseEffortSetting`), per-request model resolution + discovery, status; `~:838-891` prompt and cleanup; `~:893-` `__testing`.
- `package.json` — scripts, `omp.extensions` manifest, exact `@oh-my-pi/*` pins (`version` field = installed-plugin identity).
- `pnpm-workspace.yaml` — `allowBuilds: false` for native deps (`esbuild`, `sharp`, `koffi`, `onnxruntime-node`, …) and a package-family `minimumReleaseAgeExclude` for `@oh-my-pi/*`.
- `tests/thinking-translator.test.ts:4` — direct import of `node_modules/@oh-my-pi/pi-tui/src/chat/thinking-display.ts` (`formatThinkingForDisplay`; it moved there from `pi-coding-agent/src/utils/` by 18.8.7).

## Runtime/Tooling Preferences

- **Runtime target is the user's installed omp** (Bun-based). Tests run under `bun test` using the `node:test`/`node:assert/strict` API. Typecheck uses `tsc` with `--moduleResolution bundler --module esnext --target es2024 --types node`; Node built-ins (`fs`, `os`, `path`) are used, no Bun-only APIs in the extension.
- **Package manager: pnpm** (`pnpm-lock.yaml` v9). Do not introduce `package-lock.json`/`bun.lockb`.
- **`@oh-my-pi/*` devDependencies must be exact and aligned to `dist-tags.latest`** (`CLAUDE.md`). If `pnpm check` fails after a bump because the host changed `formatThinkingForDisplay`, adapt the extension — never pin back.
- The only CI is `.github/workflows/bump-version.yml`, which bumps the version on every push to `main` and runs no checks; `pnpm check` remains the only gate. No formatter; do not add one as part of unrelated work.
- Every push to `main` gets a new patch version from CI. A commit that changes visible behavior sets the next minor (`0.(Y+1).0`) by hand before pushing, and CI turns it into `0.(Y+1).1`. Verify with `omp plugin install` + `omp plugin list` after that run.

## Testing & QA

- Framework: Bun test runner executing `node:test`/`node:assert/strict` tests; 27 flat tests, no `describe`, no mocks, no shared builders — inline literals only.
- Coverage: config paths and merge/validation, model chain parsing (order, per-entry effort, whole-chain replacement, rejection of incomplete entries), effort parsing, effort → `streamSimple` option mapping, Latin gating, complete-line/streaming block matching incl. the reveal-frame-minus-period regression, cache key, translation cleanup/splitting, `SOURCE_TEXT_BEGIN` per-attempt cancellation, late-row payload building, and the host display-rewrite contract. **Not** covered: extension activation, live model calls and the fallback order across them (verify from a real session's trace: `request`/`modelFailed` records per model), the provider wire field an effort level maps to (verify with `PI_REQ_DEBUG=1`, which dumps each request body to `rr-session-N.json` in the cwd), model discovery, renderer/notify factory integration, ANSI frozen-scrollback timing, or the native `describe` path.
- Expectations: any change to a `__testing` helper or the block-matching/late-row rules gets a behavioral test in the same file; lifecycle/renderer changes are verified by running a session-saving omp against the change and reading the per-session trace file (`session_start → message_start → thinking_end → dispatch → request (→ modelFailed → request on the next model) → done → settled → render → painted → lateFlush`), plus observing the box (`done/total` title) and late `notify` rows. Fresh processes are not representative of long-lived agentic sessions: model discovery is re-run at startup and hub PTYs do not commit rows to native scrollback, so a change that "works in `/tmp`" must still be confirmed from a real session's trace. Manual repro steps for the context-exclusion boundary live in `README.md` (Context Boundary section).
- Known limitations to keep in mind when judging "expected" behavior: folded/invisible blocks never render; in ANSI terminals scrollback freezes at the first tool call (late rows fall back to notify; not used on a Tern native surface); no backfill on session reopen; identical lines share one translation per model chain+language; thinking lines are sent to the configured translator models, and to later ones in the chain when earlier ones fail (privacy note in README). The native `describe` path has no unit coverage; verify it in a real Tern pane (record with `PI_TUI_TSP_RECORD`).
- `README.md` and `README.zh-CN.md` are kept in step with the code and with each other (install command is `omp plugin install …`, pins match `package.json`); if they disagree, `package.json` and `CLAUDE.md` win and the READMEs are the thing to fix.
