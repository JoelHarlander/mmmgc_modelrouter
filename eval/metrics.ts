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

export interface RunMetrics {
	tasks: number;
	turns: number;
	routedTurns: number;
	pinnedTurns: number;

	/** Quality */
	taskResolveRate: number;
	turnSuccessRate: number;
	tierAccuracy: number;
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
	classifierCostUsd: number;
	listUsdPerResolvedTask: number;

	/** Cache consequence */
	switches: number;
	switchesPerTurn: number;
	coldTurns: number;
	coldWriteTokens: number;
	coldByCause: Record<string, number>;
	coldPremiumUsd: number;

	modelShare: Record<string, number>;
	avgStateChars: number;

	candidate?: CandidateMetrics;
}

export interface CandidateMetrics {
	turns: number;
	baselineSuccessRate: number;
	judgeSuccessRate: number;
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
	const routed = turns.filter((t) => !t.pinned);

	const tierIndex = (tier: string) => TIERS.indexOf(tier as (typeof TIERS)[number]);
	let exact = 0;
	let under = 0;
	let over = 0;
	let underFail = 0;
	for (const t of turns) {
		const delta = tierIndex(t.chosenTier) - tierIndex(t.goldTier);
		if (delta === 0) exact += 1;
		else if (delta < 0) {
			under += 1;
			if (!t.solved) underFail += 1;
		} else over += 1;
	}

	const ledgerCostUsd = sum(turns, (t) => t.ledgerCostUsd) + sum(turns, (t) => t.candidate?.fanoutLedgerCostUsd ?? 0);
	const listEquivalentUsd = sum(turns, (t) => t.listEquivalentUsd) + sum(turns, (t) => t.candidate?.fanoutListEquivalentUsd ?? 0);
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
		turnSuccessRate: ratio(turns.filter((t) => t.solved).length, turns.length),
		tierAccuracy: ratio(exact, turns.length),
		underRouteRate: ratio(under, turns.length),
		overRouteRate: ratio(over, turns.length),
		underRouteFailures: underFail,

		inTierMisses: turns.filter((t) => t.inTierAlternativeWouldSolve).length,

		ineligibleChoices: turns.filter((t) => !t.eligible).length,
		heuristicFallbacks: turns.filter((t) => t.classifierSource === "heuristic").length,
		tierEscalations: turns.filter((t) => t.chosenTier !== t.requestedTier).length,

		ledgerCostUsd: round(ledgerCostUsd),
		listEquivalentUsd: round(listEquivalentUsd),
		planHiddenUsd: round(listEquivalentUsd - ledgerCostUsd),
		classifierCostUsd: round(sum(turns, (t) => t.classifierCostUsd) + sum(turns, (t) => t.candidate?.judgeCostUsd ?? 0), 8),
		listUsdPerResolvedTask: resolved === 0 ? Number.POSITIVE_INFINITY : round(listEquivalentUsd / resolved),

		switches: turns.filter((t) => t.switched).length,
		switchesPerTurn: ratio(turns.filter((t) => t.switched).length, turns.length),
		coldTurns: turns.filter((t) => t.cold).length,
		coldWriteTokens: sum(turns, (t) => t.coldWriteTokens),
		coldByCause,
		coldPremiumUsd: round(coldPremium(turns)),

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

function round(n: number, digits = 4): number {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}
