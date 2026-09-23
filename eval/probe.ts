/**
 * The judge probe.
 *
 * `--sweep bias` answers "what does N points of judge bias cost?". It does not answer
 * "how many points does Jev have?", and rounds 3 and 5 both closed on that gap.
 *
 * The probe answers it directly and cheaply. Each item is a request with two written
 * responses whose true quality is declared and whose *presentation* is deliberately
 * opposed: on a trap item the worse answer is the confident, well-formatted, heavily
 * hedged one. A judge is shown both, in both label orders, and the probe reports how
 * often it fell for the presentation.
 *
 * It costs one Jev call per item per order and no model inference at all, so it can be
 * pointed at live Jev for a fraction of a cent. Offline it runs against `NoisyJudge`,
 * which is how the probe itself is tested: a judge with a known bias must be detected
 * as having roughly that bias.
 */
import { readFileSync } from "node:fs";
import type { BiasAxis, Judge, JudgeCandidate } from "./candidates.ts";
import { NoisyJudge } from "./candidates.ts";

export interface ProbeResponse {
	key: string;
	text: string;
	/** Declared true quality on the fleet's skill ladder. */
	trueSkill: number;
	/** How much this response looks like the expensive model's answer. */
	flashiness: number;
}

export interface ProbeItem {
	id: string;
	category: string;
	/**
	 * trap = the flashier response is the worse one; aligned = it is the better one;
	 * near-tie = there is nothing to choose. `axis-split` items set length and
	 * presentation against *each other*, which is what makes the two separable: in every
	 * other item the flashier answer is also the longer one.
	 */
	kind: "trap" | "aligned" | "near-tie" | "axis-split";
	request: string;
	responses: [ProbeResponse, ProbeResponse];
	note?: string;
}

export interface ProbePack {
	version: 1;
	id: string;
	description: string;
	items: ProbeItem[];
}

export interface ProbeItemResult {
	id: string;
	kind: ProbeItem["kind"];
	/** One entry per label order, so position and presentation can be told apart. */
	picks: {
		order: "AB" | "BA";
		pickedKey: string;
		pickedLabel: string;
		correct: boolean;
		pickedFlashier: boolean;
		pickedLonger: boolean;
		/** True when the flashier / longer response is the *worse* one on this item. */
		presentationTrap: boolean;
		lengthTrap: boolean;
		confidence: number;
	}[];
	costUsd: number;
}

export interface ProbeReport {
	judge: string;
	items: number;
	calls: number;
	/** Share of all presentations where the judge picked the genuinely better response. */
	accuracy: number;
	/** Share of *trap* presentations where the judge took the flashier, worse answer. */
	styleTrapRate: number;
	/**
	 * The same rate computed per axis, over the presentations where that axis points at
	 * the worse answer. Round 29 made this the question that matters: a candidate set can
	 * be robust to a price-axis bias and actively harmful under a length-axis one, so a
	 * magnitude alone does not tell you which fan-out to prefer.
	 */
	byAxis: Record<"presentation" | "length", { presentations: number; trapRate: number; estimatedBiasPoints: number }>;
	/**
	 * Which axis the judge's preference runs on, and by how many points. This is the
	 * actionable half of the reading: round 29 showed a candidate set can be robust to a
	 * price/presentation bias and actively harmful under a length one, so the magnitude
	 * alone does not say which fan-out to prefer. "none" when there is no bias to place.
	 */
	dominantAxis: "presentation" | "length" | "none";
	axisMarginPoints: number;
	/** Share of *aligned* presentations the judge got right: a control on the above. */
	alignedAccuracy: number;
	/** |P(picks label A) - 0.5| across both orders. Non-zero means position, not quality. */
	positionBias: number;
	/** styleTrapRate expressed in the skill points `--sweep bias` is denominated in. */
	estimatedBiasPoints: number;
	meanConfidence: number;
	costUsd: number;
	results: ProbeItemResult[];
}

/** Verbosity is the response's own length: objective, and nothing extra to declare. */
function toCandidate(r: ProbeResponse, i: number): JudgeCandidate {
	return { label: String.fromCharCode(65 + i), key: r.key, text: r.text, trueSkill: r.trueSkill, flashiness: r.flashiness, verbosity: r.text.length };
}

export function loadProbePack(path: string): ProbePack {
	const pack = JSON.parse(readFileSync(path, "utf8")) as ProbePack;
	if (pack.version !== 1) throw new Error(`${path}: unsupported probe version ${pack.version}`);
	return pack;
}

export async function runProbe(judge: Judge, pack: ProbePack): Promise<ProbeReport> {
	const results: ProbeItemResult[] = [];
	let pickedA = 0;
	let calls = 0;
	let confidenceTotal = 0;

	for (const item of pack.items) {
		const result: ProbeItemResult = { id: item.id, kind: item.kind, picks: [], costUsd: 0 };
		// Both orders: a judge that always picks the first option is biased about
		// position, not presentation, and the two must not be confused.
		for (const order of ["AB", "BA"] as const) {
			const ordered = order === "AB" ? item.responses : ([item.responses[1], item.responses[0]] as const);
			const candidates: JudgeCandidate[] = ordered.map(toCandidate);
			const verdict = await judge.pick(item.request, candidates, { taskId: `${item.id}:${order}`, turn: 1 });
			const picked = candidates.find((c) => c.label === verdict.pick) ?? candidates[0]!;
			const best = [...candidates].sort((a, b) => b.trueSkill - a.trueSkill)[0]!;
			const flashiest = [...candidates].sort((a, b) => (b.flashiness ?? 0) - (a.flashiness ?? 0))[0]!;
			const longest = [...candidates].sort((a, b) => (b.verbosity ?? 0) - (a.verbosity ?? 0))[0]!;
			result.picks.push({
				order,
				pickedKey: picked.key,
				pickedLabel: picked.label,
				correct: picked.key === best.key,
				pickedFlashier: picked.key === flashiest.key,
				pickedLonger: picked.key === longest.key,
				// Which axes actually point away from the better answer here.
				presentationTrap: flashiest.key !== best.key,
				lengthTrap: longest.key !== best.key,
				confidence: verdict.confidence,
			});
			result.costUsd += verdict.costUsd;
			if (picked.label === "A") pickedA += 1;
			confidenceTotal += verdict.confidence;
			calls += 1;
		}
		results.push(result);
	}

	const allPicks = results.flatMap((r) => r.picks.map((p) => ({ ...p, kind: r.kind })));
	const traps = allPicks.filter((p) => p.kind === "trap");
	const aligned = allPicks.filter((p) => p.kind === "aligned");
	const styleTrapRate = rate(traps.filter((p) => p.pickedFlashier).length, traps.length);

	const axisRate = (which: "presentation" | "length") => {
		const traps = allPicks.filter((p) => (which === "length" ? p.lengthTrap : p.presentationTrap));
		const fell = traps.filter((p) => (which === "length" ? p.pickedLonger : p.pickedFlashier)).length;
		return { presentations: traps.length, trapRate: rate(fell, traps.length) };
	};
	const axisReport = {
		presentation: { ...axisRate("presentation"), estimatedBiasPoints: 0 },
		length: { ...axisRate("length"), estimatedBiasPoints: 0 },
	};
	axisReport.presentation.estimatedBiasPoints = await estimateBiasPoints(pack, axisReport.presentation.trapRate, "price");
	axisReport.length.estimatedBiasPoints = await estimateBiasPoints(pack, axisReport.length.trapRate, "length");

	return {
		judge: judge.name,
		items: pack.items.length,
		calls,
		accuracy: rate(allPicks.filter((p) => p.correct).length, allPicks.length),
		styleTrapRate,
		alignedAccuracy: rate(aligned.filter((p) => p.correct).length, aligned.length),
		positionBias: round(Math.abs(pickedA / Math.max(1, calls) - 0.5), 4),
		estimatedBiasPoints: await estimateBiasPoints(pack, styleTrapRate, "price"),
		byAxis: axisReport,
		dominantAxis: Math.max(...Object.values(axisReport).map((a) => a.estimatedBiasPoints)) === 0
			? "none"
			: axisReport.presentation.estimatedBiasPoints >= axisReport.length.estimatedBiasPoints
				? "presentation"
				: "length",
		axisMarginPoints: Math.abs(axisReport.presentation.estimatedBiasPoints - axisReport.length.estimatedBiasPoints),
		meanConfidence: round(confidenceTotal / Math.max(1, calls), 4),
		costUsd: round(
			results.reduce((a, r) => a + r.costUsd, 0),
			8,
		),
		results,
	};
}

/**
 * Turn an observed trap rate into the bias units `--sweep bias` uses, by asking what
 * bias a `NoisyJudge` needs before it falls for the same probe just as often. That is
 * what makes the probe actionable: read a number here, look up what it costs there.
 */
export async function estimateBiasPoints(pack: ProbePack, observedTrapRate: number, axis: BiasAxis = "price", noise = 10): Promise<number> {
	const candidates: number[] = [];
	for (let bias = 0; bias <= 80; bias += 2) {
		const report = await simulateTrapRate(pack, bias, axis, noise);
		candidates.push(Math.abs(report - observedTrapRate));
	}
	let bestIndex = 0;
	for (let i = 1; i < candidates.length; i++) if (candidates[i]! < candidates[bestIndex]!) bestIndex = i;
	return bestIndex * 2;
}

async function simulateTrapRate(pack: ProbePack, bias: number, axis: BiasAxis, noise: number): Promise<number> {
	// Averaged over several seeds so the calibration curve is not one draw.
	const rates: number[] = [];
	for (const seed of ["c1", "c2", "c3", "c4", "c5"]) {
		const report = await runProbeRaw(new NoisyJudge({ noise, seed, bias, biasAxis: axis }), pack, axis);
		rates.push(report);
	}
	return rates.reduce((a, b) => a + b, 0) / rates.length;
}

/** Trap rate on one axis only, without recursing into calibration. */
async function runProbeRaw(judge: Judge, pack: ProbePack, axis: BiasAxis): Promise<number> {
	let traps = 0;
	let fell = 0;
	for (const item of pack.items) {
		for (const order of ["AB", "BA"] as const) {
			const ordered = order === "AB" ? item.responses : ([item.responses[1], item.responses[0]] as const);
			const candidates: JudgeCandidate[] = ordered.map(toCandidate);
			const verdict = await judge.pick(item.request, candidates, { taskId: `${item.id}:${order}`, turn: 1 });
			const picked = candidates.find((c) => c.label === verdict.pick) ?? candidates[0]!;
			const best = [...candidates].sort((a, b) => b.trueSkill - a.trueSkill)[0]!;
			const favoured =
				axis === "length"
					? [...candidates].sort((a, b) => (b.verbosity ?? 0) - (a.verbosity ?? 0))[0]!
					: [...candidates].sort((a, b) => (b.flashiness ?? 0) - (a.flashiness ?? 0))[0]!;
			if (favoured.key === best.key) continue; // not a trap on this axis
			traps += 1;
			if (picked.key === favoured.key) fell += 1;
		}
	}
	return traps === 0 ? 0 : fell / traps;
}

export function renderProbe(report: ProbeReport): string {
	const out: string[] = ["", `judge probe — ${report.judge}`, ""];
	const row = (label: string, value: string) => out.push(`  ${label.padEnd(30)}${value.padStart(10)}`);
	row("items / calls", `${report.items} / ${report.calls}`);
	row("accuracy (all)", pct(report.accuracy));
	row("accuracy (aligned control)", pct(report.alignedAccuracy));
	row("style-trap rate", pct(report.styleTrapRate));
	row("position bias", pct(report.positionBias));
	row("mean confidence", pct(report.meanConfidence));
	row("estimated bias", `${report.estimatedBiasPoints} pts`);
	row("cost", `$${report.costUsd.toFixed(6)}`);
	out.push("");
	out.push("  by axis            presentations   trap rate   estimated bias");
	for (const [name, a] of Object.entries(report.byAxis)) {
		out.push(`    ${name.padEnd(16)} ${String(a.presentations).padStart(13)}   ${pct(a.trapRate).padStart(9)}   ${`${a.estimatedBiasPoints} pts`.padStart(14)}`);
	}
	out.push("");
	out.push("  per item:");
	for (const r of report.results) {
		const picks = r.picks.map((p) => `${p.order}→${p.pickedLabel}${p.correct ? "✓" : "✗"}`).join("  ");
		out.push(`    ${r.id.padEnd(28)} ${r.kind.padEnd(9)} ${picks}`);
	}
	out.push("");
	out.push("");
	if (report.dominantAxis === "none") {
		out.push("  no bias to place on an axis.");
	} else {
		out.push(`  dominant axis: ${report.dominantAxis.toUpperCase()}, by ${report.axisMarginPoints} points.`);
		out.push(
			report.dominantAxis === "presentation"
				? "  a candidate set whose costliest-looking member is also its strongest survives this."
				: "  alignment will not help: prefer a candidate set with a high floor (see --sweep axis).",
		);
	}
	out.push("");
	out.push("  price the magnitude with `npm run eval -- --sweep bias`; choose a candidate set");
	out.push("  that survives the axis with `npm run eval -- --sweep axis`.");
	out.push("");
	return `${out.join("\n")}\n`;
}

function rate(a: number, b: number): number {
	return b === 0 ? 0 : round(a / b, 4);
}

function round(n: number, digits: number): number {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}
