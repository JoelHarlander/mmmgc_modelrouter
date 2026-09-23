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
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { modelKey, type RouterConfig, TIERS } from "../src/config.ts";
import { choiceConfidence, type JevChoiceAnswer, type JevClient, JevError, type JsonValue } from "../src/jev.ts";
import type { Ledger } from "../src/ledger.ts";
import { evaluateCandidate } from "../src/router.ts";
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

export interface RetryOptions {
	/** Total attempts per call, including the first. */
	attempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	/**
	 * Floor for a 429's backoff. The gateway enforces 30 requests per 15 seconds and
	 * replies `retry-after: 15`, but src/jev.ts only honours a retry-after shorter than
	 * its 4s timeout, so by the time the error reaches here the header is gone. Waiting
	 * out the documented window is the only correct response.
	 */
	rateLimitDelayMs?: number;
	/** Minimum gap between calls, so a 48-call probe does not arrive as a burst. */
	paceMs?: number;
	onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/**
 * Wraps a judge so a transient upstream failure does not abandon a whole run.
 *
 * `src/jev.ts` retries a 429 only when it carries a usable `retry-after`, and the
 * gateway's "upstream provider is experiencing high demand" 429 carries none - so the
 * first live probe attempt aborted on call one. This retries any 429, any 5xx and any
 * network error with exponential backoff and jitter, and paces calls so a 48-call probe
 * does not arrive as a burst. It wraps rather than changes `src/`.
 */
export class RetryingJudge implements Judge {
	readonly name: string;
	private lastCallAt = 0;

	constructor(
		private readonly inner: Judge,
		private readonly options: RetryOptions = {},
	) {
		this.name = inner.name;
	}

	async pick(request: string, candidates: JudgeCandidate[], context: { taskId: string; turn: number }): Promise<JudgeVerdict> {
		const attempts = this.options.attempts ?? 5;
		const base = this.options.baseDelayMs ?? 1000;
		const max = this.options.maxDelayMs ?? 30_000;
		const pace = this.options.paceMs ?? 0;

		let lastError: unknown;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			const since = Date.now() - this.lastCallAt;
			if (pace > 0 && since < pace) await sleep(pace - since);
			this.lastCallAt = Date.now();
			try {
				return await this.inner.pick(request, candidates, context);
			} catch (err) {
				lastError = err;
				if (attempt === attempts || !isRetryable(err)) throw err;
				// Exponential with full jitter, so concurrent retries do not resynchronise.
				const backoff = Math.min(max, base * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
				// A rate limit is a window to wait out, not a blip to back off from.
				const delay = isRateLimit(err) ? Math.max(backoff, this.options.rateLimitDelayMs ?? 16_000) : backoff;
				this.options.onRetry?.(attempt, Math.round(delay), err);
				await sleep(delay);
			}
		}
		throw lastError;
	}
}

/** A rate limit needs the window waited out rather than an exponential back-off. */
export function isRateLimit(err: unknown): boolean {
	return err instanceof JevError && err.status === 429;
}

/** A 429, a 5xx or a network-level failure is worth another go; a 4xx is not. */
export function isRetryable(err: unknown): boolean {
	if (err instanceof JevError) return err.status === undefined || err.status === 429 || err.status >= 500;
	// fetch/abort failures arrive as ordinary Errors with no status.
	return err instanceof Error;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The same retry and pacing policy as `RetryingJudge`, applied to a `JevClient` so the
 * live *classifier* gets it too. A 175-turn pack is 175 calls against a 30-per-15-second
 * budget; without pacing it fails on call 31.
 *
 * Exposes only what `eval/classifier.ts` uses, so it cannot drift into being a partial
 * reimplementation of the client.
 */
export interface JevLike {
	available(): boolean;
	describe(): string;
	ask(...args: Parameters<JevClient["ask"]>): ReturnType<JevClient["ask"]>;
}

export function retryingJev(inner: JevClient, options: RetryOptions = {}): JevLike {
	const attempts = options.attempts ?? 6;
	const base = options.baseDelayMs ?? 1000;
	const max = options.maxDelayMs ?? 30_000;
	const pace = options.paceMs ?? 0;
	let lastCallAt = 0;

	return {
		available: () => inner.available(),
		describe: () => inner.describe(),
		async ask(...args) {
			let lastError: unknown;
			for (let attempt = 1; attempt <= attempts; attempt++) {
				const since = Date.now() - lastCallAt;
				if (pace > 0 && since < pace) await sleep(pace - since);
				lastCallAt = Date.now();
				try {
					return await inner.ask(...args);
				} catch (err) {
					lastError = err;
					if (attempt === attempts || !isRetryable(err)) throw err;
					const backoff = Math.min(max, base * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
					const delay = isRateLimit(err) ? Math.max(backoff, options.rateLimitDelayMs ?? 16_000) : backoff;
					options.onRetry?.(attempt, Math.round(delay), err);
					await sleep(delay);
				}
			}
			throw lastError;
		},
	};
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
	/**
	 * Only the `shipped` policy needs these, and only because it mirrors
	 * `src/parallel.ts#pickParallelModels` — which now orders its slots by billing rank,
	 * a verdict that cannot be read off the fleet. Passing the real registry and ledger
	 * lets the mirror call the router's own `evaluateCandidate` instead of restating its
	 * rules here, so the two cannot drift apart.
	 */
	registry?: ModelRegistry;
	ledger?: Ledger;
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
 * Mirrors src/parallel.ts#pickParallelModels for the eval fleet: the routed model first,
 * then the strongest configured model of each tier from heavy down, then the remaining
 * tier entries — and since billing became a routing input, that discovery order is then
 * stably re-sorted by billing rank before the first `n` are taken. Anything the billing
 * gate or auth turns down is dropped rather than ranked.
 *
 * The rank comes from `evaluateCandidate` in `src/router.ts`, not from a copy of its
 * rules, which is what keeps this a mirror rather than a second implementation.
 */
export function pickCandidates(args: CandidatePolicyArgs): FleetModel[] {
	const { current, cfg, n, byKey, unauthed, registry, ledger } = args;
	const order: string[] = [];
	const seen = new Set<string>();
	const consider = (key: string | undefined) => {
		if (!key || seen.has(key)) return;
		seen.add(key);
		if (!byKey.has(key) || unauthed.has(key)) return;
		order.push(key);
	};

	if (cfg.parallel.models.length > 0) {
		// An explicit list is the caller's own choice of what to compare, so src/ honours
		// it in configured order and never reorders it for a better-ranked route.
		for (const key of cfg.parallel.models) consider(key);
		return order.slice(0, n).map((k) => byKey.get(k)!);
	}
	consider(current ? modelKey(current) : undefined);
	for (const tier of [...TIERS].reverse()) consider(cfg.tiers[tier]?.[0]);
	for (const tier of [...TIERS].reverse()) for (const key of cfg.tiers[tier] ?? []) consider(key);

	if (!registry || !ledger) {
		throw new Error("the shipped candidate policy needs the registry and ledger to read billing rank; pass them from the loaded fleet");
	}
	const currentKey = current ? modelKey(current) : undefined;
	const chooseArgs = { tier: "standard" as const, confidence: 1, current, registry, cfg, ledger, contextTokens: 0 };
	const ranked = order
		.map((key, at) => ({ key, at, candidate: evaluateCandidate(key, chooseArgs, currentKey) }))
		.filter((r) => !r.candidate.skipped && r.candidate.model)
		.sort((a, b) => (a.candidate.assessment?.rank ?? 0) - (b.candidate.assessment?.rank ?? 0) || a.at - b.at);
	return ranked.slice(0, n).map((r) => byKey.get(r.key)!);
}

/** Candidate response text the offline judge is handed, so live and offline share a shape. */
export function syntheticResponse(model: FleetModel, category: string, prompt: string): string {
	const { provider, id } = splitKey(model.key);
	return `[${provider}/${id} skill=${effectiveSkill(model, category)}] ${prompt.slice(0, 120)}`;
}
