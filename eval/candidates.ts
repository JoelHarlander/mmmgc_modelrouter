/**
 * Candidate-selection mode: run N candidates for one turn and let a judge pick.
 *
 * This measures the idea behind /duo, /trio and /par — does a judge's pick beat
 * the single routed model? — without touching how the shipped fan-out adopts a
 * response. The candidate set is chosen by the same policy as
 * src/parallel.ts#pickParallelModels (current model first, then the strongest
 * configured model of each tier from heavy down, then the rest), and the judge
 * question is the same one src/parallel.ts sends to Jev; test/eval.test.ts pins
 * both against that file so the copy cannot drift silently.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelKey, type RouterConfig, TIERS } from "../src/config.ts";
import { choiceConfidence, type JevChoiceAnswer, type JevClient, type JsonValue } from "../src/jev.ts";
import type { FleetModel } from "./types.ts";
import { effectiveSkill, hashUnit } from "./simulate.ts";
import { splitKey } from "./fleet.ts";

/** Verbatim from src/parallel.ts. Pinned by test. */
export const JUDGE_QUESTION =
	"Which of `responses` best answers `request` for a software engineer? Prefer correctness, then completeness, then concision.";
export const JUDGE_CRITERION = (label: string) => `Response ${label} in \`responses\``;

export interface JudgeVerdict {
	pick: string;
	confidence: number;
	probabilities: Record<string, number>;
	costUsd: number;
	ms: number;
}

export interface JudgeCandidate {
	label: string;
	key: string;
	/** Present in live mode; the offline judge scores the declared skill instead. */
	text?: string;
	trueSkill: number;
}

export interface Judge {
	readonly name: string;
	pick(request: string, candidates: JudgeCandidate[], context: { taskId: string; turn: number }): Promise<JudgeVerdict>;
}

/**
 * The offline stand-in for Jev: it perceives each candidate's true quality with a
 * bounded error, so it is reliably right about large quality gaps and close to a
 * coin flip on small ones. `noise` is the half-width of that error in skill points.
 */
export class NoisyJudge implements Judge {
	readonly name: string;

	constructor(
		private readonly noise: number,
		private readonly seed: string,
		private readonly temperature = 6,
	) {
		this.name = `noisy(${noise})`;
	}

	async pick(_request: string, candidates: JudgeCandidate[], context: { taskId: string; turn: number }): Promise<JudgeVerdict> {
		const perceived = candidates.map((c) => {
			const jitter = (hashUnit(this.seed, context.taskId, context.turn, c.key) * 2 - 1) * this.noise;
			return { label: c.label, score: c.trueSkill + jitter };
		});
		const max = Math.max(...perceived.map((p) => p.score));
		const exps = perceived.map((p) => Math.exp((p.score - max) / this.temperature));
		const sum = exps.reduce((a, b) => a + b, 0);
		const probabilities: Record<string, number> = {};
		perceived.forEach((p, i) => {
			probabilities[p.label] = exps[i]! / sum;
		});
		const best = perceived.reduce((a, b) => (b.score > a.score ? b : a));
		return { pick: best.label, confidence: choiceConfidence(probabilities), probabilities, costUsd: 0, ms: 0 };
	}
}

/** The real thing: Jev judging real response texts, using src/parallel.ts's question verbatim. */
export class JevJudge implements Judge {
	readonly name = "jev";

	constructor(
		private readonly jev: JevClient,
		private readonly maxChars: number,
	) {}

	async pick(request: string, candidates: JudgeCandidate[]): Promise<JudgeVerdict> {
		const state: JsonValue = {
			request,
			responses: Object.fromEntries(candidates.map((c) => [c.label, (c.text ?? "").slice(0, this.maxChars)])),
		};
		const criteria = Object.fromEntries(candidates.map((c) => [c.label, JUDGE_CRITERION(c.label)]));
		const res = await this.jev.ask(state, { best: { type: "choice", instructions: { question: JUDGE_QUESTION }, criteria } });
		const best = res.answers.best as JevChoiceAnswer | undefined;
		if (!best) throw new Error("Jev judge returned no choice answer");
		return { pick: best.choice, confidence: best.confidence, probabilities: best.probabilities, costUsd: res.costUsd, ms: res.ms };
	}
}

/**
 * Mirrors src/parallel.ts#pickParallelModels for the eval fleet: the routed model
 * first, then the strongest configured model of each tier from heavy down, then
 * the remaining tier entries, skipping anything unauthed.
 */
export function pickCandidates(args: {
	current: Model<Api> | undefined;
	cfg: RouterConfig;
	n: number;
	byKey: Map<string, FleetModel>;
	unauthed: Set<string>;
}): FleetModel[] {
	const { current, cfg, n, byKey, unauthed } = args;
	const chosen: FleetModel[] = [];
	const seen = new Set<string>();
	const add = (key: string | undefined) => {
		if (!key || chosen.length >= n) return;
		const spec = byKey.get(key);
		if (!spec || seen.has(key) || unauthed.has(key)) return;
		seen.add(key);
		chosen.push(spec);
	};

	if (cfg.parallel.models.length > 0) {
		for (const key of cfg.parallel.models) add(key);
		return chosen;
	}
	add(current ? modelKey(current) : undefined);
	for (const tier of [...TIERS].reverse()) add(cfg.tiers[tier]?.[0]);
	for (const tier of [...TIERS].reverse()) for (const key of cfg.tiers[tier] ?? []) add(key);
	return chosen;
}

/** Candidate response text the offline judge is handed, so live and offline share a shape. */
export function syntheticResponse(model: FleetModel, category: string, prompt: string): string {
	const { provider, id } = splitKey(model.key);
	return `[${provider}/${id} skill=${effectiveSkill(model, category)}] ${prompt.slice(0, 120)}`;
}
