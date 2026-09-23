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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { bootstrapDifference, renderPaired, tasksNeededFor } from "./bootstrap.ts";
import { type BiasAxis, CANDIDATE_POLICIES, NoisyJudge } from "./candidates.ts";
import { STAKES_OVERRIDES } from "./classifier.ts";
import { modelKey } from "../src/config.ts";
import { buildFleet, type LoadedFleet } from "./fleet.ts";
import { mergeConfig } from "../src/config.ts";
import { computeCalibration } from "./calibration.ts";
import { runEval } from "./harness.ts";
import { computeMetrics } from "./metrics.ts";
import { DEFAULT_TRAFFIC, hashUnit, type TrafficProfile } from "./simulate.ts";
import type { ClassifierMode, Fleet, TaskPack } from "./types.ts";

export interface SweepCell {
	candidateN: number;
	noise: number;
	bias: number;
	minConfidence: number;
	seeds: number;
	baselineSuccessRate: number;
	judgeSuccessRate: number;
	adoptedSuccessRate: number;
	adoptedLift: number;
	gatedTurns: number;
	gateRescueRate: number;
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
	minConfidences?: number[];
	seeds?: string[];
}

export const DEFAULT_NOISES = [0, 5, 10, 20, 40, 80];
export const DEFAULT_SEEDS = ["s1", "s2", "s3", "s4", "s5"];

export async function runJudgeSweep(options: SweepOptions): Promise<SweepCell[]> {
	const candidateNs = options.candidateNs ?? [2, 3, 4];
	const noises = options.noises ?? DEFAULT_NOISES;
	const biases = options.biases ?? [0];
	const minConfidences = options.minConfidences ?? [undefined];
	const seeds = options.seeds ?? DEFAULT_SEEDS;
	const cells: SweepCell[] = [];

	for (const candidateN of candidateNs) {
		for (const bias of biases) {
			for (const minConfidence of minConfidences) {
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
							judgeMinConfidence: minConfidence,
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
						minConfidence: minConfidence ?? options.loaded.config.switching.minConfidence,
						seeds: runs.length,
						baselineSuccessRate: mean(runs.map((r) => r.baselineSuccessRate)),
						judgeSuccessRate: mean(runs.map((r) => r.judgeSuccessRate)),
						adoptedSuccessRate: mean(runs.map((r) => r.adoptedSuccessRate)),
						adoptedLift: mean(runs.map((r) => r.adoptedLift)),
						gatedTurns: mean(runs.map((r) => r.gatedTurns)),
						gateRescueRate: mean(runs.map((r) => r.gateRescueRate)),
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
	}
	return cells;
}

/** The gate sweep's own renderer: adoption is the column that matters, not the raw pick. */
export function renderGateSweep(cells: SweepCell[], title: string): string {
	const out: string[] = ["", title, ""];
	out.push("    n  noise  bias   minConf   baseline   raw pick   adopted      adopted lift   gated  rescued");
	let last = "";
	for (const c of cells) {
		const group = `${c.candidateN}/${c.bias}`;
		if (group !== last && last !== "") out.push("");
		last = group;
		out.push(
			`  ${String(c.candidateN).padStart(3)}  ${String(c.noise).padStart(5)}  ${String(c.bias).padStart(4)}   ` +
				`${c.minConfidence.toFixed(2).padStart(7)}   ${pct(c.baselineSuccessRate).padStart(8)}   ${pct(c.judgeSuccessRate).padStart(8)}   ` +
				`${pct(c.adoptedSuccessRate).padStart(7)}   ${signedPct(c.adoptedLift).padStart(15)}   ${c.gatedTurns.toFixed(1).padStart(5)}   ${pct(c.gateRescueRate).padStart(6)}`,
		);
	}
	out.push("");
	return `${out.join("\n")}\n`;
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

export interface OverrideCell {
	variant: string;
	toStandard: number;
	toHeavy: number;
	tierAccuracy: number;
	sessionSuccessRate: number;
	underRouteRate: number;
	overRouteRate: number;
	inTierMisses: number;
	listEquivalentUsd: number;
}

/**
 * What the router can do about round 36 without touching the classifier.
 *
 * The tier criteria in `src/state.ts` describe the light band as "answer a factual
 * question, explain a snippet", so Jev rates hard questions light while following its
 * prompt correctly. The router cannot change that from where it sits - but `stakes` is
 * asked in the same call and still tracks difficulty, and the stakes override is the one
 * place the router already overrules the classifier. This measures widening it.
 */
export async function runOverrideSweep(options: SweepOptions & { variants?: string[] }): Promise<OverrideCell[]> {
	const variants = options.variants ?? Object.keys(STAKES_OVERRIDES);
	const cells: OverrideCell[] = [];
	for (const variant of variants) {
		const stakesOverride = STAKES_OVERRIDES[variant]!;
		const outcome = await runEval({
			pack: options.pack,
			loaded: options.loaded,
			classifier: options.classifier,
			startModel: options.startModel,
			stakesOverride,
		});
		const m = computeMetrics(outcome.turns, outcome.stateChars);
		cells.push({
			variant,
			toStandard: stakesOverride.toStandard,
			toHeavy: stakesOverride.toHeavy,
			tierAccuracy: m.tierAccuracy,
			sessionSuccessRate: m.sessionSuccessRate,
			underRouteRate: m.underRouteRate,
			overRouteRate: m.overRouteRate,
			inTierMisses: m.inTierMisses,
			listEquivalentUsd: m.listEquivalentUsd,
		});
	}
	return cells;
}

export function renderOverrideSweep(cells: OverrideCell[], title: string): string {
	const out: string[] = ["", title, ""];
	out.push("  variant           light->std  light->heavy   tier acc   session ok   under   over   in-tier      list $");
	for (const c of cells) {
		const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "  -");
		out.push(
			`  ${c.variant.padEnd(16)}  ${fmt(c.toStandard).padStart(10)}  ${fmt(c.toHeavy).padStart(12)}   ${pct(c.tierAccuracy).padStart(8)}   ` +
				`${pct(c.sessionSuccessRate).padStart(10)}   ${pct(c.underRouteRate).padStart(5)}  ${pct(c.overRouteRate).padStart(5)}   ${String(c.inTierMisses).padStart(7)}   ${usd(c.listEquivalentUsd).padStart(9)}`,
		);
	}
	out.push("");
	return `${out.join("\n")}\n`;
}

export interface AxisCell {
	policy: string;
	axis: string;
	bias: number;
	seeds: number;
	adoptedLift: number;
	judgeRegressions: number;
	/** The set member each axis favours, and whether it is also the strongest. */
	favoured: string;
	favouredIsStrongest: boolean;
}

/**
 * Does a candidate set's bias-immunity survive a bias on a *different axis*?
 *
 * Round 9 found `tier-top` unmoved by judge bias, because its flashiest member is also
 * its strongest, and flagged in the same breath that the immunity might be specific to
 * that axis. It never tested it. This does: `price` is round 9's axis, `length` is the
 * other documented judge failure mode, and a set is only robust if it survives both.
 */
export async function runAxisSweep(options: SweepOptions & { policies?: string[]; axes?: BiasAxis[]; candidateN?: number }): Promise<AxisCell[]> {
	const policies = options.policies ?? Object.keys(CANDIDATE_POLICIES);
	const axes = options.axes ?? (["price", "length"] as BiasAxis[]);
	const biases = options.biases ?? [0, 40];
	const seeds = options.seeds ?? DEFAULT_SEEDS;
	const cells: AxisCell[] = [];

	const current = options.loaded.models.find((m) => modelKey(m) === (options.startModel ?? "faux-plan-anthropic/claude-opus-5"));

	for (const policy of policies) {
		const set = CANDIDATE_POLICIES[policy]!({
			current,
			cfg: options.loaded.config,
			n: options.candidateN ?? 3,
			byKey: options.loaded.byKey,
			unauthed: options.loaded.unauthed,
			registry: options.loaded.registry,
			ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "router-eval-policy-")), "usage.json")),
		});
		const strongest = [...set].sort((a, b) => b.skill - a.skill)[0];
		for (const axis of axes) {
			const favoured =
				axis === "length"
					? [...set].sort((a, b) => (b.verbosity ?? 0) - (a.verbosity ?? 0))[0]
					: [...set].sort((a, b) => b.cost.output - a.cost.output)[0];
			for (const bias of biases) {
				const runs = [];
				for (const seed of seeds) {
					const outcome = await runEval({
						pack: options.pack,
						loaded: options.loaded,
						classifier: options.classifier,
						startModel: options.startModel,
						candidateN: options.candidateN ?? 3,
						candidatePolicy: policy,
						judgeMinConfidence: 0,
						seed,
						judge: new NoisyJudge({ noise: 10, seed, bias, biasAxis: axis }),
					});
					const m = computeMetrics(outcome.turns, outcome.stateChars).candidate;
					if (m) runs.push(m);
				}
				if (runs.length === 0) continue;
				cells.push({
					policy,
					axis,
					bias,
					seeds: runs.length,
					adoptedLift: mean(runs.map((r) => r.adoptedLift)),
					judgeRegressions: mean(runs.map((r) => r.judgeRegressions)),
					favoured: favoured?.key ?? "none",
					favouredIsStrongest: favoured?.key === strongest?.key,
				});
			}
		}
	}
	return cells;
}

export function renderAxisSweep(cells: AxisCell[], title: string): string {
	const out: string[] = ["", title, ""];
	out.push("  policy       axis     bias   adopted lift   regress   favoured member        also strongest?");
	let last = "";
	for (const c of cells) {
		if (c.policy !== last && last !== "") out.push("");
		last = c.policy;
		out.push(
			`  ${c.policy.padEnd(11)}  ${c.axis.padEnd(7)} ${String(c.bias).padStart(4)}   ${signedPct(c.adoptedLift).padStart(12)}   ${c.judgeRegressions.toFixed(1).padStart(7)}   ` +
				`${(c.favoured.split("/").pop() ?? "").padEnd(22)} ${c.favouredIsStrongest ? "yes" : "NO"}`,
		);
	}
	out.push("");
	out.push("  a set is only bias-robust if it survives every axis, and you cannot align with an axis you have not measured.");
	out.push("");
	return `${out.join("\n")}\n`;
}

export interface PolicyCell {
	policy: string;
	candidateN: number;
	bias: number;
	seeds: number;
	baselineSuccessRate: number;
	/** Can the set even contain a solver? The ceiling a perfect judge would reach. */
	oracleSuccessRate: number;
	judgeSuccessRate: number;
	adoptedSuccessRate: number;
	adoptedLift: number;
	judgeRegressions: number;
	fanoutListEquivalentUsd: number;
	listUsdPerExtraSolve: number;
}

/**
 * What the inherited candidate policy costs by comparison. `shipped` is
 * src/parallel.ts's own set; the rest are alternatives the harness scores against it.
 * Nothing here changes the shipped fan-out.
 */
export async function runPolicySweep(options: SweepOptions & { policies?: string[]; candidateN?: number }): Promise<PolicyCell[]> {
	const policies = options.policies ?? Object.keys(CANDIDATE_POLICIES);
	const candidateN = options.candidateN ?? 3;
	const biases = options.biases ?? [0, 20];
	const seeds = options.seeds ?? DEFAULT_SEEDS;
	const cells: PolicyCell[] = [];

	for (const policy of policies) {
		for (const bias of biases) {
			const runs = [];
			for (const seed of seeds) {
				const outcome = await runEval({
					pack: options.pack,
					loaded: options.loaded,
					classifier: options.classifier,
					startModel: options.startModel,
					candidateN,
					candidatePolicy: policy,
					seed,
					judge: new NoisyJudge({ noise: 10, seed, bias }),
				});
				const m = computeMetrics(outcome.turns, outcome.stateChars).candidate;
				if (m) runs.push(m);
			}
			if (runs.length === 0) continue;
			cells.push({
				policy,
				candidateN,
				bias,
				seeds: runs.length,
				baselineSuccessRate: mean(runs.map((r) => r.baselineSuccessRate)),
				oracleSuccessRate: mean(runs.map((r) => r.oracleSuccessRate)),
				judgeSuccessRate: mean(runs.map((r) => r.judgeSuccessRate)),
				adoptedSuccessRate: mean(runs.map((r) => r.adoptedSuccessRate)),
				adoptedLift: mean(runs.map((r) => r.adoptedLift)),
				judgeRegressions: mean(runs.map((r) => r.judgeRegressions)),
				fanoutListEquivalentUsd: mean(runs.map((r) => r.fanoutListEquivalentUsd)),
				listUsdPerExtraSolve: meanFinite(runs.map((r) => r.listUsdPerExtraSolve)),
			});
		}
	}
	return cells;
}

export function renderPolicySweep(cells: PolicyCell[], title: string): string {
	const out: string[] = ["", title, ""];
	out.push("  policy       bias   baseline   ceiling   raw pick   adopted    adopted lift   regress   fan-out $    $/extra");
	let last = "";
	for (const c of cells) {
		if (c.policy !== last && last !== "") out.push("");
		last = c.policy;
		out.push(
			`  ${c.policy.padEnd(11)} ${String(c.bias).padStart(4)}   ${pct(c.baselineSuccessRate).padStart(8)}  ${pct(c.oracleSuccessRate).padStart(8)}   ` +
				`${pct(c.judgeSuccessRate).padStart(8)}  ${pct(c.adoptedSuccessRate).padStart(8)}   ${signedPct(c.adoptedLift).padStart(13)}   ${c.judgeRegressions.toFixed(1).padStart(7)}   ` +
				`${usd(c.fanoutListEquivalentUsd).padStart(9)}  ${usd(c.listUsdPerExtraSolve).padStart(9)}`,
		);
	}
	out.push("");
	return `${out.join("\n")}\n`;
}

export interface PairedComparison {
	label: string;
	results: import("./bootstrap.ts").PairedResult[];
}

/**
 * The canonical comparisons this log rests on, each with a paired 95% interval, so a
 * reader can tell which of twenty rounds' claims the pack is actually large enough to
 * support. Paired because every claim is "A beats B on the same tasks", which cancels
 * the shared task-difficulty variance.
 */
export async function runPairedComparisons(options: SweepOptions & { candidateN?: number }): Promise<PairedComparison[]> {
	const { pack, loaded } = options;
	const n = options.candidateN ?? 3;
	const seed = "paired";
	const judge = () => new NoisyJudge({ noise: 10, seed });
	const run = (patch: Partial<Parameters<typeof runEval>[0]>) =>
		runEval({ pack, loaded, classifier: options.classifier, startModel: options.startModel, seed, ...patch });

	const routed = await run({});
	const oracle = await run({ classifier: "oracle" });
	const heuristic = await run({ classifier: "heuristic" });
	const fanout = await run({ candidateN: n, judge: judge() });
	const tierTop = await run({ candidateN: n, candidatePolicy: "tier-top", judge: judge() });
	const explore = await run({ candidateN: n, exploreTurns: 3, judge: judge() });
	const biased = await run({ candidateN: n, judge: new NoisyJudge({ noise: 10, seed, bias: 40 }) });

	const pairs: [string, typeof routed, typeof routed][] = [
		["routing (oracle) − never switching (heuristic)", oracle, heuristic],
		["fan-out every turn − no fan-out", fanout, routed],
		["tier-top candidate set − the shipped one", tierTop, fanout],
		["explore-3 − fan out every turn", explore, fanout],
		["fan-out with a 40-point biased judge − no fan-out", biased, routed],
	];
	return pairs.map(([label, a, b]) => ({ label, results: bootstrapDifference(a.turns, b.turns) }));
}

export function renderPairedComparisons(comparisons: PairedComparison[], title: string): string {
	const out: string[] = ["", title, ""];
	for (const c of comparisons) {
		out.push(renderPaired(c.results, c.label));
		out.push("");
	}
	const quality = comparisons.flatMap((c) => c.results.filter((r) => r.metric === "sessionSuccessRate"));
	const cost = comparisons.flatMap((c) => c.results.filter((r) => r.metric === "listEquivalentUsd"));
	const time = comparisons.flatMap((c) => c.results.filter((r) => r.metric === "wallClockSeconds"));
	out.push(
		`  ${cost.filter((r) => r.significant).length}/${cost.length} cost differences resolve; ` +
			`${time.filter((r) => r.significant).length}/${time.length} wall-clock differences resolve; ` +
			`${quality.filter((r) => r.significant).length}/${quality.length} quality differences do.`,
	);
	const widest = quality.reduce((a, b) => (b.halfWidth > a.halfWidth ? b : a));
	out.push(
		`  To resolve a 5pp quality difference this pack would need about ` +
			`${tasksNeededFor(0.05, widest.halfWidth, widest.tasks)} tasks of this shape; 2pp needs about ` +
			`${tasksNeededFor(0.02, widest.halfWidth, widest.tasks)}.`,
	);
	out.push("");
	return `${out.join("\n")}\n`;
}

export interface StartCell {
	startModel: string;
	classifier: string;
	sessionSuccessRate: number;
	tierAccuracy: number;
	switches: number;
	listEquivalentUsd: number;
	coldPremiumUsd: number;
	compactions: number;
}

/**
 * Does any of this depend on where the session happened to start?
 *
 * Every "never switching wins" result in this log was taken with the session starting on
 * the strongest plan model, because that is where the cache-cost study found this machine
 * sitting. A profile that never switches therefore never leaves the best model in the
 * fleet, which flatters it enormously. This sweeps the starting point instead of assuming it.
 */
export async function runStartSweep(options: SweepOptions & { startModels?: string[]; classifiers?: ClassifierMode[] }): Promise<StartCell[]> {
	const starts = options.startModels ?? [...options.loaded.byKey.keys()];
	const classifiers = options.classifiers ?? (["scripted", "heuristic", "oracle"] as ClassifierMode[]);
	const cells: StartCell[] = [];
	for (const startModel of starts) {
		for (const classifier of classifiers) {
			const outcome = await runEval({ pack: options.pack, loaded: options.loaded, classifier, startModel });
			const m = computeMetrics(outcome.turns, outcome.stateChars);
			cells.push({
				startModel,
				classifier,
				sessionSuccessRate: m.sessionSuccessRate,
				tierAccuracy: m.tierAccuracy,
				switches: m.switches,
				listEquivalentUsd: m.listEquivalentUsd,
				coldPremiumUsd: m.coldPremiumUsd,
				compactions: m.compactions,
			});
		}
	}
	return cells;
}

export function renderStartSweep(cells: StartCell[], title: string): string {
	const out: string[] = ["", title, ""];
	out.push("  start model                          classifier   session ok   tier acc   switches      list $   cold prem   compactions");
	let last = "";
	for (const c of cells) {
		if (c.startModel !== last && last !== "") out.push("");
		last = c.startModel;
		out.push(
			`  ${c.startModel.padEnd(34)}   ${c.classifier.padEnd(10)}   ${pct(c.sessionSuccessRate).padStart(10)}   ${pct(c.tierAccuracy).padStart(8)}   ` +
				`${String(c.switches).padStart(8)}   ${usd(c.listEquivalentUsd).padStart(9)}   ${usd(c.coldPremiumUsd).padStart(9)}   ${String(c.compactions).padStart(11)}`,
		);
	}
	out.push("");
	return `${out.join("\n")}\n`;
}

export interface PinCell {
	manualPinTurns: number;
	pinnedTurns: number;
	tierAccuracy: number;
	sessionSuccessRate: number;
	switches: number;
	listEquivalentUsd: number;
	coldPremiumUsd: number;
	/** Pinned turns the operator's model was wrong for: the cost of the pin outliving its request. */
	pinnedWrongTier: number;
}

/**
 * What `switching.manualPinTurns` costs. A `/model` pin is the operator overriding the
 * router, and the router respects it for N turns afterwards. Round 12 found a pin set
 * for a one-line question still governing a heavy turn two turns later; this measures
 * how much of that there is across the pack.
 */
export async function runPinSweep(options: SweepOptions & { pinTurns?: number[] }): Promise<PinCell[]> {
	const pins = options.pinTurns ?? [0, 1, 2, 3, 5, 10];
	const cells: PinCell[] = [];
	for (const manualPinTurns of pins) {
		const loaded: LoadedFleet = {
			...options.loaded,
			config: mergeConfig(options.loaded.config, { switching: { ...options.loaded.config.switching, manualPinTurns } }),
		};
		const outcome = await runEval({ pack: options.pack, loaded, classifier: options.classifier, startModel: options.startModel });
		const m = computeMetrics(outcome.turns, outcome.stateChars);
		cells.push({
			manualPinTurns,
			pinnedTurns: m.pinnedTurns,
			tierAccuracy: m.tierAccuracy,
			sessionSuccessRate: m.sessionSuccessRate,
			switches: m.switches,
			listEquivalentUsd: m.listEquivalentUsd,
			coldPremiumUsd: m.coldPremiumUsd,
			pinnedWrongTier: outcome.turns.filter((t) => t.pinned && t.effectiveTier !== t.goldTier).length,
		});
	}
	return cells;
}

export function renderPinSweep(cells: PinCell[], title: string): string {
	const out: string[] = ["", title, ""];
	out.push("  pin turns   pinned   wrong tier while pinned   tier acc   session ok   switches      list $   cold prem");
	for (const c of cells) {
		out.push(
			`  ${String(c.manualPinTurns).padStart(9)}   ${String(c.pinnedTurns).padStart(6)}   ${String(c.pinnedWrongTier).padStart(23)}   ` +
				`${pct(c.tierAccuracy).padStart(8)}   ${pct(c.sessionSuccessRate).padStart(10)}   ${String(c.switches).padStart(8)}   ` +
				`${usd(c.listEquivalentUsd).padStart(9)}   ${usd(c.coldPremiumUsd).padStart(9)}`,
		);
	}
	out.push("");
	return `${out.join("\n")}\n`;
}

export interface StrategyCell {
	strategy: string;
	exploreTurns: number;
	candidateN: number;
	bias: number;
	seeds: number;
	/** What the session ends up with: adopted where fan-out ran, routed otherwise. */
	turnSuccessRate: number;
	listEquivalentUsd: number;
	fanoutListEquivalentUsd: number;
	/** Turns actually fanned out, per run. Exploration only pays for the first few. */
	fanoutTurns: number;
	/** Extra list spend per extra turn solved, against the no-fan-out baseline. */
	listUsdPerExtraSolve: number;
}

/**
 * Fan-out as *exploration* rather than as a per-turn cost.
 *
 * "2+ responses every turn and the judge picks" is the expensive reading of the idea.
 * The cheap reading is: fan out for the first few turns of a session, see which model
 * the judge keeps choosing, then commit to it. This sweep scores both against not
 * fanning out at all, on turn success and on total spend.
 *
 * Harness-side only: it measures the idea and changes nothing about the shipped router
 * or the shipped fan-out.
 */
export async function runStrategySweep(options: SweepOptions & { candidateN?: number; exploreDepths?: number[] }): Promise<StrategyCell[]> {
	const candidateN = options.candidateN ?? 3;
	const depths = options.exploreDepths ?? [1, 2, 3, 5];
	const biases = options.biases ?? [0, 20];
	const seeds = options.seeds ?? DEFAULT_SEEDS;
	const cells: StrategyCell[] = [];

	for (const bias of biases) {
		// Baseline: no fan-out at all. Independent of the judge, so one run is enough.
		const baseOutcome = await runEval({
			pack: options.pack,
			loaded: options.loaded,
			classifier: options.classifier,
			startModel: options.startModel,
		});
		const baseMetrics = computeMetrics(baseOutcome.turns, baseOutcome.stateChars);
		const baseSolved = baseMetrics.sessionSuccessRate * baseMetrics.turns;
		cells.push({
			strategy: "route",
			exploreTurns: 0,
			candidateN: 0,
			bias,
			seeds: 1,
			turnSuccessRate: baseMetrics.sessionSuccessRate,
			listEquivalentUsd: baseMetrics.listEquivalentUsd,
			fanoutListEquivalentUsd: 0,
			fanoutTurns: 0,
			listUsdPerExtraSolve: Number.POSITIVE_INFINITY,
		});

		for (const exploreTurns of [0, ...depths]) {
			const runs: { success: number; list: number; fanout: number; fanoutTurns: number; turns: number }[] = [];
			for (const seed of seeds) {
				const outcome = await runEval({
					pack: options.pack,
					loaded: options.loaded,
					classifier: options.classifier,
					startModel: options.startModel,
					candidateN,
					exploreTurns,
					seed,
					judge: new NoisyJudge({ noise: 10, seed, bias }),
				});
				const m = computeMetrics(outcome.turns, outcome.stateChars);
				runs.push({
					success: m.sessionSuccessRate,
					list: m.listEquivalentUsd,
					fanout: m.candidate?.fanoutListEquivalentUsd ?? 0,
					fanoutTurns: outcome.turns.filter((t) => t.candidate).length,
					turns: m.turns,
				});
			}
			const success = mean(runs.map((r) => r.success));
			const list = mean(runs.map((r) => r.list));
			const extra = success * runs[0]!.turns - baseSolved;
			cells.push({
				strategy: exploreTurns === 0 ? "fanout-always" : `explore-${exploreTurns}`,
				exploreTurns,
				candidateN,
				bias,
				seeds: runs.length,
				turnSuccessRate: success,
				listEquivalentUsd: list,
				fanoutListEquivalentUsd: mean(runs.map((r) => r.fanout)),
				fanoutTurns: mean(runs.map((r) => r.fanoutTurns)),
				listUsdPerExtraSolve: extra <= 0 ? Number.POSITIVE_INFINITY : round((list - baseMetrics.listEquivalentUsd) / extra, 4),
			});
		}
	}
	return cells;
}

export function renderStrategySweep(cells: StrategyCell[], title: string): string {
	const out: string[] = ["", title, ""];
	out.push("  strategy         bias   turn ok   fan-out turns      total $    fan-out $    $/extra solve");
	let lastBias = -1;
	for (const c of cells) {
		if (c.bias !== lastBias && lastBias !== -1) out.push("");
		lastBias = c.bias;
		out.push(
			`  ${c.strategy.padEnd(15)} ${String(c.bias).padStart(4)}   ${pct(c.turnSuccessRate).padStart(7)}   ${c.fanoutTurns.toFixed(1).padStart(13)}   ` +
				`${usd(c.listEquivalentUsd).padStart(10)}   ${usd(c.fanoutListEquivalentUsd).padStart(10)}   ${usd(c.listUsdPerExtraSolve).padStart(14)}`,
		);
	}
	out.push("");
	return `${out.join("\n")}\n`;
}

export interface ConfidenceCell {
	minConfidence: number;
	turns: number;
	tierAccuracy: number;
	classifierAccuracy: number;
	turnSuccessRate: number;
	switches: number;
	coldTurns: number;
	listEquivalentUsd: number;
	coldPremiumUsd: number;
	/** Turns the bar suppressed, and how many of those the classifier had right. */
	suppressed: number;
	suppressedCorrect: number;
}

/**
 * What the routing confidence bar buys. `switching.minConfidence` keeps the current
 * model whenever the classifier is unsure; it is a shipped knob and, until this sweep,
 * an unmeasured one. Raising it trades routing accuracy for fewer switches - which is
 * only a good trade if switches are expensive, and rounds 4-7 established that they are.
 */
export async function runConfidenceSweep(options: SweepOptions & { bars?: number[] }): Promise<ConfidenceCell[]> {
	const bars = options.bars ?? [0, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
	const cells: ConfidenceCell[] = [];
	for (const minConfidence of bars) {
		const loaded: LoadedFleet = {
			...options.loaded,
			config: mergeConfig(options.loaded.config, { switching: { ...options.loaded.config.switching, minConfidence } }),
		};
		const outcome = await runEval({ pack: options.pack, loaded, classifier: options.classifier, startModel: options.startModel });
		const m = computeMetrics(outcome.turns, outcome.stateChars);
		const cal = computeCalibration(outcome.turns, minConfidence);
		cells.push({
			minConfidence,
			turns: m.turns,
			tierAccuracy: m.tierAccuracy,
			classifierAccuracy: m.classifierAccuracy,
			turnSuccessRate: m.turnSuccessRate,
			switches: m.switches,
			coldTurns: m.coldTurns,
			listEquivalentUsd: m.listEquivalentUsd,
			coldPremiumUsd: m.coldPremiumUsd,
			suppressed: cal.suppressed,
			suppressedCorrect: cal.suppressedCorrect,
		});
	}
	return cells;
}

export function renderConfidenceSweep(cells: ConfidenceCell[], title: string): string {
	const out: string[] = ["", title, ""];
	out.push("  minConf   landed   classifier   turn ok   switches   cold      list $   cold prem   suppressed (correct)");
	for (const c of cells) {
		out.push(
			`  ${c.minConfidence.toFixed(2).padStart(7)}   ${pct(c.tierAccuracy).padStart(6)}   ${pct(c.classifierAccuracy).padStart(10)}   ${pct(c.turnSuccessRate).padStart(7)}   ` +
				`${String(c.switches).padStart(8)}   ${`${c.coldTurns}/${c.turns}`.padStart(5)}   ${usd(c.listEquivalentUsd).padStart(9)}   ${usd(c.coldPremiumUsd).padStart(9)}   ` +
				`${`${c.suppressed} (${c.suppressedCorrect})`.padStart(20)}`,
		);
	}
	out.push("");
	return `${out.join("\n")}\n`;
}

export interface OracleCell {
	jitter: number;
	seeds: number;
	/** turnSuccessRate per classifier, meaned over seeds. */
	scripted: number;
	heuristic: number;
	oracle: number;
	scriptedSpread: number;
	oracleSpread: number;
	/** Share of seeds where the never-switching profile still beat perfect routing. */
	heuristicBeatsOracle: number;
	/** Share of seeds where perfect routing still spent more than never switching. */
	oracleCostsMore: number;
}

/**
 * How much the conclusions depend on the declared competence oracle.
 *
 * `skill` and `skillByCategory` are the harness's largest assumption: everything it
 * says about quality rests on them, and they are written by hand. This sweep jitters
 * every model's skill by up to ±`jitter` points — which also moves the derived
 * `goldTier` labels, exactly as it should — and asks whether round 4's qualitative
 * findings survive being wrong about the fleet.
 */
export async function runOracleSweep(options: SweepOptions & { jitters?: number[] }): Promise<OracleCell[]> {
	const jitters = options.jitters ?? [0, 5, 10, 20];
	const seeds = options.seeds ?? DEFAULT_SEEDS;
	const cells: OracleCell[] = [];

	for (const jitter of jitters) {
		const scripted: number[] = [];
		const heuristic: number[] = [];
		const oracle: number[] = [];
		let heuristicWins = 0;
		let oracleDearer = 0;

		for (const seed of seeds) {
			const loaded = jitter === 0 ? options.loaded : buildFleet(perturbFleet(options.loaded.fleet, jitter, seed));
			const run = async (classifier: ClassifierMode) => {
				const outcome = await runEval({ pack: options.pack, loaded, classifier, startModel: options.startModel });
				return computeMetrics(outcome.turns, outcome.stateChars);
			};
			const [s, h, o] = [await run("scripted"), await run("heuristic"), await run("oracle")];
			scripted.push(s.turnSuccessRate);
			heuristic.push(h.turnSuccessRate);
			oracle.push(o.turnSuccessRate);
			if (h.turnSuccessRate > o.turnSuccessRate) heuristicWins += 1;
			if (o.listEquivalentUsd > h.listEquivalentUsd) oracleDearer += 1;
		}

		cells.push({
			jitter,
			seeds: seeds.length,
			scripted: mean(scripted),
			heuristic: mean(heuristic),
			oracle: mean(oracle),
			scriptedSpread: spread(scripted),
			oracleSpread: spread(oracle),
			heuristicBeatsOracle: round(heuristicWins / seeds.length, 4),
			oracleCostsMore: round(oracleDearer / seeds.length, 4),
		});
	}
	return cells;
}

/** Deterministic ±`jitter` on every model's skill, keeping it inside 1..100. */
export function perturbFleet(fleet: Fleet, jitter: number, seed: string): Fleet {
	return {
		...fleet,
		models: fleet.models.map((m) => ({
			...m,
			skill: Math.max(1, Math.min(100, Math.round(m.skill + (hashUnit(seed, "skill", m.key) * 2 - 1) * jitter))),
		})),
	};
}

export function renderOracleSweep(cells: OracleCell[], title: string): string {
	const out: string[] = ["", title, ""];
	out.push("  jitter        scripted       heuristic          oracle   heuristic>oracle   oracle costs more");
	for (const c of cells) {
		out.push(
			`  ${`±${c.jitter}`.padStart(6)}   ${`${pct(c.scripted)} ±${pct(c.scriptedSpread)}`.padStart(13)}   ${pct(c.heuristic).padStart(13)}   ` +
				`${`${pct(c.oracle)} ±${pct(c.oracleSpread)}`.padStart(13)}   ${`${Math.round(c.heuristicBeatsOracle * c.seeds)}/${c.seeds}`.padStart(16)}   ` +
				`${`${Math.round(c.oracleCostsMore * c.seeds)}/${c.seeds}`.padStart(17)}`,
		);
	}
	out.push("");
	return `${out.join("\n")}\n`;
}

function spread(values: number[]): number {
	return round((Math.max(...values) - Math.min(...values)) / 2, 4);
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
