/**
 * A small, stable metric set. Stable is the point: a run is only useful if the
 * next run can be called better or worse rather than described.
 *
 * Quality and spend sit side by side because the router trades one for the other.
 * `listEquivalentUsd` is the honest cost number — plan routes bill the ledger $0
 * but still consume a subscription, so `planHiddenUsd` names the gap.
 */
import { TIERS } from "../src/config.ts";
import type { TurnRecord } from "./types.ts";

/**
 * List-price-equivalent value of one weekly Claude-plan point, measured on this
 * machine by the cache-cost study (§5d). It rests on two integer-percent readings, so
 * the honest range is $33.9–$47.5 and the number is an order-of-magnitude anchor, not
 * a price. It is here because "$11 of hidden spend" means nothing and "0.28 of a
 * weekly point" means something.
 */
export const PLAN_POINT_USD = 39.57;

export interface RunMetrics {
	tasks: number;
	turns: number;
	routedTurns: number;
	pinnedTurns: number;

	/** Quality */
	/** Tasks where *every* turn was solved. Saturates at 0 on long sessions; read the two below there. */
	taskResolveRate: number;
	medianTaskTurnSuccess: number;
	worstTaskTurnSuccess: number;
	/** The routed model's own outcome. Measures the router, ignoring any fan-out. */
	turnSuccessRate: number;
	/**
	 * What the session actually ends up with: the adopted candidate where fan-out ran,
	 * the routed model otherwise. Equal to turnSuccessRate when candidate mode is off.
	 * This is the whole-system number.
	 */
	sessionSuccessRate: number;
	/** Did the router land in the right tier? The headline: this decides the outcome. */
	tierAccuracy: number;
	/** Did the classifier ask for the right tier? Measures the classifier, not the router. */
	classifierAccuracy: number;
	underRouteRate: number;
	overRouteRate: number;
	underRouteFailures: number;
	/**
	 * Turns that failed even though the router picked the right tier, and a different
	 * model inside that tier would have solved them. This is the switcher's own miss:
	 * the tier was right and the pick inside it was wrong.
	 */
	inTierMisses: number;

	/** Correctness of the mechanism itself. Any non-zero ineligibleChoices is a bug. */
	ineligibleChoices: number;
	heuristicFallbacks: number;
	tierEscalations: number;

	/** Spend */
	ledgerCostUsd: number;
	listEquivalentUsd: number;
	planHiddenUsd: number;
	/** planHiddenUsd expressed in the unit that actually runs out. See PLAN_POINT_USD. */
	planPointsUsed: number;
	classifierCostUsd: number;
	listUsdPerResolvedTask: number;

	/** Cache consequence */
	switches: number;
	switchesPerTurn: number;
	coldTurns: number;
	coldWriteTokens: number;
	coldByCause: Record<string, number>;
	coldPremiumUsd: number;
	/**
	 * Share of *routed-turn* spend that bought nothing but a re-read of context the model
	 * already had. Fan-out is excluded from the denominator: a candidate is always cold by
	 * construction, so including it would dilute the number the router can actually move.
	 */
	coldPremiumShare: number;
	/** Turns where pi would have compacted before the agent ran. */
	compactions: number;
	/** Of those, the ones the fleet's roomiest model would not have needed: a routing cost. */
	avoidableCompactions: number;
	compactionCostUsd: number;
	/** Turns that failed only because a compaction had discarded what they needed. */
	turnsLostToCompaction: number;

	modelShare: Record<string, number>;
	avgStateChars: number;

	candidate?: CandidateMetrics;
}

export interface CandidateMetrics {
	turns: number;
	baselineSuccessRate: number;
	/** The judge's raw pick, adopted unconditionally. */
	judgeSuccessRate: number;
	/** What a session actually ends up with: the pick, gated on judge confidence. */
	adoptedSuccessRate: number;
	/** adopted - baseline. The lift the shipped auto-adopt path would really deliver. */
	adoptedLift: number;
	/** Turns where the judge was not confident enough and the routed answer was kept. */
	gatedTurns: number;
	/** Of gated turns, the share where gating saved a turn the judge would have lost. */
	gateRescueRate: number;
	oracleSuccessRate: number;
	/** judge - baseline. The number the captain's question is really about. */
	judgeLift: number;
	/** How much of the available headroom the judge captured: (judge-base)/(oracle-base). */
	judgeHeadroomCaptured: number;
	/** Of turns where some candidate solved, the share where the judge picked a solver. */
	judgeRecall: number;
	/** Turns the baseline solved and the judge's pick did not. */
	judgeRegressions: number;
	fanoutLedgerCostUsd: number;
	fanoutListEquivalentUsd: number;
	judgeCostUsd: number;
	/** Extra list-price spend per extra task turn solved. Infinity when the lift is zero. */
	listUsdPerExtraSolve: number;
	avgCandidates: number;
}

export function computeMetrics(turns: TurnRecord[], stateChars: number[]): RunMetrics {
	const taskIds = new Set(turns.map((t) => t.taskId));
	const byTask = new Map<string, TurnRecord[]>();
	for (const t of turns) {
		const list = byTask.get(t.taskId) ?? [];
		list.push(t);
		byTask.set(t.taskId, list);
	}
	const resolved = [...byTask.values()].filter((list) => list.every((t) => t.solved)).length;
	const perTaskSuccess = [...byTask.values()].map((list) => list.filter((t) => t.solved).length / list.length);
	const routed = turns.filter((t) => !t.pinned);

	const tierIndex = (tier: string) => TIERS.indexOf(tier as (typeof TIERS)[number]);
	let exact = 0;
	let under = 0;
	let over = 0;
	let underFail = 0;
	let classifierExact = 0;
	for (const t of turns) {
		if (t.requestedTier === t.goldTier) classifierExact += 1;
		const delta = tierIndex(t.effectiveTier) - tierIndex(t.goldTier);
		if (delta === 0) exact += 1;
		else if (delta < 0) {
			under += 1;
			if (!t.solved) underFail += 1;
		} else over += 1;
	}

	// The router's own classifier and judge calls are real spend and belong in the totals,
	// as they do in src/ledger.ts. They are also broken out, because they are tiny and the
	// interesting question is whether they ever stop being so.
	const classifierCostUsd = sum(turns, (t) => t.classifierCostUsd) + sum(turns, (t) => t.candidate?.judgeCostUsd ?? 0);
	const ledgerCostUsd =
		sum(turns, (t) => t.ledgerCostUsd) +
		sum(turns, (t) => t.candidate?.fanoutLedgerCostUsd ?? 0) +
		sum(turns, (t) => t.compaction?.ledgerCostUsd ?? 0) +
		classifierCostUsd;
	const listEquivalentUsd =
		sum(turns, (t) => t.listEquivalentUsd) +
		sum(turns, (t) => t.candidate?.fanoutListEquivalentUsd ?? 0) +
		sum(turns, (t) => t.compaction?.listEquivalentUsd ?? 0) +
		classifierCostUsd;
	const ledgerRounded = round(ledgerCostUsd);
	const listRounded = round(listEquivalentUsd);

	const coldByCause: Record<string, number> = {};
	for (const t of turns) if (t.coldCause) coldByCause[t.coldCause] = (coldByCause[t.coldCause] ?? 0) + 1;

	const modelShare: Record<string, number> = {};
	for (const t of turns) modelShare[t.model] = (modelShare[t.model] ?? 0) + 1;

	const metrics: RunMetrics = {
		tasks: taskIds.size,
		turns: turns.length,
		routedTurns: routed.length,
		pinnedTurns: turns.length - routed.length,

		taskResolveRate: ratio(resolved, taskIds.size),
		medianTaskTurnSuccess: median(perTaskSuccess),
		worstTaskTurnSuccess: perTaskSuccess.length === 0 ? 0 : round(Math.min(...perTaskSuccess), 4),
		turnSuccessRate: ratio(turns.filter((t) => t.solved).length, turns.length),
		sessionSuccessRate: ratio(turns.filter((t) => t.candidate?.adoptedSolved ?? t.solved).length, turns.length),
		tierAccuracy: ratio(exact, turns.length),
		classifierAccuracy: ratio(classifierExact, turns.length),
		underRouteRate: ratio(under, turns.length),
		overRouteRate: ratio(over, turns.length),
		underRouteFailures: underFail,

		inTierMisses: turns.filter((t) => t.inTierAlternativeWouldSolve).length,

		ineligibleChoices: turns.filter((t) => !t.eligible).length,
		heuristicFallbacks: turns.filter((t) => t.classifierSource === "heuristic").length,
		tierEscalations: turns.filter((t) => t.chosenTier !== t.requestedTier).length,

		ledgerCostUsd: ledgerRounded,
		listEquivalentUsd: listRounded,
		// Derived from the rounded pair, so planHiddenUsd is exactly the gap a reader sees
		// between the two columns rather than a third independently-rounded number.
		planHiddenUsd: round(listRounded - ledgerRounded),
		planPointsUsed: round((listRounded - ledgerRounded) / PLAN_POINT_USD, 3),
		classifierCostUsd: round(classifierCostUsd, 8),
		listUsdPerResolvedTask: resolved === 0 ? Number.POSITIVE_INFINITY : round(listEquivalentUsd / resolved),

		switches: turns.filter((t) => t.switched).length,
		switchesPerTurn: ratio(turns.filter((t) => t.switched).length, turns.length),
		coldTurns: turns.filter((t) => t.cold).length,
		coldWriteTokens: sum(turns, (t) => t.coldWriteTokens),
		coldByCause,
		coldPremiumUsd: round(coldPremium(turns)),
		coldPremiumShare: ratio(coldPremium(turns), sum(turns, (t) => t.listEquivalentUsd)),
		compactions: turns.filter((t) => t.compaction).length,
		avoidableCompactions: turns.filter((t) => t.compaction?.avoidable).length,
		compactionCostUsd: round(sum(turns, (t) => t.compaction?.listEquivalentUsd ?? 0)),
		turnsLostToCompaction: turns.filter((t) => !t.solved && t.compactionPenalty > 0 && t.effectiveSkill >= t.requiredSkill - t.compactionPenalty)
			.length,

		modelShare,
		avgStateChars: Math.round(stateChars.reduce((a, b) => a + b, 0) / Math.max(1, stateChars.length)),
	};

	const candidateTurns = turns.filter((t) => t.candidate);
	if (candidateTurns.length > 0) metrics.candidate = candidateMetrics(candidateTurns);
	return metrics;
}

function candidateMetrics(turns: TurnRecord[]): CandidateMetrics {
	const n = turns.length;
	const base = turns.filter((t) => t.candidate!.baselineSolved).length;
	const judged = turns.filter((t) => t.candidate!.judgeSolved).length;
	const oracle = turns.filter((t) => t.candidate!.oracleSolved).length;
	const adopted = turns.filter((t) => t.candidate!.adoptedSolved).length;
	const gated = turns.filter((t) => t.candidate!.gated);
	const rescued = gated.filter((t) => t.candidate!.adoptedSolved && !t.candidate!.judgeSolved).length;
	const solvable = turns.filter((t) => t.candidate!.candidates.some((c) => c.solved));
	const recallHits = solvable.filter((t) => t.candidate!.judgeSolved).length;
	const regressions = turns.filter((t) => t.candidate!.baselineSolved && !t.candidate!.judgeSolved).length;

	const fanoutList = sum(turns, (t) => t.candidate!.fanoutListEquivalentUsd);
	const lift = ratio(judged, n) - ratio(base, n);
	const extraSolves = judged - base;
	const headroom = oracle - base;

	return {
		turns: n,
		baselineSuccessRate: ratio(base, n),
		judgeSuccessRate: ratio(judged, n),
		adoptedSuccessRate: ratio(adopted, n),
		adoptedLift: round(ratio(adopted, n) - ratio(base, n), 4),
		gatedTurns: gated.length,
		gateRescueRate: ratio(rescued, gated.length),
		oracleSuccessRate: ratio(oracle, n),
		judgeLift: round(lift, 4),
		judgeHeadroomCaptured: headroom === 0 ? 0 : round((judged - base) / headroom, 4),
		judgeRecall: ratio(recallHits, solvable.length),
		judgeRegressions: regressions,
		fanoutLedgerCostUsd: round(sum(turns, (t) => t.candidate!.fanoutLedgerCostUsd)),
		fanoutListEquivalentUsd: round(fanoutList),
		judgeCostUsd: round(sum(turns, (t) => t.candidate!.judgeCostUsd), 8),
		listUsdPerExtraSolve: extraSolves <= 0 ? Number.POSITIVE_INFINITY : round(fanoutList / extraSolves),
		avgCandidates: round(sum(turns, (t) => t.candidate!.candidates.length) / n, 2),
	};
}

/**
 * What the cold turns cost above the same turns on the same model with a warm cache.
 * The harness prices both shapes per turn, so this is exact, not a ratio estimate.
 * It is a split of money already counted in listEquivalentUsd, not a separate charge.
 */
function coldPremium(turns: TurnRecord[]): number {
	return turns.reduce((acc, t) => acc + (t.cold ? t.listEquivalentUsd - t.warmListEquivalentUsd : 0), 0);
}

function sum<T>(items: T[], f: (item: T) => number): number {
	return items.reduce((acc, item) => acc + f(item), 0);
}

function ratio(a: number, b: number): number {
	return b === 0 ? 0 : round(a / b, 4);
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return round(sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2, 4);
}

function round(n: number, digits = 4): number {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}
