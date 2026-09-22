/**
 * Shared shapes for the router eval harness.
 *
 * Nothing here is imported by `src/`; the harness only ever reads the router.
 */
import type { Tier } from "../src/config.ts";

/** A synthetic model in the offline fleet. Prices are real published list prices (see eval/README.md). */
export interface FleetModel {
	key: string;
	name: string;
	tier: Tier;
	billing: "plan" | "on-demand" | "free";
	/** True for subscription/OAuth routes, which the ledger sees as $0. */
	oauth: boolean;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** 0..100 declared competence. The offline oracle's ground truth. */
	skill: number;
	/** Per-category adjustments, so the fleet is not totally ordered. */
	skillByCategory?: Record<string, number>;
	/** Capability hint handed to the router for tie-breaking (config `models[key].capability`). */
	capability?: number;
	contextWindow?: number;
}

export interface Fleet {
	version: 1;
	note?: string;
	/** Prose description of what each band of `skill` / `requiredSkill` means. */
	skillLadder?: Record<string, string>;
	models: FleetModel[];
	tiers: Record<Tier, string[]>;
}

/** A scripted classifier answer: what Jev is expected to say for this turn. */
export interface ScriptedJev {
	tier: Tier;
	confidence: number;
	needsTools?: number;
	stakes?: number;
	/** Set when the fixture models a Jev outage for this turn. */
	fail?: boolean;
}

export interface TaskTurn {
	prompt: string;
	/**
	 * The tier this turn needs. **Derived**, not authoritative: the harness computes it
	 * as the cheapest tier holding a model that reaches `requiredSkill`, because which
	 * tier can do a piece of work is a fact about the fleet, not about the task. It is
	 * written in the fixture for readability and `--validate` fails if the two disagree.
	 */
	goldTier?: Tier;
	/** How hard this turn is, on the skill ladder documented in eval/tasks/fleet.json. */
	requiredSkill?: number;
	jev?: ScriptedJev;
	/** Simulate a provider response the ledger should learn from before the next turn. */
	providerEvent?: { provider: string; status: number; headers: Record<string, string> };
	/** Simulate the operator pinning a model with /model before this turn. */
	manualPin?: string;
	expectedOutputTokens?: number;
}

export interface EvalTask {
	id: string;
	repo: string;
	category: string;
	/** Default skill needed by this task's turns. */
	requiredSkill: number;
	startContextTokens: number;
	contextGrowthPerTurn: number;
	/** Provider calls the agent makes per user turn (see docs: median ~5). */
	callsPerTurn?: number;
	turns: TaskTurn[];
	note?: string;
}

export interface TaskPack {
	version: 1;
	id: string;
	description: string;
	tasks: EvalTask[];
}

export type ClassifierMode = "scripted" | "heuristic" | "oracle" | "live";

export interface TurnRecord {
	taskId: string;
	turn: number;
	goldTier: Tier;
	requestedTier: Tier;
	chosenTier: Tier;
	confidence: number;
	/** "heuristic" means the classifier failed and src/router.ts#heuristicTier routed instead. */
	classifierSource: "jev" | "heuristic" | "oracle" | "pinned";
	model: string;
	previousModel?: string;
	switched: boolean;
	pinned: boolean;
	reason: string;
	/** Did the router pick a model that was authed, unblocked and inside the fleet? */
	eligible: boolean;
	ineligibleReason?: string;
	contextTokens: number;
	thinkingLevel?: string;
	/** Cold = the prompt cache was discarded before this turn. */
	cold: boolean;
	coldCause?: "first-turn" | "model-switch" | "thinking-change";
	coldWriteTokens: number;
	ledgerCostUsd: number;
	listEquivalentUsd: number;
	/** What the same turn would have cost on the same model with a warm cache. */
	warmListEquivalentUsd: number;
	classifierCostUsd: number;
	solved: boolean;
	effectiveSkill: number;
	/** A different model in the tier the router chose would have solved this turn. */
	inTierAlternativeWouldSolve: boolean;
	candidate?: CandidateTurnRecord;
}

export interface CandidateOutcome {
	key: string;
	label: string;
	effectiveSkill: number;
	solved: boolean;
	judgeScore: number;
	judgeProbability: number;
	cold: boolean;
	ledgerCostUsd: number;
	listEquivalentUsd: number;
}

export interface CandidateTurnRecord {
	candidates: CandidateOutcome[];
	judgePick: string;
	judgeConfidence: number;
	judgeSolved: boolean;
	/** The best candidate by true skill: the ceiling a perfect judge would reach. */
	oracleBest: string;
	oracleSolved: boolean;
	baselineSolved: boolean;
	judgeCostUsd: number;
	fanoutLedgerCostUsd: number;
	fanoutListEquivalentUsd: number;
}
