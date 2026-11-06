export type Language = "en" | "zh";

/** The environment variable that explicitly selects this process's UI language. */
export const LANGUAGE_ENV = "OMOMP_LANG";

/** Resolve a supplied environment in the contract's priority order. */
export function resolveLanguage(env: Readonly<Record<string, string | undefined>>): Language {
	const explicit = env[LANGUAGE_ENV]?.trim().toLowerCase();
	if (explicit === "en" || explicit === "zh") return explicit;
	for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
		const value = env[key]?.trim();
		if (value) return value.toLowerCase().startsWith("zh") ? "zh" : "en";
	}
	return "en";
}

/** Resolve the UI language using the current environment. */
export function language(): Language {
	return resolveLanguage(process.env);
}

/** The UI text for this process's current language; English is always written first. */
export function tr(en: string, zh: string): string {
	return language() === "zh" ? zh : en;
}
