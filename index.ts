import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { tr } from "./omomp-shared/i18n.ts";
import { createSession, type TranslatorSession } from "./src/session.ts";
import { showStatus } from "./src/status.ts";

export default function thinkingTranslator(pi: ExtensionAPI): void {
	let session: TranslatorSession | undefined;
	const start = (ctx: ExtensionContext): void => {
		session?.dispose();
		session = ctx.mode === "tui" && ctx.agent.kind === "main" ? createSession(pi, ctx) : undefined;
	};

	pi.registerAssistantThinkingRenderer((context) => session?.render(context));
	pi.registerCommand("thinking-translator", {
		description: tr("Show thinking-translator settings and translator models", "查看 thinking-translator 设置与翻译模型"),
		handler: (_args, ctx) => showStatus(pi, ctx),
	});

	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("session_switch", (_event, ctx) => start(ctx));
	pi.on("session_shutdown", () => {
		session?.dispose();
		session = undefined;
	});
	pi.on("agent_start", (_event, ctx) => session?.agentStart(ctx));
	pi.on("message_start", (_event, ctx) => session?.messageStart(ctx));
	pi.on("message_update", (event, ctx) => session?.messageUpdate(event, ctx));
	pi.on("message_end", (event, ctx) => session?.messageEnd(event, ctx));
}
