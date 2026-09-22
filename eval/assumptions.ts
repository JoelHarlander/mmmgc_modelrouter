/**
 * The assumption audit.
 *
 * Round 19 withdrew a headline finding because a default nobody had swept — the model
 * the session started on — turned out to be producing it. This is the systematic
 * version of that lesson: vary every declared constant in the harness, one at a time,
 * and report how far each headline metric travels.
 *
 * Read it as "what does this harness's answer rest on?". An assumption near the top
 * moves the answer and must be quoted with any number derived from it; one near the
 * bottom does not, and a conclusion that survives it is that much stronger.
 */
import { NoisyJudge } from "./candidates.ts";
import { buildFleet, type LoadedFleet } from "./fleet.ts";
import { runEval, type RunOptions } from "./harness.ts";
import { computeMetrics, type RunMetrics } from "./metrics.ts";
import { mergeConfig } from "../src/config.ts";
import { perturbFleet } from "./sweep.ts";
import { DEFAULT_TRAFFIC } from "./simulate.ts";
import type { ClassifierMode, TaskPack } from "./types.ts";

export interface AssumptionRow {
	assumption: string;
	/** What the harness uses when nobody says otherwise. */
	shipped: string;
	values: string[];
	sessionSuccess: { min: number; max: number; spread: number };
	listEquivalentUsd: { min: number; max: number; spread: number };
	tierAccuracy: { min: number; max: number; spread: number };
	coldPremiumShare: { min: number; max: number; spread: number };
}

export interface AssumptionAuditOptions {
	pack: TaskPack;
	loaded: LoadedFleet;
	classifier: ClassifierMode;
	candidateN?: number;
}

type Variant = { label: string; run: () => Promise<RunMetrics> };

export async function auditAssumptions(options: AssumptionAuditOptions): Promise<AssumptionRow[]> {
	const { pack, loaded, classifier } = options;
	const candidateN = options.candidateN ?? 3;
	const base: RunOptions = { pack, loaded, classifier, candidateN, seed: "audit" };

	const measure = async (patch: Partial<RunOptions>): Promise<RunMetrics> => {
		const outcome = await runEval({ ...base, ...patch });
		return computeMetrics(outcome.turns, outcome.stateChars);
	};
	const withConfig = (patch: Parameters<typeof mergeConfig>[1]): LoadedFleet => ({ ...loaded, config: mergeConfig(loaded.config, patch) });

	const groups: { assumption: string; shipped: string; variants: Variant[] }[] = [
		{
			assumption: "starting model",
			shipped: "claude-opus-5 (strongest plan route)",
			variants: [...loaded.byKey.keys()].map((key) => ({ label: key.split("/").pop()!, run: () => measure({ startModel: key }) })),
		},
		{
			assumption: "fleet skill (±jitter)",
			shipped: "as declared in fleet.json",
			variants: [0, 10, 20].map((jitter) => ({
				label: `±${jitter}`,
				run: () => measure({ loaded: jitter === 0 ? loaded : buildFleet(perturbFleet(loaded.fleet, jitter, "audit")) }),
			})),
		},
		{
			assumption: "billing arrangement",
			shipped: "as configured (plan + on-demand)",
			variants: (["as-configured", "all-on-demand", "all-plan"] as const).map((billing) => ({
				label: billing,
				run: () => measure({ loaded: buildFleet(loaded.fleet, { billing, unauthed: [...loaded.unauthed] }) }),
			})),
		},
		{
			assumption: "judge error (noise)",
			shipped: "10 skill points",
			variants: [0, 10, 40, 80].map((noise) => ({
				label: String(noise),
				run: () => measure({ judge: new NoisyJudge({ noise, seed: "audit" }) }),
			})),
		},
		{
			assumption: "judge bias",
			shipped: "0 (unmeasured on live Jev)",
			variants: [0, 20, 40].map((bias) => ({
				label: String(bias),
				run: () => measure({ judge: new NoisyJudge({ noise: 10, seed: "audit", bias }) }),
			})),
		},
		{
			assumption: "judge temperature",
			shipped: "6",
			variants: [2, 6, 18].map((temperature) => ({
				label: String(temperature),
				run: () => measure({ judge: new NoisyJudge({ noise: 10, seed: "audit", temperature }) }),
			})),
		},
		{
			assumption: "calls per turn",
			shipped: `${DEFAULT_TRAFFIC.callsPerTurn} (measured median)`,
			variants: [2, 5, 20].map((callsPerTurn) => ({
				label: String(callsPerTurn),
				run: () => measure({ traffic: { ...DEFAULT_TRAFFIC, callsPerTurn } }),
			})),
		},
		{
			assumption: "compaction penalty",
			shipped: "12 skill points",
			variants: [0, 12, 40].map((compactionPenalty) => ({
				label: String(compactionPenalty),
				run: () => measure({ compactionPenalty }),
			})),
		},
		{
			assumption: "context sensitivity",
			shipped: "0.5",
			variants: [0, 0.5, 1].map((contextSensitivity) => ({
				label: contextSensitivity.toFixed(1),
				run: () => measure({ contextSensitivity }),
			})),
		},
		{
			assumption: "routing confidence bar",
			shipped: "0.50",
			variants: [0, 0.5, 0.8].map((minConfidence) => ({
				label: minConfidence.toFixed(2),
				run: () => measure({ loaded: withConfig({ switching: { ...loaded.config.switching, minConfidence } }) }),
			})),
		},
		{
			assumption: "/model pin length",
			shipped: "3 turns",
			variants: [0, 3, 10].map((manualPinTurns) => ({
				label: String(manualPinTurns),
				run: () => measure({ loaded: withConfig({ switching: { ...loaded.config.switching, manualPinTurns } }) }),
			})),
		},
		{
			assumption: "judge confidence gate",
			shipped: "switching.minConfidence (0.50)",
			variants: [0, 0.5, 0.9].map((judgeMinConfidence) => ({
				label: judgeMinConfidence.toFixed(2),
				run: () => measure({ judgeMinConfidence }),
			})),
		},
	];

	const rows: AssumptionRow[] = [];
	for (const group of groups) {
		const results: RunMetrics[] = [];
		for (const variant of group.variants) results.push(await variant.run());
		rows.push({
			assumption: group.assumption,
			shipped: group.shipped,
			values: group.variants.map((v) => v.label),
			sessionSuccess: range(results.map((m) => m.sessionSuccessRate)),
			listEquivalentUsd: range(results.map((m) => m.listEquivalentUsd)),
			tierAccuracy: range(results.map((m) => m.tierAccuracy)),
			coldPremiumShare: range(results.map((m) => m.coldPremiumShare)),
		});
	}
	// Loudest first: the assumptions a reader has to know about before quoting anything.
	return rows.sort((a, b) => b.sessionSuccess.spread - a.sessionSuccess.spread);
}

function range(values: number[]): { min: number; max: number; spread: number } {
	const min = Math.min(...values);
	const max = Math.max(...values);
	return { min: round(min), max: round(max), spread: round(max - min) };
}

function round(n: number): number {
	return Math.round(n * 1e4) / 1e4;
}

export function renderAssumptions(rows: AssumptionRow[], title: string): string {
	const out: string[] = ["", title, ""];
	out.push("  assumption                 varied over            session ok            list $        tier acc   cold share");
	for (const r of rows) {
		out.push(
			`  ${r.assumption.padEnd(26)} ${r.values.join(",").slice(0, 21).padEnd(22)} ${span(pct(r.sessionSuccess.min), pct(r.sessionSuccess.max)).padStart(17)}   ` +
				`${span(usd(r.listEquivalentUsd.min), usd(r.listEquivalentUsd.max)).padStart(15)}   ${pctSpread(r.tierAccuracy.spread).padStart(9)}   ${pctSpread(r.coldPremiumShare.spread).padStart(10)}`,
		);
	}
	out.push("");
	out.push("  ordered by how far each assumption moves session success: everything above the");
	out.push("  fold has to be quoted with any number derived from it.");
	out.push("");
	return `${out.join("\n")}\n`;
}

function span(a: string, b: string): string {
	return a === b ? a : `${a}–${b}`;
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function pctSpread(n: number): string {
	return `±${(n * 100).toFixed(1)}pp`;
}

function usd(n: number): string {
	return Number.isFinite(n) ? `$${n.toFixed(0)}` : "n/a";
}
