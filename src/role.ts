/**
 * The translator models: omp's model role `@omp-thinking-translator`, bound by the user in `/model`
 * ("+ New role"), with its ordered fallbacks under `retry.fallbackChains["omp-thinking-translator"]`
 * and a per-entry thinking level as the selector's `:level` suffix. omp owns all of it; the plugin
 * keeps no copy and resolves the chain again at every attempt round, so a binding, login or
 * discovery change applies to the next round. An unbound role means no translation.
 */
import type { Api, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";
import { type RoleChainCandidate, resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { type ConfiguredThinkingLevel, concreteThinkingLevel, shouldDisableReasoning, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import { PLUGIN } from "./settings.ts";

/** The role name is the plugin's name; users select it as `@omp-thinking-translator`. */
export const ROLE = PLUGIN;

/** What the user configured for the role: the primary selector and its fallback selectors. */
export type RoleBinding = Readonly<{ primary: string; fallbacks: readonly string[] }>;

/** The configured binding, or undefined while the role has no primary selector. */
export function roleBinding(settings: Settings): RoleBinding | undefined {
	const primary = settings.getModelRole(ROLE)?.trim();
	if (!primary) return undefined;
	return { primary, fallbacks: cfgRetryFallbackChains.get(settings)[ROLE] ?? [] };
}

export type ReasoningOptions = Pick<SimpleStreamOptions, "reasoning" | "disableReasoning">;

/** One model of the chain with the reasoning options its selector asked for. */
export type Candidate = Readonly<{ model: Model<Api>; reasoning: ReasoningOptions }>;

/**
 * The stream options for a selector's thinking level: `:off` disables reasoning, a concrete effort is
 * sent as is (omp already clamped it to the model while resolving the selector), and no suffix or
 * `auto`/`inherit` sends neither field, leaving the provider default.
 */
export function reasoningOptions(level: ConfiguredThinkingLevel | undefined): ReasoningOptions {
	const concrete = concreteThinkingLevel(level);
	if (shouldDisableReasoning(concrete)) return { disableReasoning: true };
	const effort = toReasoningEffort(concrete);
	return effort === undefined ? {} : { reasoning: effort };
}

export function modelLabel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/** Providers named by the binding's provider-qualified selectors (`provider/id[:level]`), each once. */
export function bindingProviders(binding: RoleBinding): string[] {
	const providers = new Set<string>();
	for (const selector of [binding.primary, ...binding.fallbacks])
		for (const pattern of selector.split(/[\s,]+/)) {
			const slash = pattern.indexOf("/");
			if (slash > 0) providers.add(pattern.slice(0, slash).replace(/^@/, ""));
		}
	return [...providers];
}

/**
 * Resolves the chain for one attempt round. omp keeps discovered models only for the providers it is
 * refreshing (the session model's), so a proxy provider the role points at can drop out of the registry
 * after its cache expires. When the configured primary resolved to nothing (empty chain, or the first
 * candidate replaces a configured selector), the providers the binding names are discovered once and the
 * chain is resolved again. `discover` joins concurrent rounds onto one running discovery per provider.
 */
export async function resolveChain(
	settings: Settings,
	ctx: ExtensionContext,
	discover: (providers: readonly string[]) => Promise<void>,
): Promise<Candidate[]> {
	const binding = roleBinding(settings);
	if (!binding) return [];
	let chain: RoleChainCandidate[] = resolveRoleChain(ROLE, settings, roleCandidatePool(ROLE, settings, ctx.modelRegistry));
	if (chain.length === 0 || chain[0]?.replaces !== undefined) {
		const providers = bindingProviders(binding);
		if (providers.length > 0) {
			await discover(providers);
			chain = resolveRoleChain(ROLE, settings, roleCandidatePool(ROLE, settings, ctx.modelRegistry));
		}
	}
	return chain.map(({ model, thinkingLevel }) => ({ model, reasoning: reasoningOptions(thinkingLevel) }));
}
