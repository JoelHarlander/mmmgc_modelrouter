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
import { DEFAULT_COMPACTION_SETTINGS, shouldCompact } from "@earendil-works/pi-coding-agent";
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

/**
 * Skill points a turn effectively gains when the conversation it depended on has been
 * summarised away. Declared, like the rest of the oracle, and swept by
 * `--compaction-penalty` so no conclusion has to rest on the exact value.
 *
 * Round 16 modelled a compaction's money and its cache effect and said plainly that its
 * *quality* cost was missing, making those figures a lower bound. This is that cost: a
 * turn that needs detail the summary dropped is harder than the same turn with the
 * detail still present.
 */
export const COMPACTION_SKILL_PENALTY = 12;

/**
 * How much of the discarded context has not yet been rebuilt, 0..1. Immediately after a
 * compaction this is 1; it falls to 0 as the session re-accumulates what it lost.
 */
export function lostContextFraction(contextTokens: number, compactedFrom: number, compactedTo: number): number {
	if (compactedFrom <= compactedTo) return 0;
	const rebuilt = (contextTokens - compactedTo) / (compactedFrom - compactedTo);
	return Math.max(0, Math.min(1, 1 - rebuilt));
}

/**
 * The skill a turn really demands, given what the session can still remember.
 * `contextSensitivity` is per task: 0 for self-contained work, 1 for work that leans
 * entirely on what came before.
 */
export function requiredSkillAfterCompaction(
	requiredSkill: number,
	contextSensitivity: number,
	lostFraction: number,
	penalty = COMPACTION_SKILL_PENALTY,
): number {
	return requiredSkill + penalty * contextSensitivity * lostFraction;
}

/** Fallbacks for a fleet entry with no published figures: mid-range, and flagged by test. */
export const DEFAULT_TTFT_MS = 800;
export const DEFAULT_THROUGHPUT_TPS = 150;

/** One provider call: time to first token, then output streamed at the published rate. */
export function callLatencyMs(model: FleetModel, outputTokens: number): number {
	const ttft = model.ttftMs ?? DEFAULT_TTFT_MS;
	const tps = model.throughputTps ?? DEFAULT_THROUGHPUT_TPS;
	return ttft + (outputTokens / tps) * 1000;
}

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
	/** Modelled wall-clock, from the fleet's published TTFT and throughput. */
	wallClockMs: number;
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
	return {
		usage,
		ledgerCostUsd: cost.total,
		listEquivalentUsd,
		coldWriteTokens: cold ? contextTokens : 0,
		wallClockMs: Math.round(calls * callLatencyMs(model, outPerCall)),
	};
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
	return {
		usage,
		ledgerCostUsd: cost.total,
		listEquivalentUsd,
		coldWriteTokens: contextTokens,
		wallClockMs: Math.round(callLatencyMs(model, outputTokens)),
	};
}

/**
 * Tokens the compaction summary itself occupies, and the output it costs to produce.
 * pi's own thresholds are used unmodified: `shouldCompact` and
 * `DEFAULT_COMPACTION_SETTINGS` are imported from pi-coding-agent, so the trigger point
 * is the product's, not the harness's.
 */
export const COMPACTION_SUMMARY_TOKENS = 2000;

export interface CompactionEvent {
	tokensBefore: number;
	tokensAfter: number;
	/** The summarisation call: it re-reads the whole context uncached and writes a summary. */
	listEquivalentUsd: number;
	ledgerCostUsd: number;
}

/**
 * Would pi compact before this turn, given the model the router chose?
 *
 * This is a routing consequence nobody had measured: the trigger is
 * `contextTokens > contextWindow - reserveTokens`, so **the same conversation compacts
 * or does not depending on which model the router picked**. Routing a 200k conversation
 * to a 200k-window model forces a compaction that a 400k-window model would not need,
 * and a compaction rewrites the prefix - so it is also a guaranteed cache flush.
 */
export function planCompaction(model: FleetModel, contextTokens: number): CompactionEvent | undefined {
	const window = model.contextWindow ?? 200_000;
	if (!shouldCompact(contextTokens, window, DEFAULT_COMPACTION_SETTINGS)) return undefined;
	const listEquivalentUsd =
		(contextTokens * model.cost.input) / 1_000_000 + (COMPACTION_SUMMARY_TOKENS * model.cost.output) / 1_000_000;
	return {
		tokensBefore: contextTokens,
		tokensAfter: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens + COMPACTION_SUMMARY_TOKENS,
		listEquivalentUsd,
		ledgerCostUsd: model.billing === "on-demand" ? listEquivalentUsd : 0,
	};
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
