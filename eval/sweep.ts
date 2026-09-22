/**
 * Parameter sweeps.
 *
 * A single candidate-selection run answers "did the judge help *this time*". That is
 * one draw from one judge at one noise setting, and the offline judge is the least
 * trustworthy part of the whole harness. The sweep answers the question that is
 * actually worth reporting: **over what range of judge quality does the lift survive,
 * and where does it turn negative?**
 *
 * Every cell is the mean over several seeds, with the spread reported, so a cell can
 * be read as a result rather than a coincidence.
 */
import { NoisyJudge } from "./candidates.ts";
import type { LoadedFleet } from "./fleet.ts";
import { runEval } from "./harness.ts";
import { computeMetrics } from "./metrics.ts";
import { DEFAULT_TRAFFIC, type TrafficProfile } from "./simulate.ts";
import type { ClassifierMode, TaskPack } from "./types.ts";

export interface SweepCell {
	candidateN: number;
	noise: number;
	bias: number;
	seeds: number;
	baselineSuccessRate: number;
	judgeSuccessRate: number;
	oracleSuccessRate: number;
	/** Mean judge - baseline, in rate points. */
	judgeLift: number;
	/** Half the range across seeds: the spread a single run hides. */
	liftSpread: number;
	judgeRecall: number;
	judgeRegressions: number;
	fanoutListEquivalentUsd: number;
	listUsdPerExtraSolve: number;
}

export interface SweepOptions {
	pack: TaskPack;
	loaded: LoadedFleet;
	classifier: ClassifierMode;
	startModel?: string;
	candidateNs?: number[];
	noises?: number[];
	biases?: number[];
	seeds?: string[];
}

export const DEFAULT_NOISES = [0, 5, 10, 20, 40, 80];
export const DEFAULT_SEEDS = ["s1", "s2", "s3", "s4", "s5"];

export async function runJudgeSweep(options: SweepOptions): Promise<SweepCell[]> {
	const candidateNs = options.candidateNs ?? [2, 3, 4];
	const noises = options.noises ?? DEFAULT_NOISES;
	const biases = options.biases ?? [0];
	const seeds = options.seeds ?? DEFAULT_SEEDS;
	const cells: SweepCell[] = [];

	for (const candidateN of candidateNs) {
		for (const bias of biases) {
			for (const noise of noises) {
				const runs = [];
				for (const seed of seeds) {
					const outcome = await runEval({
						pack: options.pack,
						loaded: options.loaded,
						classifier: options.classifier,
						startModel: options.startModel,
						candidateN,
						seed,
						judge: new NoisyJudge({ noise, seed, bias }),
					});
					const m = computeMetrics(outcome.turns, outcome.stateChars).candidate;
					if (m) runs.push(m);
				}
				if (runs.length === 0) continue;
				const lifts = runs.map((r) => r.judgeLift);
				cells.push({
					candidateN,
					noise,
					bias,
					seeds: runs.length,
					baselineSuccessRate: mean(runs.map((r) => r.baselineSuccessRate)),
					judgeSuccessRate: mean(runs.map((r) => r.judgeSuccessRate)),
					oracleSuccessRate: mean(runs.map((r) => r.oracleSuccessRate)),
					judgeLift: mean(lifts),
					liftSpread: (Math.max(...lifts) - Math.min(...lifts)) / 2,
					judgeRecall: mean(runs.map((r) => r.judgeRecall)),
					judgeRegressions: mean(runs.map((r) => r.judgeRegressions)),
					fanoutListEquivalentUsd: mean(runs.map((r) => r.fanoutListEquivalentUsd)),
					listUsdPerExtraSolve: meanFinite(runs.map((r) => r.listUsdPerExtraSolve)),
				});
			}
		}
	}
	return cells;
}

export function renderSweep(cells: SweepCell[], title: string): string {
	const out: string[] = ["", title, ""];
	out.push("    n  noise  bias   baseline    judge  ceiling       lift ± spread  recall  regress   fan-out $   $/extra");
	let lastN = -1;
	for (const c of cells) {
		if (c.candidateN !== lastN && lastN !== -1) out.push("");
		lastN = c.candidateN;
		out.push(
			`  ${String(c.candidateN).padStart(3)}  ${String(c.noise).padStart(5)}  ${String(c.bias).padStart(4)}   ` +
				`${pct(c.baselineSuccessRate).padStart(8)} ${pct(c.judgeSuccessRate).padStart(8)} ${pct(c.oracleSuccessRate).padStart(8)}   ` +
				`${signedPct(c.judgeLift).padStart(8)} ± ${pct(c.liftSpread).padStart(6)}  ${pct(c.judgeRecall).padStart(6)}  ${c.judgeRegressions.toFixed(1).padStart(7)}   ` +
				`${usd(c.fanoutListEquivalentUsd).padStart(9)} ${usd(c.listUsdPerExtraSolve).padStart(9)}`,
		);
	}
	out.push("");
	return `${out.join("\n")}\n`;
}

export interface TrafficCell {
	callsPerTurn: number;
	cacheGrowthTokensPerCall: number;
	outputTokensPerCall: number;
	listEquivalentUsd: number;
	coldPremiumUsd: number;
	coldPremiumShare: number;
	planPointsUsed: number;
	fanoutListEquivalentUsd: number;
	listUsdPerExtraSolve: number;
}

/**
 * How much the cost conclusions depend on the three measured traffic constants.
 * Quality never moves here — the routing decisions are identical — so every column is
 * a spend column, and the question is only how far the numbers travel.
 */
export async function runTrafficSweep(options: SweepOptions & { profiles?: Partial<TrafficProfile>[]; candidateN?: number }): Promise<TrafficCell[]> {
	const profiles = options.profiles ?? DEFAULT_TRAFFIC_PROFILES;
	const candidateN = options.candidateN ?? 3;
	const cells: TrafficCell[] = [];
	for (const partial of profiles) {
		const traffic: TrafficProfile = { ...DEFAULT_TRAFFIC, ...partial };
		const outcome = await runEval({
			pack: options.pack,
			loaded: options.loaded,
			classifier: options.classifier,
			startModel: options.startModel,
			candidateN,
			seed: (options.seeds ?? DEFAULT_SEEDS)[0]!,
			traffic,
		});
		const m = computeMetrics(outcome.turns, outcome.stateChars);
		cells.push({
			...traffic,
			listEquivalentUsd: m.listEquivalentUsd,
			coldPremiumUsd: m.coldPremiumUsd,
			coldPremiumShare: m.coldPremiumShare,
			planPointsUsed: m.planPointsUsed,
			fanoutListEquivalentUsd: m.candidate?.fanoutListEquivalentUsd ?? 0,
			listUsdPerExtraSolve: m.candidate?.listUsdPerExtraSolve ?? Number.POSITIVE_INFINITY,
		});
	}
	return cells;
}

/** The measured profile, plus the light- and heavy-tool-use ends the study's range allows. */
export const DEFAULT_TRAFFIC_PROFILES: Partial<TrafficProfile>[] = [
	{ callsPerTurn: 2 },
	{ callsPerTurn: 5 },
	{ callsPerTurn: 10 },
	{ callsPerTurn: 20 },
	{ callsPerTurn: 5, cacheGrowthTokensPerCall: 100 },
	{ callsPerTurn: 5, cacheGrowthTokensPerCall: 3000 },
	{ callsPerTurn: 5, outputTokensPerCall: 150 },
	{ callsPerTurn: 5, outputTokensPerCall: 2000 },
];

export function renderTrafficSweep(cells: TrafficCell[], title: string): string {
	const out: string[] = ["", title, ""];
	out.push("  calls  growth  output       list $   cold prem    share   plan pts    fan-out $    $/extra");
	for (const c of cells) {
		out.push(
			`  ${String(c.callsPerTurn).padStart(5)}  ${String(c.cacheGrowthTokensPerCall).padStart(6)}  ${String(c.outputTokensPerCall).padStart(6)}   ` +
				`${usd(c.listEquivalentUsd).padStart(10)}  ${usd(c.coldPremiumUsd).padStart(10)}   ${pct(c.coldPremiumShare).padStart(6)}   ` +
				`${c.planPointsUsed.toFixed(2).padStart(8)}   ${usd(c.fanoutListEquivalentUsd).padStart(10)} ${usd(c.listUsdPerExtraSolve).padStart(10)}`,
		);
	}
	out.push("");
	return `${out.join("\n")}\n`;
}

function mean(values: number[]): number {
	return round(values.reduce((a, b) => a + b, 0) / values.length, 4);
}

/** Averages only the runs where a lift existed; all-infinite means there was never one. */
function meanFinite(values: number[]): number {
	const finite = values.filter((v) => Number.isFinite(v));
	return finite.length === 0 ? Number.POSITIVE_INFINITY : round(finite.reduce((a, b) => a + b, 0) / finite.length, 4);
}

function round(n: number, digits: number): number {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function signedPct(n: number): string {
	return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}pp`;
}

function usd(n: number): string {
	return Number.isFinite(n) ? `$${n.toFixed(2)}` : "n/a";
}
