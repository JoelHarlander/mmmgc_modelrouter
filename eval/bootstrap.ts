/**
 * How much is one of these numbers actually worth?
 *
 * The long pack is six tasks and the short one fifteen. Every round has quoted rates to
 * one decimal place off that, which invites more confidence than the sample supports —
 * and the most obvious objection to twenty rounds of findings is "your pack is small".
 *
 * This answers it rather than deflecting it. Resample the pack's **tasks** with
 * replacement, recompute the metrics from the recorded turns each time, and report the
 * middle 95% of the resulting distribution. Tasks are the sampling unit because turns
 * within a task are not independent: a session that goes wrong early goes on being
 * wrong, which is exactly the correlation a turn-level bootstrap would hide.
 *
 * It resamples what the run recorded, so it costs no extra runs.
 */
import { computeMetrics, type RunMetrics } from "./metrics.ts";
import { hashUnit } from "./simulate.ts";
import type { TurnRecord } from "./types.ts";

export interface Interval {
	point: number;
	low: number;
	high: number;
	/** Half the 95% interval's width, which is the "± x" a number should be quoted with. */
	halfWidth: number;
}

export interface BootstrapReport {
	tasks: number;
	resamples: number;
	sessionSuccessRate: Interval;
	turnSuccessRate: Interval;
	tierAccuracy: Interval;
	listEquivalentUsd: Interval;
	coldPremiumShare: Interval;
	adoptedLift?: Interval;
}

const METRICS = ["sessionSuccessRate", "turnSuccessRate", "tierAccuracy", "listEquivalentUsd", "coldPremiumShare"] as const;

export function bootstrap(turns: TurnRecord[], resamples = 1000, seed = "bootstrap"): BootstrapReport {
	const byTask = new Map<string, TurnRecord[]>();
	for (const turn of turns) byTask.set(turn.taskId, [...(byTask.get(turn.taskId) ?? []), turn]);
	const tasks = [...byTask.values()];

	const point = computeMetrics(turns, []);
	const samples: Record<string, number[]> = { adoptedLift: [] };
	for (const key of METRICS) samples[key] = [];

	for (let i = 0; i < resamples; i++) {
		const drawn: TurnRecord[] = [];
		for (let j = 0; j < tasks.length; j++) {
			const pick = Math.floor(hashUnit(seed, i, j) * tasks.length);
			// Re-key the copy so tasks drawn twice stay distinct for the per-task metrics.
			const chosen = tasks[Math.min(pick, tasks.length - 1)]!;
			for (const turn of chosen) drawn.push({ ...turn, taskId: `${turn.taskId}#${j}` });
		}
		const m = computeMetrics(drawn, []);
		for (const key of METRICS) samples[key]!.push(m[key]);
		if (m.candidate) samples.adoptedLift!.push(m.candidate.adoptedLift);
	}

	const report: BootstrapReport = {
		tasks: tasks.length,
		resamples,
		sessionSuccessRate: interval(point.sessionSuccessRate, samples.sessionSuccessRate!),
		turnSuccessRate: interval(point.turnSuccessRate, samples.turnSuccessRate!),
		tierAccuracy: interval(point.tierAccuracy, samples.tierAccuracy!),
		listEquivalentUsd: interval(point.listEquivalentUsd, samples.listEquivalentUsd!),
		coldPremiumShare: interval(point.coldPremiumShare, samples.coldPremiumShare!),
	};
	if (point.candidate && samples.adoptedLift!.length > 0) {
		report.adoptedLift = interval(point.candidate.adoptedLift, samples.adoptedLift!);
	}
	return report;
}

function interval(point: number, samples: number[]): Interval {
	const sorted = [...samples].sort((a, b) => a - b);
	const low = percentile(sorted, 0.025);
	const high = percentile(sorted, 0.975);
	return { point: round(point), low: round(low), high: round(high), halfWidth: round((high - low) / 2) };
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
	return sorted[index]!;
}

function round(n: number): number {
	return Math.round(n * 1e4) / 1e4;
}

/**
 * Tasks needed to resolve a difference of `target`, from an interval measured on `tasks`.
 * A 95% half-width shrinks as 1/sqrt(n), so this is the honest answer to "how much
 * bigger would the pack have to be before that number meant something?".
 */
export function tasksNeededFor(target: number, halfWidth: number, tasks: number): number {
	if (target <= 0 || halfWidth <= 0) return Number.POSITIVE_INFINITY;
	return Math.ceil(tasks * (halfWidth / target) ** 2);
}

export interface PairedResult {
	metric: string;
	/** A − B on the full pack. */
	point: number;
	low: number;
	high: number;
	/** True when the whole 95% interval is on one side of zero. */
	significant: boolean;
	halfWidth: number;
	tasks: number;
}

/**
 * The comparison the findings actually rest on.
 *
 * A single run's interval is wide because six tasks is six tasks. But every claim in
 * the log is of the form "A beats B **on the same tasks**", and that is a *paired*
 * comparison: resample the tasks, take A − B within each resample, and the shared
 * task-difficulty variance cancels. A difference whose interval excludes zero is a
 * result; one whose interval straddles zero is a number.
 *
 * Both runs must cover the same tasks, which they do whenever they used the same pack.
 */
export function bootstrapDifference(
	a: TurnRecord[],
	b: TurnRecord[],
	metrics: readonly string[] = ["sessionSuccessRate", "listEquivalentUsd"],
	resamples = 1000,
	seed = "paired",
): PairedResult[] {
	const groupA = groupByTask(a);
	const groupB = groupByTask(b);
	const ids = [...groupA.keys()].filter((id) => groupB.has(id));
	if (ids.length === 0) throw new Error("the two runs share no tasks; a paired comparison needs the same pack");

	const pick = (get: Map<string, TurnRecord[]>, drawn: string[]) =>
		computeMetrics(
			drawn.flatMap((id, j) => get.get(id)!.map((t) => ({ ...t, taskId: `${id}#${j}` }))),
			[],
		) as unknown as Record<string, number>;

	const pointA = pick(groupA, ids);
	const pointB = pick(groupB, ids);
	const samples = new Map<string, number[]>(metrics.map((m) => [m, []]));

	for (let i = 0; i < resamples; i++) {
		const drawn = ids.map((_, j) => ids[Math.min(Math.floor(hashUnit(seed, i, j) * ids.length), ids.length - 1)]!);
		const ma = pick(groupA, drawn);
		const mb = pick(groupB, drawn);
		for (const metric of metrics) samples.get(metric)!.push((ma[metric] ?? 0) - (mb[metric] ?? 0));
	}

	return metrics.map((metric) => {
		const sorted = [...samples.get(metric)!].sort((x, y) => x - y);
		const low = percentile(sorted, 0.025);
		const high = percentile(sorted, 0.975);
		return {
			metric,
			point: round((pointA[metric] ?? 0) - (pointB[metric] ?? 0)),
			low: round(low),
			high: round(high),
			significant: (low > 0 && high > 0) || (low < 0 && high < 0),
			halfWidth: round((high - low) / 2),
			tasks: ids.length,
		};
	});
}

function groupByTask(turns: TurnRecord[]): Map<string, TurnRecord[]> {
	const out = new Map<string, TurnRecord[]>();
	for (const turn of turns) out.set(turn.taskId, [...(out.get(turn.taskId) ?? []), turn]);
	return out;
}

export function renderPaired(results: PairedResult[], label: string): string {
	const out: string[] = [`  ${label}`];
	for (const r of results) {
		const fmt = r.metric.toLowerCase().includes("usd") ? (n: number) => `$${n.toFixed(2)}` : (n: number) => `${(n * 100).toFixed(1)}pp`;
		out.push(
			`    ${r.metric.padEnd(20)} ${signed(r.point, fmt).padStart(10)}   95% [${signed(r.low, fmt)}, ${signed(r.high, fmt)}]   ` +
				`${r.significant ? "significant" : "NOT significant"}`,
		);
	}
	return out.join("\n");
}

function signed(n: number, fmt: (n: number) => string): string {
	return n >= 0 ? `+${fmt(n)}` : fmt(n);
}

export function renderBootstrap(report: BootstrapReport, label: string): string {
	const out: string[] = ["", `bootstrap — ${label}`, ""];
	out.push(`  ${report.resamples} resamples of ${report.tasks} tasks, drawn with replacement; 95% interval`);
	out.push("");
	out.push("  metric                      point        95% interval          ±");
	const row = (name: string, iv: Interval, fmt: (n: number) => string) =>
		out.push(`  ${name.padEnd(24)} ${fmt(iv.point).padStart(9)}   ${`${fmt(iv.low)} – ${fmt(iv.high)}`.padStart(19)}   ${fmt(iv.halfWidth).padStart(8)}`);
	row("session success", report.sessionSuccessRate, pct);
	row("turn success", report.turnSuccessRate, pct);
	row("tier accuracy", report.tierAccuracy, pct);
	row("cold premium share", report.coldPremiumShare, pct);
	row("list cost", report.listEquivalentUsd, usd);
	if (report.adoptedLift) row("adopted lift", report.adoptedLift, pct);
	out.push("");
	out.push("  a difference smaller than ± is not a result on this pack, however many decimals it has.");
	out.push("");
	return `${out.join("\n")}\n`;
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function usd(n: number): string {
	return Number.isFinite(n) ? `$${n.toFixed(2)}` : "n/a";
}
