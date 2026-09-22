/**
 * Invariant coverage: visit many configurations and check what must always be true.
 *
 * Round 26's lesson, paid for the hard way. `ineligibleChoices` was built in round 1 to
 * catch the router selecting a blocked, unauthed or unknown model. It read 0 in every
 * profile of every round for twenty-five rounds — not because the router never did it,
 * but because every profile started the session on the same model, and the one state
 * where it does it was never visited. A detector only fires in the states you enter.
 *
 * So: enumerate a cross-product of the configurations a real installation can be in —
 * starting model, classifier, billing arrangement, confidence bar, pin length, and a
 * provider being unauthed — and assert the harness's invariants in each. Report every
 * configuration that breaks one, with enough detail to reproduce it.
 *
 * A violation here is not necessarily a harness bug. Round 26's was a router bug, found
 * this way and reported rather than fixed.
 */
import { mergeConfig } from "../src/config.ts";
import { buildFleet, type LoadedFleet } from "./fleet.ts";
import { runEval } from "./harness.ts";
import { computeMetrics, type RunMetrics } from "./metrics.ts";
import type { ClassifierMode, TaskPack, TurnRecord } from "./types.ts";

export interface Configuration {
	startModel: string;
	classifier: ClassifierMode;
	billing: "as-configured" | "all-on-demand" | "all-plan";
	minConfidence: number;
	manualPinTurns: number;
	unauthed: string[];
}

export interface Violation {
	invariant: string;
	detail: string;
	reproduce: string;
}

export interface CoverageReport {
	configurations: number;
	violations: { configuration: Configuration; violations: Violation[] }[];
	/** Invariant name → how many configurations broke it. */
	byInvariant: Record<string, number>;
}

export interface CoverageOptions {
	pack: TaskPack;
	loaded: LoadedFleet;
	startModels?: string[];
	classifiers?: ClassifierMode[];
	billings?: Configuration["billing"][];
	minConfidences?: number[];
	pinTurns?: number[];
	unauthedSets?: string[][];
}

export async function runCoverage(options: CoverageOptions): Promise<CoverageReport> {
	const startModels = options.startModels ?? [...options.loaded.byKey.keys()];
	const classifiers = options.classifiers ?? (["scripted", "heuristic", "oracle"] as ClassifierMode[]);
	const billings = options.billings ?? (["as-configured", "all-on-demand"] as Configuration["billing"][]);
	const minConfidences = options.minConfidences ?? [0, 0.5, 0.8];
	const pinTurns = options.pinTurns ?? [0, 3];
	const unauthedSets = options.unauthedSets ?? [[], ["faux-plan-anthropic/claude-opus-5"]];

	const report: CoverageReport = { configurations: 0, violations: [], byInvariant: {} };

	for (const startModel of startModels) {
		for (const classifier of classifiers) {
			for (const billing of billings) {
				for (const minConfidence of minConfidences) {
					for (const manualPinTurns of pinTurns) {
						for (const unauthed of unauthedSets) {
							if (unauthed.includes(startModel)) continue; // a session cannot start where it cannot go
							const configuration: Configuration = { startModel, classifier, billing, minConfidence, manualPinTurns, unauthed };
							const base = buildFleet(options.loaded.fleet, { billing, unauthed });
							const loaded: LoadedFleet = {
								...base,
								config: mergeConfig(base.config, { switching: { ...base.config.switching, minConfidence, manualPinTurns } }),
							};
							const outcome = await runEval({ pack: options.pack, loaded, classifier, startModel });
							const metrics = computeMetrics(outcome.turns, outcome.stateChars);
							report.configurations += 1;

							const violations = check(outcome.turns, metrics, configuration);
							if (violations.length > 0) {
								report.violations.push({ configuration, violations });
								for (const v of violations) report.byInvariant[v.invariant] = (report.byInvariant[v.invariant] ?? 0) + 1;
							}
						}
					}
				}
			}
		}
	}
	return report;
}

function check(turns: TurnRecord[], m: RunMetrics, configuration: Configuration): Violation[] {
	const out: Violation[] = [];
	const repro = reproduce(configuration);
	const add = (invariant: string, detail: string) => out.push({ invariant, detail, reproduce: repro });

	// The one that matters: the router must never hand a turn to a model that is
	// unauthed, blocked by the ledger, or not in the fleet at all.
	const ineligible = turns.filter((t) => !t.eligible);
	if (ineligible.length > 0) {
		const first = ineligible[0]!;
		add("eligible-route", `${ineligible.length} turn(s), first ${first.taskId} t${first.turn}: ${first.ineligibleReason} — "${first.reason}"`);
	}

	// Structural properties of the metric set. A breach here is a harness bug.
	const tierSum = m.tierAccuracy + m.underRouteRate + m.overRouteRate;
	if (Math.abs(tierSum - 1) > 1e-3) add("tier-partition", `tierAccuracy + under + over = ${tierSum.toFixed(4)}, not 1`);
	for (const [name, value] of Object.entries(m)) {
		if (typeof value !== "number") continue;
		if (Number.isNaN(value)) add("no-nan", `${name} is NaN`);
		if (name.endsWith("Usd") && value < 0) add("non-negative-cost", `${name} = ${value}`);
		if (name.endsWith("Rate") && (value < 0 || value > 1)) add("rate-in-range", `${name} = ${value}`);
	}
	if (m.wallClockSeconds <= 0) add("positive-wall-clock", `wallClockSeconds = ${m.wallClockSeconds}`);

	for (const turn of turns) {
		// A compaction rewrites the prefix, so it can never leave a turn warm.
		if (turn.compaction && !turn.cold) add("compaction-is-cold", `${turn.taskId} t${turn.turn} compacted but stayed warm`);
		// A cold turn cannot be cheaper than the same turn warm.
		if (turn.cold && turn.listEquivalentUsd < turn.warmListEquivalentUsd - 1e-9) {
			add("cold-costs-more", `${turn.taskId} t${turn.turn}: cold $${turn.listEquivalentUsd} < warm $${turn.warmListEquivalentUsd}`);
		}
		// A pinned turn never consulted the classifier, so it cannot have been billed for one.
		if (turn.pinned && turn.classifierCostUsd > 0) add("pinned-costs-nothing", `${turn.taskId} t${turn.turn} was pinned and billed`);
	}
	return out;
}

export function reproduce(c: Configuration): string {
	const bits = [`--start-model ${c.startModel}`, `--classifier ${c.classifier}`];
	if (c.billing !== "as-configured") bits.push(`--billing ${c.billing}`);
	bits.push(`--judge-min-confidence ${c.minConfidence}`);
	for (const key of c.unauthed) bits.push(`--no-auth ${key}`);
	return `npm run eval -- ${bits.join(" ")}`;
}

export function renderCoverage(report: CoverageReport, title: string): string {
	const out: string[] = ["", title, ""];
	out.push(`  ${report.configurations} configurations visited, ${report.violations.length} with a broken invariant`);
	out.push("");
	if (report.violations.length === 0) {
		out.push("  every invariant held everywhere visited");
		out.push("");
		return `${out.join("\n")}\n`;
	}
	for (const [invariant, count] of Object.entries(report.byInvariant).sort((a, b) => b[1] - a[1])) {
		out.push(`  ${invariant.padEnd(22)} broken in ${count} configuration(s)`);
	}
	out.push("");
	// One worked example per invariant is enough to act on; the rest are the same shape.
	const seen = new Set<string>();
	for (const entry of report.violations) {
		for (const v of entry.violations) {
			if (seen.has(v.invariant)) continue;
			seen.add(v.invariant);
			out.push(`  ${v.invariant}`);
			out.push(`    ${v.detail}`);
			out.push(`    ${v.reproduce}`);
			out.push("");
		}
	}
	return `${out.join("\n")}\n`;
}
