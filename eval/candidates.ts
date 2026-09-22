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
	/** How much this candidate looks like the expensive answer. Drives a `price` bias. */
	flashiness?: number;
	/** How long and elaborate this candidate's answer is. Drives a `length` bias. */
	verbosity?: number;
}

export interface Judge {
	readonly name: string;
	pick(request: string, candidates: JudgeCandidate[], context: { taskId: string; turn: number }): Promise<JudgeVerdict>;
}

/**
 * Which axis a judge's systematic preference runs on.
 *
 * Round 9 found that `tier-top` is immune to bias because its flashiest candidate is
 * also its strongest — and said in the same breath that the immunity might be specific
 * to *that* axis. `price` is the axis round 9 measured; `length` is the other documented
 * LLM-judge failure mode, and `position` is a preference for whichever answer came first.
 */
export type BiasAxis = "price" | "length" | "position";

export interface NoisyJudgeOptions {
	/** Half-width, in skill points, of the judge's perception error. */
	noise: number;
	seed: string;
	temperature?: number;
	/**
	 * Skill points the judge hands the candidate that wins on `biasAxis`, regardless of
	 * quality. Models the documented LLM-judge failure modes.
	 */
	bias?: number;
	/** Which axis that preference runs on. Defaults to `price` - round 9's axis. */
	biasAxis?: BiasAxis;
}

/**
 * The offline stand-in for Jev: it perceives each candidate's true quality with a
 * bounded error, so it is reliably right about large quality gaps and close to a
 * coin flip on small ones. It is a stand-in, not a simulation of Jev — which is why
 * `--sweep judge` exists: the candidate result only counts if it survives a range of
 * judges, not one setting of one knob.
 */
export class NoisyJudge implements Judge {
	readonly name: string;
	private readonly noise: number;
	private readonly seed: string;
	private readonly temperature: number;
	private readonly bias: number;
	private readonly biasAxis: BiasAxis;

	constructor(noiseOrOptions: number | NoisyJudgeOptions, seed = "", temperature = 6) {
		const o: NoisyJudgeOptions = typeof noiseOrOptions === "number" ? { noise: noiseOrOptions, seed, temperature } : noiseOrOptions;
		this.noise = o.noise;
		this.seed = o.seed;
		this.temperature = o.temperature ?? 6;
		this.bias = o.bias ?? 0;
		this.biasAxis = o.biasAxis ?? "price";
		this.name = this.bias === 0 ? `noisy(${this.noise})` : `noisy(${this.noise},bias ${this.bias} on ${this.biasAxis})`;
	}

	/** The candidate this judge unfairly prefers, on whichever axis its bias runs. */
	private favoured(candidates: JudgeCandidate[]): JudgeCandidate {
		if (this.biasAxis === "position") return candidates[0]!;
		const of = (c: JudgeCandidate) => (this.biasAxis === "length" ? (c.verbosity ?? 0) : (c.flashiness ?? 0));
		return candidates.reduce((a, b) => (of(b) > of(a) ? b : a));
	}

	async pick(_request: string, candidates: JudgeCandidate[], context: { taskId: string; turn: number }): Promise<JudgeVerdict> {
		const favoured = this.favoured(candidates);
		const perceived = candidates.map((c) => {
			const jitter = (hashUnit(this.seed, context.taskId, context.turn, c.key) * 2 - 1) * this.noise;
			const bias = c === favoured ? this.bias : 0;
			return { label: c.label, score: c.trueSkill + jitter + bias };
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

export interface CandidatePolicyArgs {
	current: Model<Api> | undefined;
	cfg: RouterConfig;
	n: number;
	byKey: Map<string, FleetModel>;
	unauthed: Set<string>;
}

export type CandidatePolicy = (args: CandidatePolicyArgs) => FleetModel[];

/**
 * Alternative candidate sets, for measuring what a *different* fan-out would buy.
 * None of these change the shipped fan-out: `shipped` is the one it actually uses and
 * is pinned against src/parallel.ts by test; the rest exist only to say what the
 * inherited policy costs by comparison.
 *
 * Every policy may only use information the real router has — the configured tier
 * lists, `models[key].capability`, and published prices. None may read the oracle's
 * `skill`, which is the hidden truth they are being scored against. In this fleet
 * `capability` and `skill` deliberately disagree, so ranking by capability is a noisy
 * proxy, as it would be in reality.
 */
export const CANDIDATE_POLICIES: Record<string, CandidatePolicy> = {
	shipped: (args) => pickCandidates(args),

	/** The N highest declared capabilities. Ignores cost and the current model entirely. */
	strongest: (args) => rank(args, (a, b) => capabilityOf(args.cfg, b) - capabilityOf(args.cfg, a)),

	/** The N cheapest per cold turn: the spend-first mirror of `strongest`. */
	cheapest: (args) => rank(args, (a, b) => coldish(a) - coldish(b)),

	/**
	 * The routed model, then alternately the strongest and the cheapest of what is left.
	 * Maximises the quality range in the set, which is what a judge needs before it can
	 * tell the candidates apart at all.
	 */
	spread: (args) => {
		const { current, byKey, unauthed, n, cfg } = args;
		const pool = [...byKey.values()].filter((m) => !unauthed.has(m.key));
		const chosen: FleetModel[] = [];
		const take = (m: FleetModel | undefined) => {
			if (m && chosen.length < n && !chosen.includes(m)) chosen.push(m);
		};
		take(current ? byKey.get(modelKey(current)) : undefined);
		let wantStrong = true;
		while (chosen.length < n) {
			const rest = pool.filter((m) => !chosen.includes(m));
			if (rest.length === 0) break;
			rest.sort((a, b) => (wantStrong ? capabilityOf(cfg, b) - capabilityOf(cfg, a) : coldish(a) - coldish(b)));
			take(rest[0]);
			wantStrong = !wantStrong;
		}
		return chosen;
	},

	/** The model the router itself would prefer in each tier, heaviest first, then fill. */
	"tier-top": (args) => {
		const { cfg, byKey, unauthed, n } = args;
		const chosen: FleetModel[] = [];
		const take = (key: string | undefined) => {
			const m = key ? byKey.get(key) : undefined;
			if (m && chosen.length < n && !chosen.includes(m) && !unauthed.has(m.key)) chosen.push(m);
		};
		for (const tier of [...TIERS].reverse()) {
			const keys = (cfg.tiers[tier] ?? []).filter((k) => !unauthed.has(k) && byKey.has(k));
			take([...keys].sort((a, b) => coldish(byKey.get(a)!) - coldish(byKey.get(b)!))[0]);
		}
		for (const tier of [...TIERS].reverse()) for (const key of cfg.tiers[tier] ?? []) take(key);
		return chosen;
	},
};

function capabilityOf(cfg: RouterConfig, m: FleetModel): number {
	return cfg.models[m.key]?.capability ?? 50;
}

/** A cold turn's rough price shape — what a fan-out candidate actually pays. */
function coldish(m: FleetModel): number {
	return m.cost.input + m.cost.output / 10;
}

function rank(args: CandidatePolicyArgs, cmp: (a: FleetModel, b: FleetModel) => number): FleetModel[] {
	return [...args.byKey.values()]
		.filter((m) => !args.unauthed.has(m.key))
		.sort(cmp)
		.slice(0, args.n);
}

/**
 * Mirrors src/parallel.ts#pickParallelModels for the eval fleet: the routed model
 * first, then the strongest configured model of each tier from heavy down, then
 * the remaining tier entries, skipping anything unauthed.
 */
export function pickCandidates(args: CandidatePolicyArgs): FleetModel[] {
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
