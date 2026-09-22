/**
 * Empirical check: does pi.setModel() inside before_agent_start apply to the
 * same turn? Uses pi-ai's faux provider so no tokens are spent.
 *
 *   pi -p --no-extensions -e test/hook-order.ext.ts --provider faux --model a "hi"
 */
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const faux = fauxProvider({
		provider: "faux",
		models: [
			{ id: "a", name: "Faux A" },
			{ id: "b", name: "Faux B" },
		],
	});
	faux.setResponses([
		(_context, _options, _state, model) => fauxAssistantMessage(`answered by ${model.id}`, { stopReason: "stop" }),
		(_context, _options, _state, model) => fauxAssistantMessage(`answered by ${model.id}`, { stopReason: "stop" }),
	]);
	pi.registerProvider(faux.provider);

	pi.on("before_agent_start", async (_event, ctx) => {
		const before = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
		const b = ctx.modelRegistry.find("faux", "b");
		const ok = b ? await pi.setModel(b) : false;
		process.stderr.write(`[hook-order] before_agent_start: model was ${before}, setModel(b) -> ${ok}, now ${ctx.model?.provider}/${ctx.model?.id}\n`);
	});

	pi.on("message_end", async (event) => {
		const m = event.message as { role: string; provider?: string; model?: string };
		if (m.role === "assistant") process.stderr.write(`[hook-order] assistant message came from ${m.provider}/${m.model}\n`);
	});
}
