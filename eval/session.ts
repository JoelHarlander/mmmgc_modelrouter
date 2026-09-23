/**
 * A fake ExtensionContext just rich enough for src/state.ts#buildRoutingState.
 *
 * The harness drives the real state builder on every turn, in every mode, so the
 * prompt Jev would receive is measured (and in live mode actually sent) rather
 * than approximated.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface FakeEntry {
	type: "message";
	message: { role: string; content: { type: string; text?: string; name?: string }[] };
}

/** Accumulates the conversation the router sees, turn by turn. */
export class FakeSession {
	private entries: FakeEntry[] = [];
	contextTokens = 0;
	model: Model<Api> | undefined;

	addUser(text: string): void {
		this.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
	}

	addAssistant(text: string, tools: string[] = []): void {
		const content: FakeEntry["message"]["content"] = [{ type: "text", text }];
		for (const name of tools) content.push({ type: "toolCall", name });
		this.entries.push({ type: "message", message: { role: "assistant", content } });
	}

	getBranch(): FakeEntry[] {
		return this.entries;
	}

	/** The subset of ExtensionContext that buildRoutingState reads. */
	asContext(): ExtensionContext {
		const self = this;
		return {
			cwd: process.cwd(),
			hasUI: false,
			get model() {
				return self.model;
			},
			sessionManager: { getBranch: () => self.entries },
			getContextUsage: () => ({ tokens: self.contextTokens }),
		} as unknown as ExtensionContext;
	}
}
