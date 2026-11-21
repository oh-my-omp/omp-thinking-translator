# Changelog

## [Unreleased]

### Fixed

- In Tern, a finished translation box that folds (with `expandThinkingBlocks` off, omp's default) now shows its title instead of disappearing.
- An earlier box no longer empties when the next thinking block starts with the same words ("The user …"); omp draws a new block before the plugin sees its first text, and that frame used to be taken for the earlier block.
- The `modelFailed` and `translateError` debug records carry the failure under `error`; before, it overwrote the record's message.

## [1.0.0] - 2026-11-19

### Breaking Changes

- Translator models now come from the omp model role `@omp-thinking-translator`: bind it in `/model` ("+ New role…"), add fallbacks under `retry.fallbackChains["omp-thinking-translator"]`, and set a reasoning level with a `:level` suffix. The `translatorModels` key and its `effort` entries are no longer read, and while the role is unbound nothing is translated and each session shows one notice.
- Settings are now omp plugin settings (`/settings` → Plugins, `omp plugin config set omp-thinking-translator <key> <value>`, or a project's `.omp/plugin-overrides.json`): `enabled`, `targetLanguage` and `lateNotify`. `thinking-translator.json` files are no longer read, and `/thinking-translator init` is removed.
- The diagnostic trace file next to the session file and its `trace` setting are removed; diagnostics are now debug records `thinking-translator: <event>` in omp's log, `~/.omp/logs/omp.<date>.<pid>.log`.
- Translations that finish after their box stopped being redrawn are no longer shown as notification rows unless the new `lateNotify` setting is on.
- omp 19 or later is required.

### Changed

- Lines are sent for translation from omp's message events as soon as they are complete, and only for thinking omp has drawn: a hidden or folded block is never sent, and drawing a box no longer starts requests.
- A new role binding, fallback chain or prose-only thinking setting takes effect in the running session, and the blocks on screen are translated again under it.
- `/thinking-translator` shows the plugin settings, the role binding, its fallbacks and the models the chain resolves to, each with its reasoning level.

### Fixed

- Subagent sessions, `omp -p` and RPC mode no longer translate, and a subagent starting or ending no longer clears the main session's translations.
- A failing translator model raises one warning per set of failing models instead of one per line; provider errors carry request ids, so every line's warning used to differ.

## [0.12.5] - 2026-11-19

### Changed

- Updated the shared copy of `i18n.ts` to oh-my-omp/shared@33dbe00.

## [0.12.4] - 2026-11-12

### Fixed

- A translated line that finished a few milliseconds before the late-translation debounce timer expired was written as an extra transcript notify row even though the still-repainting translation box showed it; every finished line now gets its own full debounce window, and only lines the box never drew are sent as notify rows.

## [0.12.3] - 2026-11-12

### Changed

- The package is now an omomp release member: merges to `main` no longer bump the version, a scheduled run publishes `## [Unreleased]` to the `release` branch, tag and GitHub Release every day at 02:00 GMT+9, and installs use `#release`.
