/**
 * Build the compact `state` object Jev classifies. Kept small on purpose:
 * the request, a few recent turns, and session facts the router cares about.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RouterConfig, Tier } from "./config.ts";
import type { JevQuestion, JsonValue } from "./jev.ts";

export interface RoutingState extends Record<string, JsonValue> {
	request: string;
	recent: { role: string; text: string }[];
	session: {
		turn: number;
		context_tokens: number;
		current_model: string;
		recent_tools: string[];
	};
}

export function buildRoutingState(prompt: string, ctx: ExtensionContext, cfg: RouterConfig, turn: number): RoutingState {
	const recent: { role: string; text: string }[] = [];
	const recentTools = new Set<string>();
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0 && recent.length < cfg.jev.recentMessages; i--) {
		const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role ?? "unknown";
		if (role !== "user" && role !== "assistant") continue;
		const text = contentToText(entry.message.content, recentTools);
		if (!text.trim()) continue;
		recent.unshift({ role, text: truncate(text, cfg.jev.maxCharsPerMessage) });
	}

	const state: RoutingState = {
		request: truncate(prompt, cfg.jev.maxStateChars / 2),
		recent,
		session: {
			turn,
			context_tokens: ctx.getContextUsage()?.tokens ?? 0,
			current_model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none",
			recent_tools: [...recentTools].slice(0, 12),
		},
	};

	// Trim recent turns until the serialized state fits the budget.
	while (JSON.stringify(state).length > cfg.jev.maxStateChars && state.recent.length > 0) {
		state.recent.shift();
	}
	return state;
}

export function contentToText(content: unknown, tools?: Set<string>): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as { type?: string; text?: string; name?: string }[]) {
		if (block.type === "text" && block.text) parts.push(block.text);
		else if (block.type === "toolCall" && block.name) {
			tools?.add(block.name);
			parts.push(`[tool: ${block.name}]`);
		}
	}
	return parts.join("\n");
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.7);
	const tail = max - head - 5;
	return `${text.slice(0, head)} ... ${text.slice(text.length - tail)}`;
}

export const TIER_QUESTION_KEY = "tier";
export const TOOLS_QUESTION_KEY = "needs_tools";
export const STAKES_QUESTION_KEY = "stakes";

/** The routing questions. Criteria text is the only "prompting" Jev gets, so keep it concrete. */
export function routingQuestions(): Record<string, JevQuestion> {
	const tierCriteria: Record<Tier, string> = {
		light:
			"A small, well-specified step: answer a factual question, explain a snippet, rename or move something, write a one-line command, read or list files, simple lookups, greetings or acknowledgements. A fast, cheap model will do this correctly.",
		standard:
			"Ordinary coding work: implement a described function or feature in one or two files, fix a bug with a clear reproduction, write tests for known behavior, follow an existing pattern, moderate refactor. Needs a competent mid-size model.",
		heavy:
			"Hard or high-stakes work: design or architecture decisions, multi-file or cross-cutting refactors, debugging with unclear cause, security or concurrency reasoning, reviewing large diffs, ambiguous requirements that need judgment, or anything where a wrong answer is expensive. Needs the strongest available model.",
	};
	return {
		[TIER_QUESTION_KEY]: {
			type: "choice",
			instructions: {
				question:
					"Given `request` (the user's new message to a terminal coding agent), `recent` (the conversation so far) and `session`, which model tier should handle this turn?",
				note: "Judge the difficulty of the requested work, not the length of the message.",
			},
			criteria: tierCriteria,
		},
		[TOOLS_QUESTION_KEY]: {
			type: "noul",
			instructions: "Will fulfilling `request` require the agent to edit files or run commands, rather than only answering in text?",
		},
		[STAKES_QUESTION_KEY]: {
			type: "score",
			instructions: "How costly would a wrong or sloppy answer to `request` be for the user?",
			criteria: [
				"Harmless: easily noticed and redone, or purely informational",
				"Moderate: would waste some time or need a follow-up fix",
				"Severe: could break the build, lose data, or mislead an important decision",
			],
		},
	};
}
