/**
 * Minimal client for a System One endpoint: the Jev wire protocol, one POST, no SDK.
 * https://docs.typesafe.ai/api
 *
 * Three servers speak it, tried in this order under `transport: "auto"`:
 *   laya      a local Laya server (`laya-serve`): free, ~33 ms, no network leaves the machine
 *   typesafe  TypeSafe's hosted Jev (`typesafe/jev-latest`)
 *   gateway   Jev through Vercel AI Gateway
 * A server that fails hands the call to the next one, so a stopped Laya never costs a turn.
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
	/** USD: zero for a local Laya, else gateway metadata or the TypeSafe list price ($0.042/Mtok input). */
	costUsd: number;
}

export type JevTransport = "laya" | "typesafe" | "gateway";
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

/**
 * The hosted transports. The fan-out judge reads several long answers, which is more than a local
 * Laya's context holds, so it asks these and never Laya.
 */
export const HOSTED_JEV: readonly JevTransport[] = ["typesafe", "gateway"];

/** How long a Laya that refused a connection is left alone before it is tried again. */
const LAYA_RETRY_MS = 30_000;

/** `<base>/v1/systemone` from a bare host, a `/v1` base, or a base with a trailing slash. */
export function systemOneUrl(baseUrl: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	return `${/\/v1$/.test(base) ? base : `${base}/v1`}/systemone`;
}

export class JevClient {
	/** Gateway key discovered from pi's own auth store (vercel-ai-gateway provider). */
	private storedGatewayKey: string | undefined;
	/** TypeSafe key discovered from pi's own auth store (typesafe provider). */
	private storedTypesafeKey: string | undefined;
	/** Laya failed to answer; skip it until then so a stopped server costs one refused connect, not one per turn. */
	private layaDownUntil = 0;

	constructor(private readonly cfg: RouterConfig["jev"]) {}

	/** Let the host hand over pi's stored Vercel AI Gateway credential. */
	setStoredGatewayKey(key: string | undefined): void {
		this.storedGatewayKey = key;
	}

	setStoredTypesafeKey(key: string | undefined): void {
		this.storedTypesafeKey = key;
	}

	typesafeKey(): string | undefined {
		return this.cfg.apiKey || process.env[this.cfg.apiKeyEnv] || this.storedTypesafeKey || undefined;
	}

	gatewayKey(): string | undefined {
		return this.cfg.gatewayApiKey || process.env[this.cfg.gatewayApiKeyEnv] || this.storedGatewayKey || undefined;
	}

	layaKey(): string {
		return this.cfg.layaApiKey || process.env[this.cfg.layaApiKeyEnv] || "local";
	}

	/** The transports a call would try right now, in order, optionally limited to `only`. */
	transports(now = Date.now(), only?: readonly JevTransport[]): JevTransport[] {
		return this.allTransports(now).filter((t) => !only || only.includes(t));
	}

	private allTransports(now: number): JevTransport[] {
		const t = this.cfg.transport;
		const laya = !!this.cfg.layaUrl && now >= this.layaDownUntil;
		const typesafe = !!this.typesafeKey();
		const gateway = !!this.gatewayKey();
		if (t === "laya") return this.cfg.layaUrl ? ["laya"] : [];
		if (t === "typesafe") return typesafe ? ["typesafe"] : [];
		if (t === "gateway") return gateway ? ["gateway"] : [];
		const out: JevTransport[] = [];
		if (laya) out.push("laya");
		if (typesafe) out.push("typesafe");
		if (gateway) out.push("gateway");
		return out;
	}

	/** Which transport a call would use first right now, or undefined when none fits. */
	transport(): JevTransport | undefined {
		return this.transports()[0];
	}

	available(only?: readonly JevTransport[]): boolean {
		return this.transports(Date.now(), only).length > 0;
	}

	describe(): string {
		const list = this.transports();
		if (list.length === 0) {
			return `unavailable (run laya-serve at ${this.cfg.layaUrl || "jev.layaUrl"}, or set ${this.cfg.apiKeyEnv}, ${this.cfg.gatewayApiKeyEnv}, or run: npx vercel ai-gateway setup --agent pi)`;
		}
		const names: Record<JevTransport, string> = {
			laya: `${this.cfg.layaModel} via ${this.cfg.layaUrl}`,
			typesafe: `${this.cfg.model} via api.typesafe.ai`,
			gateway: `${this.cfg.gatewayModel} via Vercel AI Gateway`,
		};
		return list.map((x) => names[x]).join(", then ");
	}

	async ask(state: JsonValue, questions: Record<string, JevQuestion>, signal?: AbortSignal, only?: readonly JevTransport[]): Promise<JevResult> {
		const list = this.transports(Date.now(), only);
		if (list.length === 0) throw new JevError(`No Jev credential: ${this.describe()}`);
		const failures: string[] = [];
		for (const transport of list) {
			try {
				return await this.askOne(transport, state, questions, signal);
			} catch (err) {
				if (signal?.aborted) throw err;
				if (transport === "laya") this.layaDownUntil = Date.now() + LAYA_RETRY_MS;
				const message = err instanceof Error ? err.message : String(err);
				failures.push(transport === "laya" ? `Laya: ${message}` : message);
				if (this.cfg.transport !== "auto") throw err;
			}
		}
		throw new JevError(failures.join("; then "));
	}

	private async askOne(transport: JevTransport, state: JsonValue, questions: Record<string, JevQuestion>, signal?: AbortSignal): Promise<JevResult> {
		const key = transport === "laya" ? this.layaKey() : transport === "typesafe" ? this.typesafeKey()! : this.gatewayKey()!;
		const baseUrl = transport === "laya" ? this.cfg.layaUrl : transport === "typesafe" ? this.cfg.baseUrl : this.cfg.gatewayBaseUrl;
		const model = transport === "laya" ? this.cfg.layaModel : transport === "typesafe" ? this.cfg.model : this.cfg.gatewayModel;
		const timeoutMs = transport === "laya" ? this.cfg.layaTimeoutMs : this.cfg.timeoutMs;
		const started = Date.now();
		const body = JSON.stringify({ state, model, questions });
		const doFetch = () =>
			fetch(systemOneUrl(baseUrl), {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body,
				signal: combineSignals(signal, AbortSignal.timeout(timeoutMs)),
			});

		let res = await doFetch();
		if (res.status === 429) {
			const retryAfter = Number(res.headers.get("retry-after") ?? "0");
			if (retryAfter > 0 && retryAfter * 1000 < timeoutMs) {
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
			const who = transport === "gateway" ? "AI Gateway" : transport === "laya" ? "Laya" : "TypeSafe";
			throw new JevError(`${who} ${res.status} ${detail}`, res.status);
		}
		const json = (await res.json()) as Omit<JevResult, "ms" | "transport" | "costUsd">;
		const gatewayCost = Number(json.provider_metadata?.gateway?.cost);
		const costUsd =
			transport === "laya"
				? 0
				: Number.isFinite(gatewayCost)
					? gatewayCost
					: (json.usage?.input_tokens ?? 0) * TYPESAFE_INPUT_USD_PER_TOKEN;
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
