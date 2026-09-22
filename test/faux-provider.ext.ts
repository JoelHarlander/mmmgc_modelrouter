/**
 * Registers a zero-cost faux provider with two models so the router can be
 * exercised end-to-end without spending tokens:
 *
 *   pi -p --no-extensions -e test/faux-provider.ext.ts -e src/index.ts --provider faux --model a "ls"
 */
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const faux = fauxProvider({
		provider: "faux",
		models: [
			{ id: "a", name: "Faux A (heavy)", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
			{ id: "b", name: "Faux B (light)", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		],
	});
	const reply = (_c: unknown, _o: unknown, _s: unknown, model: { id: string }) => fauxAssistantMessage(`answered by ${model.id}`, { stopReason: "stop" });
	faux.setResponses([reply, reply, reply, reply]);
	pi.registerProvider(faux.provider);
	pi.on("message_end", async (event) => {
		const m = event.message as { role: string; provider?: string; model?: string };
		if (m.role === "assistant") process.stderr.write(`[faux] assistant message came from ${m.provider}/${m.model}\n`);
	});
}
