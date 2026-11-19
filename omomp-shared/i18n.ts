// Language of human-facing text (notifications, labels, dialogs, renderers).
// Resolution order: `OMOMP_LANG` → first non-empty of `LC_ALL`, `LC_MESSAGES`,
// `LANG` → English. The environment is re-read on every call; nothing is
// evaluated at import, and no configuration file is read — the omp-config
// `omomp-lang.language` setting reaches plugins through `OMOMP_LANG` (or, in
// omp-config's own copy, through the environment map passed to
// `languageFrom`).

/** A language human-facing text may be written in. */
export type Language = "en" | "zh";

/** The environment variable that names the language explicitly. */
export const LANGUAGE_ENV = "OMOMP_LANG";

/** An environment map: `process.env`, or a map supplied by the caller. */
export type Environment = Readonly<Record<string, string | undefined>>;

const LOCALE_ENV_KEYS = ["LC_ALL", "LC_MESSAGES", "LANG"] as const;

/** `en` or `zh` when `value` names one (any case, surrounding space ignored); `undefined` otherwise. */
export function parseLanguage(value: string | undefined): Language | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized === "en" || normalized === "zh" ? normalized : undefined;
}

/**
 * The language `env` asks for:
 *
 * 1. `OMOMP_LANG` when `parseLanguage` accepts it;
 * 2. the first non-empty (after trimming) of `LC_ALL`, `LC_MESSAGES`, `LANG`:
 *    Chinese when it starts with `zh` (any case), else English;
 * 3. English.
 *
 * Only `env` is consulted; `process.env` is never read here.
 */
export function languageFrom(env: Environment): Language {
	const explicit = parseLanguage(env[LANGUAGE_ENV]);
	if (explicit !== undefined) return explicit;
	for (const key of LOCALE_ENV_KEYS) {
		const value = env[key]?.trim();
		if (value) return value.toLowerCase().startsWith("zh") ? "zh" : "en";
	}
	return "en";
}

/** The language of the current process environment, re-read on every call. */
export function language(): Language {
	return languageFrom(process.env);
}

/**
 * The text for the current language; both are written where the text is used, English first.
 * The language is read at each call, so text built once at import keeps the language of that moment.
 */
export function tr(en: string, zh: string): string {
	return language() === "zh" ? zh : en;
}
