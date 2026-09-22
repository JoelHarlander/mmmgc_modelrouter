/**
 * The offline oracle and the token/cost simulator.
 *
 * The oracle is a *declared* competence model, not a measurement: a fleet model
 * solves a turn when its category-adjusted skill reaches the turn's requiredSkill.
 * Everything the harness reports about quality rests on that declaration, which is
 * why it lives in a fixture (eval/tasks/fleet.json) the reader can argue with.
 *
 * The token model comes from the cache-cost study's measured traffic profile:
 * ~5 provider calls per user turn, ~650 newly cached tokens per call, ~550 output
 * tokens per call, and a ~100% prefix hit rate while the model and thinking level
 * hold still. A model switch OR a thinking-level change discards the prefix — the
 * second half is the behaviour Anthropic documents and the study measured.
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { FleetModel } from "./types.ts";

export const CALLS_PER_TURN = 5;
export const CACHE_GROWTH_TOKENS_PER_CALL = 650;
export const OUTPUT_TOKENS_PER_CALL = 550;

/**
 * The three numbers every cost figure in this harness rests on. They are measurements
 * from one machine's logs, not constants of nature, and the cache-cost study says
 * break-even scales roughly with 1/callsPerTurn — so `--sweep profile` varies them
 * rather than leaving the conclusions resting on a single sample.
 */
export interface TrafficProfile {
	callsPerTurn: number;
	cacheGrowthTokensPerCall: number;
	outputTokensPerCall: number;
}

export const DEFAULT_TRAFFIC: TrafficProfile = {
	callsPerTurn: CALLS_PER_TURN,
	cacheGrowthTokensPerCall: CACHE_GROWTH_TOKENS_PER_CALL,
	outputTokensPerCall: OUTPUT_TOKENS_PER_CALL,
};

export function effectiveSkill(model: FleetModel, category: string): number {
	return model.skill + (model.skillByCategory?.[category] ?? 0);
}

export function solves(model: FleetModel, category: string, requiredSkill: number): boolean {
	return effectiveSkill(model, category) >= requiredSkill;
}

export interface TurnUsageArgs {
	model: FleetModel;
	contextTokens: number;
	cold: boolean;
	/** Per-task override of the profile's callsPerTurn. */
	calls?: number;
	outputTokensPerCall?: number;
	traffic?: TrafficProfile;
}

export interface TurnUsage {
	usage: Usage;
	/** What the ledger will see: plan and free routes report $0. */
	ledgerCostUsd: number;
	/** What the turn is worth at list price regardless of who pays. */
	listEquivalentUsd: number;
	coldWriteTokens: number;
}

export function simulateTurnUsage(args: TurnUsageArgs): TurnUsage {
	const { model, contextTokens, cold } = args;
	const traffic = args.traffic ?? DEFAULT_TRAFFIC;
	const calls = args.calls ?? traffic.callsPerTurn;
	const outPerCall = args.outputTokensPerCall ?? traffic.outputTokensPerCall;
	const growth = traffic.cacheGrowthTokensPerCall;

	let cacheRead = 0;
	let cacheWrite = 0;
	let prefix = contextTokens;
	for (let i = 0; i < calls; i++) {
		if (i === 0 && cold) {
			cacheWrite += prefix;
		} else {
			cacheRead += prefix;
			cacheWrite += growth;
		}
		prefix += growth;
	}
	const output = outPerCall * calls;
	const rates = model.cost;
	const cost = {
		input: 0,
		cacheRead: (cacheRead * rates.cacheRead) / 1_000_000,
		cacheWrite: (cacheWrite * rates.cacheWrite) / 1_000_000,
		output: (output * rates.output) / 1_000_000,
		total: 0,
	};
	const listEquivalentUsd = cost.cacheRead + cost.cacheWrite + cost.output;
	const billed = model.billing === "on-demand";
	cost.total = billed ? listEquivalentUsd : 0;
	if (!billed) {
		cost.cacheRead = 0;
		cost.cacheWrite = 0;
		cost.output = 0;
	}

	const usage: Usage = {
		input: 0,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: cacheRead + cacheWrite + output,
		cost,
	};
	return { usage, ledgerCostUsd: cost.total, listEquivalentUsd, coldWriteTokens: cold ? contextTokens : 0 };
}

/**
 * One fan-out candidate response.
 *
 * src/parallel.ts calls `complete` with `cacheRetention: "none"` and a fresh
 * `sessionId`, so a candidate neither reads nor writes the session's cache: it pays
 * the full uncached input rate once, and leaves the routed model's cache untouched.
 */
export function simulateFanoutUsage(model: FleetModel, contextTokens: number, outputTokens: number): TurnUsage {
	const rates = model.cost;
	const cost = {
		input: (contextTokens * rates.input) / 1_000_000,
		cacheRead: 0,
		cacheWrite: 0,
		output: (outputTokens * rates.output) / 1_000_000,
		total: 0,
	};
	const listEquivalentUsd = cost.input + cost.output;
	const billed = model.billing === "on-demand";
	cost.total = billed ? listEquivalentUsd : 0;
	if (!billed) {
		cost.input = 0;
		cost.output = 0;
	}
	const usage: Usage = {
		input: contextTokens,
		output: outputTokens,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: contextTokens + outputTokens,
		cost,
	};
	return { usage, ledgerCostUsd: cost.total, listEquivalentUsd, coldWriteTokens: contextTokens };
}

/** Deterministic [0,1) from a string, so a run with the same seed is byte-identical. */
export function hashUnit(...parts: (string | number)[]): number {
	let h = 0x811c9dc5;
	const s = parts.join("\u0000");
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h / 0x1_0000_0000;
}
