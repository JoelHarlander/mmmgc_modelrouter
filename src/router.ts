/**
 * Decision layer: turn a Jev tier + confidence into a concrete pi model.
 * Cost-aware (plan vs on-demand vs free), quota-aware, and cache-switch-aware.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type Billing, modelKey, overrideFor, type RouterConfig, type Tier, TIERS } from "./config.ts";
import type { Ledger } from "./ledger.ts";

export interface Candidate {
	key: string;
	model?: Model<Api>;
	billing?: Billing;
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
	candidates: Candidate[];
	jevMs?: number;
	jevModel?: string;
	needsTools?: number;
	stakes?: number;
	at: number;
}

export function billingFor(model: Model<Api>, cfg: RouterConfig, registry: ModelRegistry): Billing {
	const override = overrideFor(cfg, modelKey(model)).billing;
	if (override) return override;
	const c = model.cost;
	if (c.input === 0 && c.output === 0) return "free";
	return registry.isUsingOAuth(model) ? "plan" : "on-demand";
}

/** USD for one turn: context re-read (cache miss) or cache read (warm) + expected output. */
export function estimateTurnCost(model: Model<Api>, billing: Billing, contextTokens: number, cfg: RouterConfig, warm: boolean): number {
	if (billing !== "on-demand") return 0;
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
}

export function chooseModel(args: ChooseArgs): Omit<Decision, "at" | "jevMs" | "jevModel" | "needsTools" | "stakes"> {
	const { tier, confidence, current, registry, cfg, ledger, contextTokens } = args;
	const currentKey = current ? modelKey(current) : undefined;

	if (confidence < cfg.switching.minConfidence && current) {
		return {
			requestedTier: tier,
			tier,
			confidence,
			model: current,
			switched: false,
			reason: `confidence ${confidence.toFixed(2)} < ${cfg.switching.minConfidence}; keeping ${currentKey}`,
			candidates: [],
		};
	}

	// Try the requested tier, then escalate, then de-escalate.
	const order = escalationOrder(tier);
	for (const t of order) {
		const candidates = evaluateTier(t, args, currentKey);
		const viable = candidates.filter((c) => !c.skipped);
		if (viable.length === 0) continue;
		viable.sort(compareCandidates);
		const best = viable[0]!;
		const switched = best.key !== currentKey;
		return {
			requestedTier: tier,
			tier: t,
			confidence,
			model: best.model,
			switched,
			reason:
				t === tier
					? `${tier} tier -> ${best.key} (${best.billing}, ~$${best.costUsd.toFixed(4)})`
					: `${tier} tier had no usable model; using ${t} -> ${best.key}`,
			candidates,
		};
	}
	return {
		requestedTier: tier,
		tier,
		confidence,
		model: current,
		switched: false,
		reason: "no configured model is available; keeping current",
		candidates: [],
	};
}

function escalationOrder(tier: Tier): Tier[] {
	const idx = TIERS.indexOf(tier);
	return [...TIERS.slice(idx), ...TIERS.slice(0, idx).reverse()];
}

function evaluateTier(tier: Tier, args: ChooseArgs, currentKey: string | undefined): Candidate[] {
	const { registry, cfg, ledger, contextTokens } = args;
	const seen = new Set<string>();
	const out: Candidate[] = [];
	for (const key of cfg.tiers[tier] ?? []) {
		if (seen.has(key)) continue;
		seen.add(key);
		const slash = key.indexOf("/");
		const provider = key.slice(0, slash);
		const id = key.slice(slash + 1);
		const model = registry.find(provider, id);
		const capability = overrideFor(cfg, key).capability ?? 50;
		if (!model) {
			out.push({ key, costUsd: 0, switchPenaltyUsd: 0, capability, skipped: "unknown model" });
			continue;
		}
		if (!registry.hasConfiguredAuth(model)) {
			out.push({ key, model, costUsd: 0, switchPenaltyUsd: 0, capability, skipped: "no auth" });
			continue;
		}
		const billing = billingFor(model, cfg, registry);
		const block = ledger.isBlocked(provider, cfg);
		if (block.blocked) {
			out.push({ key, model, billing, costUsd: 0, switchPenaltyUsd: 0, capability, skipped: block.reason });
			continue;
		}
		const warm = key === currentKey;
		const costUsd = estimateTurnCost(model, billing, contextTokens, cfg, warm);
		const switchPenaltyUsd =
			!warm && cfg.switching.cacheSwitchPenalty && billing === "on-demand"
				? (contextTokens * Math.max(0, model.cost.input - model.cost.cacheRead)) / 1_000_000
				: 0;
		out.push({ key, model, billing, costUsd, switchPenaltyUsd, capability });
	}
	return out;
}

/** Cheapest first; among equal cost prefer higher capability, then config order (stable sort). */
function compareCandidates(a: Candidate, b: Candidate): number {
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
