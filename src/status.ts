import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { tr } from "../omomp-shared/i18n.ts";
import { modelLabel, ROLE, resolveChain, roleBinding } from "./role.ts";
import { readSettings } from "./settings.ts";

export async function showStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const host = pi.pi.settings;
	const settings = await readSettings(pi.logger, ctx.cwd);
	const binding = roleBinding(host);
	const lines = [
		tr("thinking-translator status", "thinking-translator 状态"),
		`enabled: ${settings.enabled}`,
		`targetLanguage: ${settings.targetLanguage}`,
		`lateNotify: ${settings.lateNotify}`,
	];
	if (!binding) {
		lines.push(
			tr(
				`role @${ROLE}: not bound; bind it in /model ("+ New role") to translate thinking`,
				`角色 @${ROLE}：未绑定；在 /model 中绑定（"+ New role"）后才会翻译 thinking`,
			),
		);
	} else {
		lines.push(
			tr(`role @${ROLE}: ${binding.primary}`, `角色 @${ROLE}：${binding.primary}`),
			tr(
				`fallbacks (retry.fallbackChains): ${binding.fallbacks.join(", ") || "none"}`,
				`回退链（retry.fallbackChains）：${binding.fallbacks.join("、") || "无"}`,
			),
		);
		const chain = await resolveChain(host, ctx, (providers) =>
			ctx.modelRegistry.refreshDiscoverableProviders([...providers], "online").catch(() => undefined),
		);
		if (chain.length === 0) lines.push(tr("models: none available", "模型：没有可用的"));
		else {
			lines.push(tr("models (tried in order, every request starts at 1):", "模型（按顺序尝试，每次请求都从 1 开始）："));
			for (const [index, { model, reasoning }] of chain.entries()) {
				const effort = reasoning.disableReasoning ? "off" : (reasoning.reasoning ?? tr("model default", "模型默认值"));
				lines.push(`  ${index + 1}. ${modelLabel(model)} (${tr("reasoning", "推理")}: ${effort})`);
			}
		}
	}
	lines.push(
		tr(
			'diagnostics: debug records "thinking-translator: …" in ~/.omp/logs/omp.<date>.<pid>.log',
			'诊断：~/.omp/logs/omp.<日期>.<pid>.log 里 debug 级别的 "thinking-translator: …" 记录',
		),
	);
	ctx.ui.notify(lines.join("\n"), "info");
}
