# omp-thinking-translator

English | [简体中文](README.zh-CN.md)

An omp plugin that draws a translation of each visible assistant thinking line under its thinking block. Translations are for display only and live in memory: they never enter the session file, the next model request or compaction input.

## What You See

- One box per thinking block, titled `Thinking translation · Block N · done/total` (`思考翻译 · 块 N · done/total` in a Chinese UI). A line appears once its whole translation is done; lines still being translated only count in the title and take no rows. A line whose translator models all failed shows a `Translation failed:` row, and the first failure of each set of failing models also raises one warning.
- In Tern (a terminal speaking the Tern Surface Protocol) the box is a native collapsible section shaped like omp's own thinking: a spinner while lines are pending; once they settle it folds unless omp's `expandThinkingBlocks` setting is on. Folding or unfolding it yourself overrides both.
- Lines are translated while the block is still streaming, each as soon as it is complete. A line is translated when its prose, with Markdown inline code left out, has more Latin letters than Chinese characters, so Chinese reasoning that mentions `expandThinkingBlocks` stays untranslated, and lines of only numbers or symbols are skipped.
- Only thinking that omp actually draws is sent anywhere. A block that is hidden (`hideThinkingBlock`) or folded is never translated.
- Only the main interactive session translates. Subagents, `omp -p` and RPC mode do nothing.

## Requirements

omp 19 or later; the plugin is developed against the latest omp release (19.0.0 at the time of writing). It is omp-only: the box attaches through omp's assistant thinking renderer, which pi does not have.

## Install

```bash
omp plugin install https://github.com/oh-my-omp/omp-thinking-translator#release
```

Installs track the `release` branch, which the daily release run updates; `omp plugin upgrade` moves an existing install to the latest published version. For local development, load the entry file directly (`omp -e /absolute/path/to/omp-thinking-translator/index.ts`) or install from a checkout (`omp plugin install /absolute/path/to/omp-thinking-translator`).

## Choose the Translator Models

The plugin translates with omp's model role `@omp-thinking-translator`. Until that role is bound, nothing is translated and each session shows one notice saying so.

Bind it in `/model`: pick "+ New role…", name it `omp-thinking-translator`, and assign a fast, inexpensive model. Add fallbacks to the role in the same view with "+ New fallback…". The same binding in `~/.omp/agent/config.yml` (or a project's `.omp/config.yml`):

```yaml
modelRoles:
  omp-thinking-translator: deepseek/deepseek-v4-flash:low
retry:
  fallbackChains:
    omp-thinking-translator:
      - ollama/qwen2.5:7b:off
```

- **Order.** Every line tries the role's model first and the fallbacks in order, moving on only when a model fails: missing from the registry, no credentials, a stream error, an empty answer, or an answer that echoes the prompt's input marker. Nothing is remembered between lines. When every model failed, the whole chain is tried again after 0.5 s, 2 s and 6 s before the line shows its failure row.
- **Reasoning level.** The `:level` suffix (`:off`, `:minimal` … `:max`) sets the reasoning effort of the translation requests to that model. Without a suffix, pi-ai's default for the model's API applies, which on some APIs means "reasoning disabled"; an endpoint that requires reasoning then rejects every request (`Reasoning is mandatory for this endpoint`), so give such a model an explicit level. Each request allows 1024–8192 output tokens, scaled to the line's length; a reasoning model that spends them on hidden reasoning returns empty text, so a low level suits translation.
- **Discovery.** When a model of a proxy-discovered provider has dropped out of omp's registry, the plugin asks omp to discover that provider again and resolves the chain once more.
- **Changes apply at once.** A new binding or fallback chain takes effect in the running session; the blocks on screen are translated again under it. Translations made under the previous binding are kept, so switching back reuses them.

`/thinking-translator` shows the plugin settings, the binding, the fallbacks and the models the chain resolves to right now, each with its reasoning level.

The translator models receive your thinking text: every provider in the chain can be sent a line when the ones before it fail. Use a local model if your thinking should not leave the machine.

## Settings

Plugin settings are edited in `/settings` → Plugins or with `omp plugin config set omp-thinking-translator <key> <value>`. A project can override them in `.omp/plugin-overrides.json`:

```json
{ "settings": { "omp-thinking-translator": { "targetLanguage": "Japanese" } } }
```

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Translate visible thinking lines. Translation also needs the role binding above. |
| `targetLanguage` | string | `"Simplified Chinese"` | The language the lines are translated into. |
| `lateNotify` | boolean | `false` | Show translations that finish after their box stopped being redrawn as notification rows (see below). |

omp raises no event when plugin settings change, so the plugin reads them when a session starts and again before every prompt; a change applies from the next prompt. An invalid value falls back to its default, with a warning in the omp log.

**`lateNotify`.** In an ANSI terminal omp commits a message to scrollback, typically at a tool call, and stops redrawing it; a line whose translation finishes after that never appears in its box. With `lateNotify` on, such lines go out as one dim notification row at the current end of the transcript, headed `Thinking translation · Block N`, after a 400 ms debounce. Tern keeps its sections live and never gets these rows.

## UI Language

The plugin's own text (box titles, notices, `/thinking-translator`) follows `OMOMP_LANG` (`en` or `zh`, whitespace and case ignored). Without it, the first non-empty `LC_ALL`, `LC_MESSAGES` or `LANG` selects Chinese when it starts with `zh`, otherwise English. The variables are read each time text is produced. The language of the translations is `targetLanguage`.

## Diagnostics

The plugin writes debug records named `thinking-translator: <event>` to omp's log, `~/.omp/logs/omp.<date>.<pid>.log`, at omp's default log level: `activate` (translation on or off, binding, language), `dispatch`, `discover`, `request` (model and reasoning level), `modelFailed`, `translateError`, `done`, `painted` and `lateFlush`. Records carry the first 40–60 characters of each source line. omp also keeps the body of every request a provider rejects with HTTP 400 under `~/.omp/logs/http-400-requests/`, translation requests included.

## Context Boundary

The translation box is presentation output, not conversation content. The assistant thinking that omp stores, sends on the next turn and feeds to compaction stays the text the model produced.

- Translations live in the session's memory and are read only by the boxes and the late-notification rows. They are dropped when the session ends or switches.
- The plugin registers none of the hooks that can change what a model sees (`context`, `before_provider_request`, `before_agent_start`, `session_before_compact`, `session_stop`). Its handlers are the session lifecycle, a settings read at agent start, and thinking bookkeeping in `message_start`, `message_update` and `message_end`.
- omp hands the renderer the display text in a fresh object, not the stored message, so the plugin cannot change the message through it.

To check this yourself:

1. Write a throwaway extension that registers `pi.on("before_provider_request", …)` and `pi.on("session_before_compact", …)`, appends `JSON.stringify` of the payload and of `event.preparation` to two files, and returns `undefined` from both.
2. Start `omp -e /path/to/omp-thinking-translator/index.ts -e /path/to/observer.ts` in a scratch directory with the role bound.
3. Send an English prompt that produces several thinking lines and wait until the box reads `done/total` with both numbers equal. Copy two distinctive fragments of the translation that occur in neither the prompt nor the thinking.
4. Send another turn and search the newest `before_provider_request` payload for those fragments and the box title. Expect none, and expect the assistant thinking to match what the session file stores.
5. Add turns until `/compact` has messages to summarize, run it, and search the recorded preparation and the stored summary the same way. Expect none.
6. Search every content part of the session file. Expect none.

Outside this boundary:

- **The translation requests.** Each line goes to the role's models as a standalone request, separate from the conversation. Those providers see the text and keep it under their own policy.
- **What is drawn.** Terminal scrollback, late-notification rows, terminal recordings and omp's `/debug-transcript` contain translations by design.
- **Untested paths.** Session export and import, and branch switching, have not been checked.

## Limitations

- Thinking that omp does not draw is never translated, and translations are not backfilled: a reopened session shows its history without them.
- In an ANSI terminal, once omp has committed part of a message to scrollback, every line that finishes afterwards makes omp rewrite the message from the last row it can still match: one rewrite per late line.
- Within one session, identical lines share one translation per binding and target language.

## Security Notes

omp plugins run with full system permissions. Review a plugin's source before installing it.

## Development

```bash
bun install
bun run check   # Biome and TypeScript
bun test
```

Tests run under Bun because omp's packages expose TypeScript sources as their entries.

## Package Layout

- `index.ts` — entry point: one translator per main interactive session, the renderer, the `/thinking-translator` command and the event wiring.
- `src/` — the session, settings, role chain, translation requests, line and block tracking, the box renderer, late notifications and the status command.
- `tests/thinking-translator.test.ts` — unit tests, including contract tests against omp's thinking display formatting.
- `omomp-shared/` — copies of files shared across oh-my-omp repositories.
- `README.md` — this file; `README.zh-CN.md` is its Simplified Chinese version.
