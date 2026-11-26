import type { Api, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";
import { type RoleChainCandidate, resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/utils/render-utils";
import { PLUGIN } from "./settings.ts";

export const ROLE = PLUGIN;

export type RoleBinding = Readonly<{ primary: string; fallbacks: readonly string[] }>;

export function roleBinding(settings: Settings): RoleBinding | undefined {
	const primary = settings.getModelRole(ROLE)?.trim();
	if (!primary) return undefined;
	return { primary, fallbacks: cfgRetryFallbackChains.get(settings)[ROLE] ?? [] };
}

export type ReasoningOptions = Pick<SimpleStreamOptions, "reasoning" | "disableReasoning">;

export type Candidate = Readonly<{ model: Model<Api>; reasoning: ReasoningOptions }>;

/**
 * That
 * default can be "thinking disabled" (pi-ai's Anthropic messages request sends `thinking: disabled`),
 * which an endpoint that requires reasoning rejects; such a model needs an explicit suffix.
 */
export function reasoningOptions(level: ConfiguredThinkingLevel | undefined): ReasoningOptions {
	if (level === undefined || level === "auto" || level === "inherit") return {};
	if (level === "off") return { disableReasoning: true };
	return { reasoning: level };
}

export function modelLabel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function bindingProviders(binding: RoleBinding): string[] {
	const providers = new Set<string>();
	for (const selector of [binding.primary, ...binding.fallbacks])
		for (const pattern of selector.split(/[\s,]+/)) {
			const slash = pattern.indexOf("/");
			if (slash > 0) providers.add(pattern.slice(0, slash).replace(/^@/, ""));
		}
	return [...providers];
}

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
