/**
 * Is the classifier's confidence worth anything?
 *
 * `src/router.ts` keeps the current model whenever confidence falls below
 * `switching.minConfidence`. That bar only makes sense if confidence actually predicts
 * correctness — if a 0.9 answer is no likelier to name the right tier than a 0.4 one,
 * the bar is gating on noise and the router is deciding by coin flip in both branches.
 *
 * This is the routing-side twin of the judge probe: the probe asks whether the judge's
 * *pick* is trustworthy, this asks whether the classifier's *certainty* is. It runs on
 * whatever classifier produced the run, so `--classifier live --calibration` reports
 * Jev's own calibration curve on the same terms.
 */
import type { TurnRecord } from "./types.ts";

export interface CalibrationBucket {
	lower: number;
	upper: number;
	turns: number;
	meanConfidence: number;
	/** Share of the bucket's turns where the chosen tier matched the derived gold tier. */
	accuracy: number;
	/** Below the router's bar these turns keep the current model rather than route. */
	belowBar: boolean;
}

export interface CalibrationReport {
	turns: number;
	buckets: CalibrationBucket[];
	/**
	 * Expected calibration error: the turn-weighted gap between stated confidence and
	 * observed accuracy. 0 is perfect; a large value with high confidence means the
	 * classifier is overconfident, which is what makes a confidence bar dangerous.
	 */
	ece: number;
	/** Signed version of the same: positive = overconfident, negative = underconfident. */
	bias: number;
	/**
	 * Does confidence carry signal at all? Accuracy in the top half of the confidence
	 * range minus accuracy in the bottom half. <= 0 means the bar is gating on noise.
	 */
	discrimination: number;
	minConfidence: number;
	/** Turns the bar suppressed, and how many of those the classifier had right anyway. */
	suppressed: number;
	suppressedCorrect: number;
}

const EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];

export function computeCalibration(turns: TurnRecord[], minConfidence: number): CalibrationReport {
	// Pinned turns never consult the classifier, so they say nothing about it.
	const routed = turns.filter((t) => !t.pinned);
	const buckets: CalibrationBucket[] = [];
	let ece = 0;
	let bias = 0;

	for (let i = 0; i < EDGES.length - 1; i++) {
		const lower = EDGES[i]!;
		const upper = EDGES[i + 1]!;
		const inBucket = routed.filter((t) => t.confidence >= lower && t.confidence < upper);
		if (inBucket.length === 0) continue;
		const meanConfidence = avg(inBucket.map((t) => t.confidence));
		// The classifier's own answer: calibration is about what it claimed, not where the router landed.
		const accuracy = inBucket.filter((t) => t.requestedTier === t.goldTier).length / inBucket.length;
		buckets.push({
			lower,
			upper: Math.min(upper, 1),
			turns: inBucket.length,
			meanConfidence: round(meanConfidence),
			accuracy: round(accuracy),
			belowBar: upper <= minConfidence,
		});
		const weight = inBucket.length / routed.length;
		ece += weight * Math.abs(meanConfidence - accuracy);
		bias += weight * (meanConfidence - accuracy);
	}

	const mid = 0.7;
	const high = routed.filter((t) => t.confidence >= mid);
	const low = routed.filter((t) => t.confidence < mid);
	const accOf = (list: TurnRecord[]) => (list.length === 0 ? 0 : list.filter((t) => t.requestedTier === t.goldTier).length / list.length);
	const suppressed = routed.filter((t) => t.confidence < minConfidence);

	return {
		turns: routed.length,
		buckets,
		ece: round(ece),
		bias: round(bias),
		discrimination: high.length === 0 || low.length === 0 ? 0 : round(accOf(high) - accOf(low)),
		minConfidence,
		suppressed: suppressed.length,
		// The classifier's own answer, not the model the router kept: these are the turns
		// the bar threw away a correct classification.
		suppressedCorrect: suppressed.filter((t) => t.requestedTier === t.goldTier).length,
	};
}

export function renderCalibration(report: CalibrationReport, label: string): string {
	const out: string[] = ["", `classifier calibration — ${label}`, ""];
	out.push("  confidence      turns   stated   observed      gap");
	for (const b of report.buckets) {
		const gap = b.meanConfidence - b.accuracy;
		out.push(
			`  ${`${b.lower.toFixed(2)}–${b.upper.toFixed(2)}`.padEnd(12)}${String(b.turns).padStart(7)}   ${pct(b.meanConfidence).padStart(6)}   ` +
				`${pct(b.accuracy).padStart(8)}   ${signed(gap).padStart(6)}${b.belowBar ? "   (below the router's bar)" : ""}`,
		);
	}
	out.push("");
	out.push(`  expected calibration error   ${pct(report.ece)}`);
	out.push(`  over/under-confidence        ${signed(report.bias)}   ${report.bias > 0 ? "(overconfident)" : report.bias < 0 ? "(underconfident)" : ""}`);
	out.push(`  discrimination (≥0.70 − <0.70) ${signed(report.discrimination)}   ${report.discrimination <= 0 ? "← confidence carries no signal" : ""}`);
	out.push(`  bar at ${report.minConfidence.toFixed(2)}: suppressed ${report.suppressed} turn(s), ${report.suppressedCorrect} of which were classified correctly`);
	out.push("");
	return `${out.join("\n")}\n`;
}

function avg(values: number[]): number {
	return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
}

function round(n: number): number {
	return Math.round(n * 1e4) / 1e4;
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function signed(n: number): string {
	return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}pp`;
}
