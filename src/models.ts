/**
 * What the model picker knows: which models pi offers, what the router would make of each one,
 * and the two mistakes a tier configuration can hide.
 *
 *   unusable - a tier names a model pi does not have, cannot authenticate, or that the billing
 *              gate excludes right now. Routing skips it silently turn after turn.
 *   untiered - pi offers an eligible model that no tier names, so the router never considers it.
 *
 * Every per-model verdict here is `evaluateCandidate`'s, the one routing uses, so the picker can
 * never describe a route differently from how the router would treat it.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { billsPerToken, describeBasis } from "./billing.ts";
import { modelKey, type RouterConfig, type Tier, TIERS } from "./config.ts";
import type { TierLists } from "./configfile.ts";
import type { Ledger } from "./ledger.ts";
import { type Candidate, evaluateCandidate } from "./router.ts";

// ---- tier editing ----------------------------------------------------------------

/** Appends a model to a tier, where it is least preferred. A model already there stays put. */
export function addToTier(tiers: TierLists, tier: Tier, key: string): TierLists {
	if (tiers[tier].includes(key)) return tiers;
	return { ...tiers, [tier]: [...tiers[tier], key] };
}

export function removeFromTier(tiers: TierLists, tier: Tier, key: string): TierLists {
	return { ...tiers, [tier]: tiers[tier].filter((k) => k !== key) };
}

/** Moves one entry by `delta` places within its tier, clamped to the ends. Order is preference. */
export function moveInTier(tiers: TierLists, tier: Tier, index: number, delta: number): TierLists {
	const list = [...tiers[tier]];
	if (index < 0 || index >= list.length) return tiers;
	const to = Math.max(0, Math.min(list.length - 1, index + delta));
	if (to === index) return tiers;
	const [item] = list.splice(index, 1);
	list.splice(to, 0, item!);
	return { ...tiers, [tier]: list };
}

/** The tiers the router ends up with: the global lists, then whatever this project replaces. */
export function effectiveTiers(global: TierLists, project: Partial<TierLists>): TierLists {
	return { ...global, ...project };
}

// ---- what pi offers ------------------------------------------------------------

export interface Offered {
	models: Model<Api>[];
	/** True when pi has an explicit enabled set (`enabledModels` / `--models`), not just "everything authed". */
	explicit: boolean;
}

/**
 * The models pi itself offers this session: its enabled set when one is configured, otherwise
 * every catalog model it holds a credential for. Never a list of our own.
 */
export function offeredModels(scoped: readonly { model: Model<Api> }[], registry: ModelRegistry): Offered {
	if (scoped.length > 0) return { models: scoped.map((s) => s.model), explicit: true };
	return { models: registry.getAvailable(), explicit: false };
}

// ---- per-model facts -------------------------------------------------------------

export type ModelState = "unknown" | "no-auth" | "excluded" | "eligible";

export interface ModelFacts {
	key: string;
	model?: Model<Api>;
	state: ModelState;
	/** Routing's own verdict for this model, including the billing assessment when it got that far. */
	candidate: Candidate;
}

export interface FactsArgs {
	cfg: RouterConfig;
	registry: ModelRegistry;
	ledger: Ledger;
	now?: number;
}

export function modelFacts(key: string, args: FactsArgs): ModelFacts {
	const candidate = evaluateCandidate(key, { ...args, tier: "standard", confidence: 1, current: undefined, contextTokens: 0 });
	const state: ModelState =
		candidate.skipped === "unknown model" ? "unknown" : candidate.skipped === "no auth" ? "no-auth" : candidate.skipped ? "excluded" : "eligible";
	return { key, model: candidate.model, state, candidate };
}

/** A short verdict for a list row: basis and verification, or why the router cannot use it. */
export function shortVerdict(f: ModelFacts): string {
	switch (f.state) {
		case "unknown":
			return "not in pi's catalog";
		case "no-auth":
			return "no credential in pi";
		default:
			return describeBasis(f.candidate.assessment!);
	}
}

/** Catalog list price per million tokens, shown only where the basis actually bills per token. */
export function priceNote(f: ModelFacts): string | undefined {
	const a = f.candidate.assessment;
	if (!f.model || !a || !billsPerToken(a.basis)) return undefined;
	return `$${trimPrice(f.model.cost.input)}/$${trimPrice(f.model.cost.output)} per Mtok`;
}

function trimPrice(n: number): string {
	return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, "");
}

// ---- the two mistakes ------------------------------------------------------------

export interface UnusableEntry {
	tier: Tier;
	/** 1-based preference position within the tier. */
	position: number;
	key: string;
	state: Exclude<ModelState, "eligible">;
	why: string;
}

export interface TierReport {
	unusable: UnusableEntry[];
	/** Tiers that name nothing, so a turn routed there always escalates. */
	empty: Tier[];
	/** Offered, eligible models no tier names. */
	untiered: ModelFacts[];
	/** Offered, eligible models no tier names that were not flagged; see `reportTiers`. */
	untieredQuiet: number;
}

/**
 * Checks the tiers against what pi offers. An untiered model is always flagged when pi has an
 * explicit enabled set, since enabling it was a choice. Without one, "offered" is every model
 * pi holds a credential for - often a whole gateway catalog - so only the untiered models that
 * cost nothing at the margin (subscription or zero-cost) are flagged, and the rest are counted.
 * `alsoNamed` is tiers checked only for membership, such as the ones a project file sets.
 */
export function reportTiers(tiers: TierLists, offered: Offered, facts: (key: string) => ModelFacts, alsoNamed: Partial<TierLists> = {}): TierReport {
	const unusable: UnusableEntry[] = [];
	const empty: Tier[] = [];
	for (const tier of TIERS) {
		if (tiers[tier].length === 0) empty.push(tier);
		tiers[tier].forEach((key, i) => {
			const f = facts(key);
			if (f.state !== "eligible") unusable.push({ tier, position: i + 1, key, state: f.state, why: unusableWhy(f) });
		});
	}
	const named = new Set(TIERS.flatMap((t) => [...tiers[t], ...(alsoNamed[t] ?? [])]));
	const untiered: ModelFacts[] = [];
	let untieredQuiet = 0;
	const seen = new Set<string>();
	for (const m of offered.models) {
		const key = modelKey(m);
		if (named.has(key) || seen.has(key)) continue;
		seen.add(key);
		const f = facts(key);
		if (f.state !== "eligible") continue;
		const basis = f.candidate.assessment?.basis;
		if (offered.explicit || basis === "subscription" || basis === "free") untiered.push(f);
		else untieredQuiet++;
	}
	return { unusable, empty, untiered, untieredQuiet };
}

function unusableWhy(f: ModelFacts): string {
	if (f.state === "unknown") return "not in pi's catalog (check `pi --list-models`)";
	if (f.state === "no-auth") return "pi has no credential for it";
	return `excluded: ${f.candidate.skipped}`;
}

/** Plain-text lines for a card or a notification. Empty when the tiers are sound. */
export function reportLines(r: TierReport): string[] {
	const lines: string[] = [];
	for (const u of r.unusable) lines.push(`✗ ${u.tier} #${u.position} ${u.key}: ${u.why}`);
	for (const t of r.empty) lines.push(`✗ ${t} names no model: turns routed there escalate`);
	for (const f of r.untiered) lines.push(`⚠ in no tier, never routed to: ${f.key} (${shortVerdict(f)})`);
	if (r.untieredQuiet > 0) lines.push(`  ${r.untieredQuiet} more billed model${r.untieredQuiet === 1 ? "" : "s"} pi offers ${r.untieredQuiet === 1 ? "is" : "are"} in no tier`);
	return lines;
}

/** Memoised facts for one config snapshot. A tier edit is a new snapshot: build a new cache. */
export function factsCache(args: FactsArgs): (key: string) => ModelFacts {
	const cache = new Map<string, ModelFacts>();
	return (key) => {
		let f = cache.get(key);
		if (!f) {
			f = modelFacts(key, args);
			cache.set(key, f);
		}
		return f;
	};
}
