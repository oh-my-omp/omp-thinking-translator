export type Language = "en" | "zh";

export const LANGUAGE_ENV = "OMOMP_LANG";

export type Environment = Readonly<Record<string, string | undefined>>;

const LOCALE_ENV_KEYS = ["LC_ALL", "LC_MESSAGES", "LANG"] as const;

export function parseLanguage(value: string | undefined): Language | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized === "en" || normalized === "zh" ? normalized : undefined;
}

export function languageFrom(env: Environment): Language {
	const explicit = parseLanguage(env[LANGUAGE_ENV]);
	if (explicit !== undefined) return explicit;
	for (const key of LOCALE_ENV_KEYS) {
		const value = env[key]?.trim();
		if (value) return value.toLowerCase().startsWith("zh") ? "zh" : "en";
	}
	return "en";
}

export function language(): Language {
	return languageFrom(process.env);
}

/**
 * The language is read at each call, so text built once at import keeps the language of that moment.
 */
export function tr(en: string, zh: string): string {
	return language() === "zh" ? zh : en;
}
