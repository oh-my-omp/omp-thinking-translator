import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

export type Language = "en" | "zh";

/** The environment variable that explicitly selects this process's UI language. */
export const LANGUAGE_ENV = "OMOMP_LANG";

const OMP_CONFIG_FILES = ["omomp.yml", "omomp.yaml", "omomp.json", "omomp.toml"] as const;
type ConfigFile = (typeof OMP_CONFIG_FILES)[number];
type BunRuntime = {
	YAML?: { parse: (text: string) => unknown };
	TOML?: { parse: (text: string) => unknown };
};

let omompLanguageRead = false;
let omompLanguage: Language | undefined;

/** Resolve the language configured by the one unambiguous omomp file, at most once per process. */
function readOmompLanguage(): Language | undefined {
	if (omompLanguageRead) return omompLanguage;
	omompLanguageRead = true;
	try {
		const agentDir = getAgentDir();
		const existing = OMP_CONFIG_FILES.flatMap((name) => {
			const path = join(agentDir, name);
			try {
				return statSync(path).isFile() ? [{ name, path }] : [];
			} catch {
				return [];
			}
		});
		if (existing.length !== 1) return undefined;
		const candidate = existing[0]!;
		const parsed = parseConfig(candidate.name, readFileSync(candidate.path, "utf8"));
		omompLanguage = parseLanguage(parsed);
		return omompLanguage;
	} catch {
		return undefined;
	}
}

function parseConfig(name: ConfigFile, text: string): unknown {
	if (name === "omomp.json") return JSON.parse(text);
	const runtime = globalThis as unknown as { Bun?: BunRuntime };
	const bun = runtime.Bun;
	if (name === "omomp.toml") return bun?.TOML?.parse(text);
	return bun?.YAML?.parse(text);
}

function parseLanguage(value: unknown): Language | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value) || !("omomp-lang" in value)) return undefined;
	const section = value["omomp-lang"];
	if (!section || typeof section !== "object" || Array.isArray(section) || !("language" in section)) return undefined;
	if (Object.keys(section).length !== 1) return undefined;
	const configured = section["language"];
	return configured === "en" || configured === "zh" ? configured : undefined;
}

/** Resolve a supplied environment and optional omomp value in the contract's priority order. */
export function resolveLanguage(env: Readonly<Record<string, string | undefined>>, fromOmomp?: Language): Language {
	const explicit = env[LANGUAGE_ENV]?.trim().toLowerCase();
	if (explicit === "en" || explicit === "zh") return explicit;
	if (fromOmomp) return fromOmomp;
	for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
		const value = env[key]?.trim();
		if (value) return value.toLowerCase().startsWith("zh") ? "zh" : "en";
	}
	return "en";
}

/** Resolve the UI language using the current environment, cached omomp setting, then locale. */
export function language(): Language {
	const explicit = process.env[LANGUAGE_ENV]?.trim().toLowerCase();
	if (explicit === "en" || explicit === "zh") return explicit;
	return resolveLanguage(process.env, readOmompLanguage());
}

/** The UI text for this process's current language; English is always written first. */
export function tr(en: string, zh: string): string {
	return language() === "zh" ? zh : en;
}
