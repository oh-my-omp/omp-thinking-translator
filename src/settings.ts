/**
 * The plugin's own settings: `package.json` `omp.settings`, edited in `/settings` → Plugins or
 * `omp plugin config`. omp stores them in its plugin lockfile and raises no event when they change,
 * so a session reads them when it starts and again at every agent start (each prompt); everything in
 * between uses the last read. An invalid value falls back to its default with a warning.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import manifest from "../package.json";

export const PLUGIN = manifest.name;
const schema = manifest.omp.settings;

export type TranslatorSettings = Readonly<{
	/** Off: no line is dispatched, and boxes show nothing. */
	enabled: boolean;
	/** Language named in the translator prompt; part of every cell key. */
	targetLanguage: string;
	/** On: translations that finish after their box stopped being redrawn go out as notification rows. */
	lateNotify: boolean;
}>;

export const DEFAULT_SETTINGS: TranslatorSettings = {
	enabled: schema.enabled.default,
	targetLanguage: schema.targetLanguage.default,
	lateNotify: schema.lateNotify.default,
};

export type ParsedSettings = Readonly<{ settings: TranslatorSettings; invalid: readonly string[] }>;

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** One raw value, or its default when unset or invalid; `invalid` collects the keys that were. */
function pick<T>(raw: unknown, valid: (value: unknown) => value is T, fallback: T, key: string, invalid: string[]): T {
	if (raw === undefined) return fallback;
	if (valid(raw)) return raw;
	invalid.push(key);
	return fallback;
}

/** Settings from omp's merged (global + project) plugin settings record; unknown keys are ignored. */
export function parseSettings(raw: Readonly<Record<string, unknown>>): ParsedSettings {
	const invalid: string[] = [];
	const targetLanguage = pick(raw.targetLanguage, isNonEmptyString, DEFAULT_SETTINGS.targetLanguage, "targetLanguage", invalid);
	return {
		settings: {
			enabled: pick(raw.enabled, isBoolean, DEFAULT_SETTINGS.enabled, "enabled", invalid),
			targetLanguage: targetLanguage.trim(),
			lateNotify: pick(raw.lateNotify, isBoolean, DEFAULT_SETTINGS.lateNotify, "lateNotify", invalid),
		},
		invalid,
	};
}

export async function readSettings(logger: ExtensionAPI["logger"], cwd: string): Promise<TranslatorSettings> {
	try {
		const { settings, invalid } = parseSettings(await getPluginSettings(PLUGIN, cwd));
		if (invalid.length > 0) logger.warn("thinking-translator ignored invalid plugin settings", { keys: invalid });
		return settings;
	} catch (error) {
		logger.warn("thinking-translator could not read its plugin settings", { error: error instanceof Error ? error.message : String(error) });
		return DEFAULT_SETTINGS;
	}
}

export function sameSettings(a: TranslatorSettings, b: TranslatorSettings): boolean {
	return a.enabled === b.enabled && a.targetLanguage === b.targetLanguage && a.lateNotify === b.lateNotify;
}
