/**
 * Minimal client for TypeSafe AI's System One endpoint (Jev).
 * One POST, no SDK. https://docs.typesafe.ai/api
 */
import type { RouterConfig } from "./config.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JevQuestion =
	| { type: "choice"; instructions: JsonValue; criteria: Record<string, JsonValue | null> }
	| { type: "score"; instructions: JsonValue; criteria: JsonValue[] }
	| { type: "noul"; instructions: JsonValue; criteria?: { true?: JsonValue; false?: JsonValue } };

export interface JevChoiceAnswer {
	type: "choice";
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}
export interface JevScoreAnswer {
	type: "score";
	score: number;
	confidence: number;
	legend: Record<string, string>;
	probabilities: Record<string, number>;
}
export interface JevNoulAnswer {
	type: "noul";
	noul: number;
}
export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

export interface JevResult {
	model: string;
	answers: Record<string, JevAnswer>;
	usage: { input_tokens: number; output_tokens: number };
	/** Present when routed through Vercel AI Gateway. */
	provider_metadata?: { gateway?: { cost?: string | number; generationId?: string } };
	ms: number;
	transport: JevTransport;
	/** USD, from gateway metadata or the TypeSafe list price ($0.042/Mtok input). */
	costUsd: number;
}

export type JevTransport = "typesafe" | "gateway";
const TYPESAFE_INPUT_USD_PER_TOKEN = 0.042 / 1_000_000;

export class JevError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "JevError";
	}
}

export class JevClient {
	/** Gateway key discovered from pi's own auth store (vercel-ai-gateway provider). */
	private storedGatewayKey: string | undefined;

	constructor(private readonly cfg: RouterConfig["jev"]) {}

	/** Let the host hand over pi's stored Vercel AI Gateway credential. */
	setStoredGatewayKey(key: string | undefined): void {
		this.storedGatewayKey = key;
	}

	typesafeKey(): string | undefined {
		return this.cfg.apiKey || process.env[this.cfg.apiKeyEnv] || undefined;
	}

	gatewayKey(): string | undefined {
		return this.cfg.gatewayApiKey || process.env[this.cfg.gatewayApiKeyEnv] || this.storedGatewayKey || undefined;
	}

	/** Which transport a call would use right now, or undefined when no credential fits. */
	transport(): JevTransport | undefined {
		const t = this.cfg.transport;
		if (t === "typesafe") return this.typesafeKey() ? "typesafe" : undefined;
		if (t === "gateway") return this.gatewayKey() ? "gateway" : undefined;
		if (this.typesafeKey()) return "typesafe";
		if (this.gatewayKey()) return "gateway";
		return undefined;
	}

	available(): boolean {
		return this.transport() !== undefined;
	}

	describe(): string {
		const t = this.transport();
		if (t === "typesafe") return `${this.cfg.model} via api.typesafe.ai`;
		if (t === "gateway") return `${this.cfg.gatewayModel} via Vercel AI Gateway`;
		return `unavailable (set ${this.cfg.apiKeyEnv}, ${this.cfg.gatewayApiKeyEnv}, or run: npx vercel ai-gateway setup --agent pi)`;
	}

	async ask(state: JsonValue, questions: Record<string, JevQuestion>, signal?: AbortSignal): Promise<JevResult> {
		const transport = this.transport();
		if (!transport) throw new JevError(`No Jev credential: ${this.describe()}`);
		const key = transport === "typesafe" ? this.typesafeKey()! : this.gatewayKey()!;
		const baseUrl = transport === "typesafe" ? this.cfg.baseUrl : this.cfg.gatewayBaseUrl;
		const model = transport === "typesafe" ? this.cfg.model : this.cfg.gatewayModel;
		const started = Date.now();
		const body = JSON.stringify({ state, model, questions });
		const doFetch = () =>
			fetch(`${baseUrl.replace(/\/$/, "")}/systemone`, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body,
				signal: combineSignals(signal, AbortSignal.timeout(this.cfg.timeoutMs)),
			});

		let res = await doFetch();
		if (res.status === 429) {
			const retryAfter = Number(res.headers.get("retry-after") ?? "0");
			if (retryAfter > 0 && retryAfter * 1000 < this.cfg.timeoutMs) {
				await new Promise((r) => setTimeout(r, retryAfter * 1000));
				res = await doFetch();
			}
		}
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			let detail = text.slice(0, 300);
			try {
				const parsed = JSON.parse(text) as { error?: { message?: string; type?: string } };
				if (parsed.error?.message) detail = `${parsed.error.type ?? "error"}: ${parsed.error.message}`;
			} catch {
				// not JSON
			}
			throw new JevError(`${transport === "gateway" ? "AI Gateway" : "TypeSafe"} ${res.status} ${detail}`, res.status);
		}
		const json = (await res.json()) as Omit<JevResult, "ms" | "transport" | "costUsd">;
		const gatewayCost = Number(json.provider_metadata?.gateway?.cost);
		const costUsd = Number.isFinite(gatewayCost) ? gatewayCost : (json.usage?.input_tokens ?? 0) * TYPESAFE_INPUT_USD_PER_TOKEN;
		return { ...json, ms: Date.now() - started, transport, costUsd };
	}
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
	if (!a) return b;
	const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
	if (anyFn) return anyFn([a, b]);
	const ctrl = new AbortController();
	for (const s of [a, b]) {
		if (s.aborted) ctrl.abort(s.reason);
		else s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
	}
	return ctrl.signal;
}

/** Choice/score confidence as defined in https://docs.typesafe.ai/confidence */
export function choiceConfidence(probabilities: Record<string, number>): number {
	const values = Object.values(probabilities);
	const n = values.length;
	if (n < 2) return 1;
	const peak = Math.max(...values);
	return Math.max(0, Math.min(1, (n * peak - 1) / (n - 1)));
}
