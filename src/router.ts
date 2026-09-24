/**
 * Decision layer: turn a Jev tier + confidence into a concrete pi model.
 *
 * Billing eligibility (see billing.ts) is an input here, not an afterthought: a candidate is
 * only selectable when its billing basis is permitted, and verified subscription-backed routes
 * outrank anything that bills extra. Every path through this module assesses the model it ends
 * on, including the one that keeps the current model below the confidence floor. The basis and
 * its remaining uncertainty travel with the decision so `/router explain` can state the footing
 * instead of asserting a conclusion.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { assessBilling, type BillingAssessment, type BillingBasis, billsPerToken, describeBasis } from "./billing.ts";
import { type Billing, modelKey, overrideFor, type RouterConfig, type Tier, TIERS } from "./config.ts";
import type { Ledger } from "./ledger.ts";

export interface Candidate {
	key: string;
	model?: Model<Api>;
	billing?: Billing;
	/** Full billing verdict: basis, verification, eligibility, evidence, uncertainty. */
	assessment?: BillingAssessment;
	/** Estimated USD for this turn if this model is used. */
	costUsd: number;
	switchPenaltyUsd: number;
	capability: number;
	skipped?: string;
}

export interface Decision {
	requestedTier: Tier;
	tier: Tier;
	confidence: number;
	model?: Model<Api>;
	switched: boolean;
	reason: string;
	/** Billing verdict for the chosen model, when one was chosen. */
	billing?: BillingAssessment;
	/** Set when the model the session is left on is itself not billing-eligible. */
	ineligibleCurrent?: string;
	candidates: Candidate[];
	jevMs?: number;
	jevModel?: string;
	needsTools?: number;
	stakes?: number;
	at: number;
}

/**
 * USD for one turn: context re-read (cache miss) or cache read (warm) + expected output.
 * Priced off the billing basis, so extra billed usage costs real money rather than $0.
 */
export function estimateTurnCost(model: Model<Api>, basis: BillingBasis, contextTokens: number, cfg: RouterConfig, warm: boolean): number {
	if (!billsPerToken(basis)) return 0;
	const inputRate = warm && model.cost.cacheRead > 0 ? model.cost.cacheRead : model.cost.input;
	const input = (contextTokens * inputRate) / 1_000_000;
	const output = (cfg.switching.expectedOutputTokens * model.cost.output) / 1_000_000;
	return input + output;
}

export interface ChooseArgs {
	tier: Tier;
	confidence: number;
	current: Model<Api> | undefined;
	registry: ModelRegistry;
	cfg: RouterConfig;
	ledger: Ledger;
	contextTokens: number;
	now?: number;
}

export function chooseModel(args: ChooseArgs): Omit<Decision, "at" | "jevMs" | "jevModel" | "needsTools" | "stakes"> {
	const { tier, confidence, current, cfg } = args;
	const currentKey = current ? modelKey(current) : undefined;

	// Every route evaluated is kept, so an explanation shows what was ruled out on the way to the
	// one that was taken - including the model the session was left on.
	const evaluated: Candidate[] = [];
	const seen = new Set<string>();
	const collect = (candidates: Candidate[]) => {
		for (const c of candidates) {
			if (seen.has(c.key)) continue;
			seen.add(c.key);
			evaluated.push(c);
		}
	};

	// Below the confidence floor the router keeps what the session is on - but only once the
	// billing gate has said it may. An ineligible route is never kept for want of confidence.
	if (confidence < cfg.switching.minConfidence && current) {
		const held = evaluateCandidate(currentKey!, args, currentKey);
		collect([held]);
		if (!held.skipped) {
			const basis = held.assessment ? describeBasis(held.assessment) : (held.billing ?? "unknown");
			return {
				requestedTier: tier,
				tier,
				confidence,
				model: current,
				switched: false,
				billing: held.assessment,
				reason: `confidence ${confidence.toFixed(2)} < ${cfg.switching.minConfidence}; keeping ${currentKey} (${basis})`,
				candidates: evaluated,
			};
		}
	}

	// Try the requested tier, then escalate, then de-escalate.
	const order = escalationOrder(tier);
	for (const t of order) {
		const candidates = evaluateTier(t, args, currentKey);
		collect(candidates);
		const viable = candidates.filter((c) => !c.skipped);
		if (viable.length === 0) continue;
		viable.sort(compareCandidates);
		const best = viable[0]!;
		const switched = best.key !== currentKey;
		const basis = best.assessment ? describeBasis(best.assessment) : (best.billing ?? "unknown");
		const caveat = best.assessment?.uncertainty.length ? `; caveat: ${best.assessment.uncertainty[0]}` : "";
		const leftOut = candidates
			.filter((c) => c.skipped)
			.map((c) => `${c.key} (${c.skipped})`)
			.join("; ");
		return {
			requestedTier: tier,
			tier: t,
			confidence,
			model: best.model,
			switched,
			billing: best.assessment,
			reason:
				(t === tier
					? `${tier} tier -> ${best.key} (${basis}, ~$${best.costUsd.toFixed(4)})`
					: `${tier} tier had no billing-eligible model; using ${t} -> ${best.key} (${basis})`) +
				(leftOut ? `; left out ${leftOut}` : "") +
				caveat,
			candidates: evaluated,
		};
	}
	// Nothing is eligible. Keeping the current model is a fallback, not an endorsement: say so,
	// and name why the current model itself was not selectable when it was a candidate.
	let blocked: string | undefined;
	if (current) {
		const held = evaluateCandidate(currentKey!, args, currentKey);
		collect([held]);
		blocked = held.skipped;
	}

	return {
		requestedTier: tier,
		tier,
		confidence,
		model: current,
		switched: false,
		ineligibleCurrent: blocked,
		reason: `no configured model is billing-eligible; keeping ${currentKey ?? "current model"}${blocked ? ` (itself ${blocked})` : ""}`,
		candidates: evaluated,
	};
}

function escalationOrder(tier: Tier): Tier[] {
	const idx = TIERS.indexOf(tier);
	return [...TIERS.slice(idx), ...TIERS.slice(0, idx).reverse()];
}

function evaluateTier(tier: Tier, args: ChooseArgs, currentKey: string | undefined): Candidate[] {
	const { cfg } = args;
	const seen = new Set<string>();
	const out: Candidate[] = [];
	for (const key of cfg.tiers[tier] ?? []) {
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(evaluateCandidate(key, args, currentKey));
	}
	return out;
}

/** Auth, then billing eligibility, then cost. Shared with the parallel commands. */
export function evaluateCandidate(key: string, args: ChooseArgs, currentKey?: string): Candidate {
	const { registry, cfg, ledger, contextTokens } = args;
	const slash = key.indexOf("/");
	const model = slash < 0 ? undefined : registry.find(key.slice(0, slash), key.slice(slash + 1));
	const capability = overrideFor(cfg, key).capability ?? 50;
	if (!model) return { key, costUsd: 0, switchPenaltyUsd: 0, capability, skipped: "unknown model" };
	if (!registry.hasConfiguredAuth(model)) return { key, model, costUsd: 0, switchPenaltyUsd: 0, capability, skipped: "no auth" };

	const assessment = assessBilling({ model, cfg, registry, ledger, now: args.now });
	const billing = assessment.billing;
	if (assessment.eligibility === "excluded") {
		return { key, model, billing, assessment, costUsd: 0, switchPenaltyUsd: 0, capability, skipped: assessment.reason };
	}
	const warm = key === currentKey;
	const costUsd = estimateTurnCost(model, assessment.basis, contextTokens, cfg, warm);
	const switchPenaltyUsd =
		!warm && cfg.switching.cacheSwitchPenalty && billsPerToken(assessment.basis)
			? (contextTokens * Math.max(0, model.cost.input - model.cost.cacheRead)) / 1_000_000
			: 0;
	return { key, model, billing, assessment, costUsd, switchPenaltyUsd, capability };
}

/**
 * Billing rank first, so verified subscription-backed usage wins over anything billed even when
 * the billed route estimates cheaper. Then cheapest, then higher capability, then config order.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
	const ra = a.assessment?.rank ?? 2;
	const rb = b.assessment?.rank ?? 2;
	if (ra !== rb) return ra - rb;
	const ca = a.costUsd + a.switchPenaltyUsd;
	const cb = b.costUsd + b.switchPenaltyUsd;
	if (Math.abs(ca - cb) > 1e-6) return ca - cb;
	return b.capability - a.capability;
}

/** Zero-cost fallback when Jev is unavailable. Low confidence on purpose. */
export function heuristicTier(prompt: string): { tier: Tier; confidence: number } {
	const p = prompt.trim();
	const words = p.split(/\s+/).length;
	const heavyHint = /\b(architect|design|refactor|migrate|debug|why does|race|deadlock|security|review|audit|investigate|root cause)\b/i;
	if (heavyHint.test(p)) return { tier: "heavy", confidence: 0.4 };
	if (words <= 12 && !p.includes("```")) return { tier: "light", confidence: 0.4 };
	return { tier: "standard", confidence: 0.34 };
}
