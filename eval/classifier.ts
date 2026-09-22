/**
 * The tier classifier under test, in four interchangeable modes.
 *
 *   scripted  - the answer recorded in the fixture (default; deterministic, offline)
 *   heuristic - src/router.ts#heuristicTier, the real no-credential fallback
 *   oracle    - always the fixture's goldTier at confidence 1; the routing ceiling
 *   live      - a real Jev call through src/jev.ts (opt-in, costs money)
 *
 * Every mode is handed the same state object src/state.ts would build in pi, so
 * the classifier prompt is the real one.
 */
import type { Tier } from "../src/config.ts";
import { TIERS } from "../src/config.ts";
import type { JevChoiceAnswer, JevNoulAnswer, JevScoreAnswer } from "../src/jev.ts";
import type { JevLike } from "./candidates.ts";
import { heuristicTier } from "../src/router.ts";
import { type RoutingState, routingQuestions, STAKES_QUESTION_KEY, TIER_QUESTION_KEY, TOOLS_QUESTION_KEY } from "../src/state.ts";
import type { ClassifierMode, ScriptedJev, TaskTurn } from "./types.ts";

export interface Classification {
	tier: Tier;
	confidence: number;
	needsTools?: number;
	stakes?: number;
	costUsd: number;
	ms: number;
	/** "jev" when the classifier answered, "heuristic" when it failed and the fallback ran. */
	source: "jev" | "heuristic" | "oracle";
	error?: string;
}

export interface ClassifyArgs {
	mode: ClassifierMode;
	/** The harness fills in the derived goldTier before calling, so `oracle` has a tier. */
	turn: TaskTurn & { goldTier: Tier };
	prompt: string;
	state: RoutingState;
	jev?: JevLike;
	signal?: AbortSignal;
}

/** Cost of one scripted Jev call, from the TypeSafe list price at the observed ~450 input tokens. */
const SCRIPTED_JEV_COST_USD = 450 * (0.042 / 1_000_000);
const SCRIPTED_JEV_MS = 210;

export async function classify(args: ClassifyArgs): Promise<Classification> {
	const { mode, turn, prompt } = args;
	if (mode === "oracle") {
		return { tier: turn.goldTier, confidence: 1, needsTools: turn.jev?.needsTools, stakes: turn.jev?.stakes, costUsd: 0, ms: 0, source: "oracle" };
	}
	if (mode === "heuristic") {
		const h = heuristicTier(prompt);
		return { ...h, costUsd: 0, ms: 0, source: "heuristic" };
	}
	if (mode === "scripted") {
		const scripted: ScriptedJev | undefined = turn.jev;
		if (!scripted || scripted.fail) {
			const h = heuristicTier(prompt);
			return { ...h, costUsd: 0, ms: 0, source: "heuristic", error: scripted ? "scripted Jev outage" : "no scripted answer" };
		}
		return {
			tier: scripted.tier,
			confidence: scripted.confidence,
			needsTools: scripted.needsTools,
			stakes: scripted.stakes,
			costUsd: SCRIPTED_JEV_COST_USD,
			ms: SCRIPTED_JEV_MS,
			source: "jev",
		};
	}
	return classifyLive(args);
}

async function classifyLive(args: ClassifyArgs): Promise<Classification> {
	const { jev, state, prompt, signal } = args;
	if (!jev?.available()) throw new Error(`live classifier requested but no Jev credential: ${jev?.describe() ?? "no client"}`);
	try {
		const res = await jev.ask(state, routingQuestions(), signal);
		const tier = res.answers[TIER_QUESTION_KEY] as JevChoiceAnswer | undefined;
		if (!tier || !TIERS.includes(tier.choice as Tier)) throw new Error("no tier answer");
		return {
			tier: tier.choice as Tier,
			confidence: tier.confidence,
			needsTools: (res.answers[TOOLS_QUESTION_KEY] as JevNoulAnswer | undefined)?.noul,
			stakes: (res.answers[STAKES_QUESTION_KEY] as JevScoreAnswer | undefined)?.score,
			costUsd: res.costUsd,
			ms: res.ms,
			source: "jev",
		};
	} catch (err) {
		// Same fallback the shipped extension takes (src/index.ts).
		const h = heuristicTier(prompt);
		return { ...h, costUsd: 0, ms: 0, source: "heuristic", error: err instanceof Error ? err.message : String(err) };
	}
}

/** src/index.ts applies exactly this override after the Jev answer; the harness must too. */
export const STAKES_OVERRIDE_THRESHOLD = 1.5;

/**
 * Variants of the one place the router overrules the classifier.
 *
 * `shipped` is `src/index.ts` exactly: a `light` answer with stakes at or above 1.5
 * becomes `standard`. The others exist to measure what a router could do about round 36 -
 * the shipped tier criteria describe the *light* band as "answer a factual question,
 * explain a snippet", so Jev calls hard questions light while correctly following its
 * prompt. Stakes is the only signal left in the answer that still tracks difficulty.
 */
export interface StakesOverride {
	/** Stakes at or above this lift `light` one tier. */
	toStandard: number;
	/** Stakes at or above this lift `light` two tiers. Infinity disables it. */
	toHeavy: number;
}

export const STAKES_OVERRIDES: Record<string, StakesOverride> = {
	off: { toStandard: Number.POSITIVE_INFINITY, toHeavy: Number.POSITIVE_INFINITY },
	shipped: { toStandard: STAKES_OVERRIDE_THRESHOLD, toHeavy: Number.POSITIVE_INFINITY },
	lower: { toStandard: 1.2, toHeavy: Number.POSITIVE_INFINITY },
	"two-step": { toStandard: STAKES_OVERRIDE_THRESHOLD, toHeavy: 1.8 },
	"lower-two-step": { toStandard: 1.2, toHeavy: 1.8 },
};

export function applyStakesOverride(tier: Tier, stakes: number | undefined, override: StakesOverride = STAKES_OVERRIDES.shipped!): Tier {
	if (tier !== "light" || stakes === undefined) return tier;
	if (stakes >= override.toHeavy) return "heavy";
	if (stakes >= override.toStandard) return "standard";
	return tier;
}
