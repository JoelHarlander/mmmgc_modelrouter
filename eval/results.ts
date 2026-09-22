/**
 * Results: one JSON per run, a `latest-<profile>.json` pointer the next run
 * compares against, and a dated markdown log so rounds can be read in order.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunMetrics } from "./metrics.ts";
import type { TurnRecord } from "./types.ts";

export interface RunRecord {
	version: 1;
	runId: string;
	at: string;
	profile: string;
	pack: string;
	fleet: string;
	classifier: string;
	candidateN: number;
	judge: string;
	seed: string;
	startModel: string;
	live: boolean;
	git?: string;
	metrics: RunMetrics;
	/**
	 * Per-turn detail. Present in the per-run file and **omitted from the committed
	 * `latest-<profile>.json` baseline**, which exists only to be compared against: the
	 * gate and `--compare` read `metrics` and nothing else, and the turn records are two
	 * orders of magnitude larger than the numbers they support.
	 */
	turns?: TurnRecord[];
}

export function resultsDir(root: string): string {
	return join(root, "eval", "results");
}

export function latestPath(root: string, profile: string): string {
	return join(resultsDir(root), `latest-${profile}.json`);
}

/**
 * `updateLatest: false` keeps the recorded baseline where it is. A gated run that
 * regressed must not become the thing the next run is judged against, or the gate only
 * ever fires once and the regression quietly becomes the new normal.
 */
export function writeRun(root: string, record: RunRecord, options: { updateLatest?: boolean } = {}): { runPath: string; latestPath?: string } {
	const dir = resultsDir(root);
	mkdirSync(dir, { recursive: true });
	const runPath = join(dir, `${record.runId}.json`);
	writeFileSync(runPath, `${JSON.stringify(record, replacer, "\t")}\n`);
	if (options.updateLatest === false) return { runPath };
	const latest = latestPath(root, record.profile);
	const { turns: _turns, ...baseline } = record;
	writeFileSync(latest, `${JSON.stringify(baseline, replacer, "\t")}\n`);
	return { runPath, latestPath: latest };
}

export function readRun(path: string): RunRecord | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"), reviver) as RunRecord;
	} catch {
		return undefined;
	}
}

/** JSON has no Infinity; keep it readable and round-trippable. */
function replacer(_key: string, value: unknown): unknown {
	return value === Number.POSITIVE_INFINITY ? "Infinity" : value;
}

function reviver(_key: string, value: unknown): unknown {
	return value === "Infinity" ? Number.POSITIVE_INFINITY : value;
}

/** Metrics where a larger number is better. Everything else is judged the other way. */
const HIGHER_IS_BETTER = new Set([
	"taskResolveRate",
	"medianTaskTurnSuccess",
	"worstTaskTurnSuccess",
	"turnSuccessRate",
	"sessionSuccessRate",
	"tierAccuracy",
	"classifierAccuracy",
	"baselineSuccessRate",
	"judgeSuccessRate",
	"oracleSuccessRate",
	"judgeLift",
	"adoptedSuccessRate",
	"adoptedLift",
	"gateRescueRate",
	"judgeHeadroomCaptured",
	"judgeRecall",
]);

/** Metrics that are descriptive rather than good or bad. */
const NEUTRAL = new Set(["tasks", "turns", "routedTurns", "pinnedTurns", "avgStateChars", "avgCandidates", "tierEscalations", "gatedTurns"]);

export interface MetricDelta {
	key: string;
	previous: number;
	current: number;
	delta: number;
	direction: "better" | "worse" | "same" | "neutral";
}

export function compareMetrics(previous: RunMetrics | undefined, current: RunMetrics): MetricDelta[] {
	if (!previous) return [];
	const out: MetricDelta[] = [];
	const walk = (prev: Record<string, unknown>, cur: Record<string, unknown>, prefix: string) => {
		for (const [key, value] of Object.entries(cur)) {
			if (typeof value === "number") {
				const before = prev[key];
				if (typeof before !== "number") continue;
				// Infinity means "this never happened"; differencing it produces NaN, not news.
				if (!Number.isFinite(value) || !Number.isFinite(before)) continue;
				const delta = value - before;
				const name = prefix + key;
				let direction: MetricDelta["direction"] = "same";
				if (NEUTRAL.has(key)) direction = "neutral";
				else if (Math.abs(delta) < 1e-9) direction = "same";
				else direction = HIGHER_IS_BETTER.has(key) === delta > 0 ? "better" : "worse";
				out.push({ key: name, previous: before, current: value, delta, direction });
			} else if (value && typeof value === "object" && !Array.isArray(value) && key === "candidate") {
				const before = prev[key];
				if (before && typeof before === "object") walk(before as Record<string, unknown>, value as Record<string, unknown>, "candidate.");
			}
		}
	};
	walk(previous as unknown as Record<string, unknown>, current as unknown as Record<string, unknown>, "");
	return out;
}

/**
 * The small set of metrics a regression should actually fail on. Gating everything
 * turns the gate into noise; these are the numbers a routing change is trying to move.
 *
 * `kind` says how the tolerance is read: `rate` in absolute points, `relative` as a
 * fraction of the baseline, `absolute` as a raw count.
 */
export const GATED_METRICS: { key: string; kind: "rate" | "relative" | "absolute"; tolerance: number }[] = [
	{ key: "ineligibleChoices", kind: "absolute", tolerance: 0 },
	{ key: "turnSuccessRate", kind: "rate", tolerance: 0.02 },
	{ key: "sessionSuccessRate", kind: "rate", tolerance: 0.02 },
	{ key: "tierAccuracy", kind: "rate", tolerance: 0.02 },
	{ key: "listEquivalentUsd", kind: "relative", tolerance: 0.05 },
	{ key: "coldPremiumUsd", kind: "relative", tolerance: 0.05 },
	{ key: "wallClockSeconds", kind: "relative", tolerance: 0.05 },
	{ key: "candidate.adoptedLift", kind: "rate", tolerance: 0.02 },
];

export interface GateFailure {
	key: string;
	previous: number;
	current: number;
	delta: number;
	tolerance: number;
	kind: string;
}

/**
 * Which gated metrics moved the wrong way by more than their tolerance. An empty list
 * means the run is no worse than the one it was compared against.
 */
export function gateRegressions(deltas: MetricDelta[], scale = 1): GateFailure[] {
	const byKey = new Map(deltas.map((d) => [d.key, d]));
	const failures: GateFailure[] = [];
	for (const gate of GATED_METRICS) {
		const delta = byKey.get(gate.key);
		if (!delta || delta.direction !== "worse") continue;
		const tolerance = gate.tolerance * scale;
		const magnitude = gate.kind === "relative" ? Math.abs(delta.delta) / Math.max(1e-9, Math.abs(delta.previous)) : Math.abs(delta.delta);
		if (magnitude > tolerance) {
			failures.push({ key: gate.key, previous: delta.previous, current: delta.current, delta: delta.delta, tolerance, kind: gate.kind });
		}
	}
	return failures;
}

export function appendLog(root: string, line: string): string {
	const dir = resultsDir(root);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "log.md");
	if (!existsSync(path)) {
		writeFileSync(
			path,
			"# Router eval rounds\n\nOne line per round: what it measured, what changed, and what the numbers did.\nAppended by `npm run eval`; round notes are added by hand.\n\n",
		);
	}
	const current = readFileSync(path, "utf8");
	writeFileSync(path, `${current}${current.endsWith("\n") ? "" : "\n"}${line}\n`);
	return path;
}

/** Previous run records for a profile, newest first, excluding the `latest-` pointer. */
export function listRuns(root: string, profile: string): string[] {
	const dir = resultsDir(root);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json") && !f.startsWith("latest-") && f.includes(`-${profile}-`))
		.sort()
		.reverse()
		.map((f) => join(dir, f));
}

export function ensureDirFor(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
}
