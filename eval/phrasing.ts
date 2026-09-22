/**
 * The phrasing probe: does *how* a turn is worded change the tier it gets?
 *
 * Round 35 recorded Jev's real answers and found it under-routes question-shaped turns
 * that sit on hard work — "why does it assume…", "who else calls…", "walk me through the
 * consequences" — all of which answer *no* to the `needs_tools` question `src/state.ts`
 * asks. The hypothesis is that the classifier reads *needs no tools* as *is easy*.
 *
 * This is the controlled version. Each pair describes the **same work twice**: once as a
 * question answerable in text, once as an instruction that requires editing files. The
 * understanding required is identical and only the output differs, so a systematic tier
 * gap between the two is the phrasing doing the work rather than the difficulty.
 *
 * It runs the real `routingQuestions()` from `src/state.ts` against a state shaped like
 * the one `buildRoutingState` produces, so what is measured is the shipped prompt.
 */
import { readFileSync } from "node:fs";
import type { Tier } from "../src/config.ts";
import { TIERS } from "../src/config.ts";
import type { JevChoiceAnswer, JevNoulAnswer, JevScoreAnswer } from "../src/jev.ts";
import { routingQuestions, STAKES_QUESTION_KEY, TIER_QUESTION_KEY, TOOLS_QUESTION_KEY } from "../src/state.ts";
import type { JevLike } from "./candidates.ts";

export interface PhrasingPair {
	id: string;
	/** The tier the underlying work needs, identical for both phrasings by construction. */
	difficulty: Tier;
	question: string;
	instruction: string;
}

export interface PhrasingPack {
	version: 1;
	id: string;
	description: string;
	pairs: PhrasingPair[];
}

export interface Classified {
	tier: Tier;
	confidence: number;
	needsTools?: number;
	stakes?: number;
	costUsd: number;
}

export interface PairResult {
	id: string;
	difficulty: Tier;
	question: Classified;
	instruction: Classified;
	/** Positive when the instruction is rated heavier than the question. */
	tierGap: number;
	toolsGap: number;
}

export interface PhrasingReport {
	pairs: number;
	calls: number;
	/** Share of pairs the two phrasings were classified into the same tier. */
	agreement: number;
	/** Pairs where the instruction was rated heavier than its question. */
	instructionHeavier: number;
	/** Pairs where the question was rated heavier than its instruction. */
	questionHeavier: number;
	/** Mean tier steps the instruction sits above the question. The headline. */
	meanTierGap: number;
	/** Mean `needs_tools` for each phrasing, which is the mechanism under test. */
	meanToolsQuestion: number;
	meanToolsInstruction: number;
	/** How often each phrasing reached the tier the work actually needs. */
	questionAccuracy: number;
	instructionAccuracy: number;
	costUsd: number;
	results: PairResult[];
}

export function loadPhrasingPack(path: string): PhrasingPack {
	const pack = JSON.parse(readFileSync(path, "utf8")) as PhrasingPack;
	if (pack.version !== 1) throw new Error(`${path}: unsupported phrasing pack version ${pack.version}`);
	return pack;
}

/** Classify one prompt through the shipped routing questions. */
export type Classify = (prompt: string) => Promise<Classified>;

/** The live classifier: the real questions, against a state shaped like the router's. */
export function jevClassifier(jev: JevLike): Classify {
	return async (prompt: string) => {
		const state = { request: prompt, recent: [], session: { turn: 1, context_tokens: 0, current_model: "none", recent_tools: [] } };
		const res = await jev.ask(state, routingQuestions());
		const tier = res.answers[TIER_QUESTION_KEY] as JevChoiceAnswer | undefined;
		if (!tier || !TIERS.includes(tier.choice as Tier)) throw new Error("no tier answer");
		return {
			tier: tier.choice as Tier,
			confidence: tier.confidence,
			needsTools: (res.answers[TOOLS_QUESTION_KEY] as JevNoulAnswer | undefined)?.noul,
			stakes: (res.answers[STAKES_QUESTION_KEY] as JevScoreAnswer | undefined)?.score,
			costUsd: res.costUsd,
		};
	};
}

export async function runPhrasingProbe(classify: Classify, pack: PhrasingPack): Promise<PhrasingReport> {
	const results: PairResult[] = [];
	let calls = 0;

	for (const pair of pack.pairs) {
		const question = await classify(pair.question);
		const instruction = await classify(pair.instruction);
		calls += 2;
		results.push({
			id: pair.id,
			difficulty: pair.difficulty,
			question,
			instruction,
			tierGap: index(instruction.tier) - index(question.tier),
			toolsGap: (instruction.needsTools ?? 0) - (question.needsTools ?? 0),
		});
	}

	const n = Math.max(1, results.length);
	return {
		pairs: results.length,
		calls,
		agreement: round(results.filter((r) => r.tierGap === 0).length / n),
		instructionHeavier: results.filter((r) => r.tierGap > 0).length,
		questionHeavier: results.filter((r) => r.tierGap < 0).length,
		meanTierGap: round(results.reduce((a, r) => a + r.tierGap, 0) / n),
		meanToolsQuestion: round(results.reduce((a, r) => a + (r.question.needsTools ?? 0), 0) / n),
		meanToolsInstruction: round(results.reduce((a, r) => a + (r.instruction.needsTools ?? 0), 0) / n),
		questionAccuracy: round(results.filter((r) => r.question.tier === r.difficulty).length / n),
		instructionAccuracy: round(results.filter((r) => r.instruction.tier === r.difficulty).length / n),
		costUsd: round(
			results.reduce((a, r) => a + r.question.costUsd + r.instruction.costUsd, 0),
			8,
		),
		results,
	};
}

function index(tier: Tier): number {
	return TIERS.indexOf(tier);
}

function round(n: number, digits = 4): number {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}

export function renderPhrasing(report: PhrasingReport, label: string): string {
	const out: string[] = ["", `phrasing probe — ${label}`, ""];
	out.push("  the same work, worded two ways. a gap means the wording is doing the classifying.");
	out.push("");
	out.push("  pair                    needs    question            instruction         gap");
	for (const r of report.results) {
		out.push(
			`  ${r.id.padEnd(22)}  ${r.difficulty.padEnd(8)} ${`${r.question.tier} ${r.question.confidence.toFixed(2)} t=${(r.question.needsTools ?? 0).toFixed(2)}`.padEnd(19)} ` +
				`${`${r.instruction.tier} ${r.instruction.confidence.toFixed(2)} t=${(r.instruction.needsTools ?? 0).toFixed(2)}`.padEnd(19)} ${r.tierGap > 0 ? `+${r.tierGap}` : String(r.tierGap)}`,
		);
	}
	out.push("");
	const row = (label: string, value: string) => out.push(`  ${label.padEnd(34)}${value.padStart(10)}`);
	row("pairs / calls", `${report.pairs} / ${report.calls}`);
	row("same tier for both phrasings", pct(report.agreement));
	row("instruction rated heavier", String(report.instructionHeavier));
	row("question rated heavier", String(report.questionHeavier));
	row("mean tier gap (instr − question)", report.meanTierGap.toFixed(2));
	row("mean needs_tools, question", report.meanToolsQuestion.toFixed(2));
	row("mean needs_tools, instruction", report.meanToolsInstruction.toFixed(2));
	row("reached the right tier: question", pct(report.questionAccuracy));
	row("reached the right tier: instruction", pct(report.instructionAccuracy));
	row("cost", `$${report.costUsd.toFixed(6)}`);
	out.push("");
	if (report.meanTierGap > 0.25) {
		out.push("  the instruction is systematically rated heavier than the identical work asked as");
		out.push("  a question. `needs_tools` is the difference between them, and src/state.ts asks it.");
	} else if (report.meanTierGap < -0.25) {
		out.push("  the question is systematically rated heavier, which is the opposite of round 35's");
		out.push("  hypothesis and worth explaining before acting on it.");
	} else {
		out.push("  no systematic gap: phrasing is not deciding the tier on this pack.");
	}
	out.push("");
	return `${out.join("\n")}\n`;
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}
