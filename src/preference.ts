/**
 * Session model policy.
 *
 * The user chooses the model. This module never picks one because a turn looks hard or
 * cheap. It does two smaller jobs:
 *
 *   session start — the highest preference entry whose best model is usable and whose
 *                   subscription window is not spent.
 *   a spent window — the current model stays until that window is spent, then the next
 *                   usable entry in the preference list (wrapping once the list runs out).
 *
 * A preference entry is either a series name (`fable`, `grok`, `opus`, `astra`) resolved
 * to the best model pi can actually use in that series, or a concrete `provider/modelId`.
 * "Best" is the highest version, and a tie prefers the subscription provider for that series.
 *
 * Effort is not decided here. The caller still classifies the turn and maps
 * light/standard/heavy onto the thinking level.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { assessBilling, type BillingAssessment, billingLabel } from "./billing.ts";
import { modelKey, type RouterConfig, type Tier } from "./config.ts";
import type { Ledger } from "./ledger.ts";
import { type Candidate, evaluateCandidate } from "./router.ts";

export const SERIES = ["fable", "grok", "opus", "astra"] as const;
export type SeriesName = (typeof SERIES)[number];

/** Model-id test for each series. The provider is a separate tie-break. */
const SERIES_ID: Record<SeriesName, RegExp> = {
	fable: /fable/i,
	grok: /grok/i,
	opus: /opus/i,
	astra: /astra/i,
};

/**
 * When two models in a series have the same version, prefer the subscription provider
 * the installation actually bills that series on.
 */
const SERIES_PROVIDER: Record<SeriesName, readonly string[]> = {
	fable: ["claude-bridge", "anthropic"],
	grok: ["xai"],
	opus: ["claude-bridge", "anthropic"],
	astra: ["openai-codex", "openai"],
};

export interface PreferenceArgs {
	cfg: RouterConfig;
	registry: ModelRegistry;
	ledger: Ledger;
	/** Models pi is offering this session. Series resolution looks only here. */
	models: readonly Model<Api>[];
	now?: number;
}

export interface Resolved {
	entry: string;
	key: string;
	model: Model<Api>;
}

export interface SessionPick extends Resolved {
	reason: string;
}

export interface TurnPlan {
	requestedTier: Tier;
	/** The effort tier. It chooses the thinking level, not the model. */
	tier: Tier;
	confidence: number;
	model?: Model<Api>;
	switched: boolean;
	reason: string;
	billing?: BillingAssessment;
	/** Set when the model the session is left on cannot serve the turn. */
	ineligibleCurrent?: string;
	candidates: Candidate[];
}

/** True when this model's own subscription window is spent. A credential refusal is not that. */
export function subscriptionSpent(model: Model<Api>, args: PreferenceArgs): { spent: boolean; reason?: string } {
	const now = args.now ?? Date.now();
	const quota = args.ledger.assess(model.provider, modelKey(model), args.cfg, now);
	if (quota.exhaustedScoped.length > 0) {
		return { spent: true, reason: quota.exhaustedScoped.map((w) => w.reason).join(", ") };
	}
	const { billing } = billingLabel(model, args.cfg, args.registry);
	if (billing === "plan" && quota.exhaustedAccount.length > 0) {
		return { spent: true, reason: quota.exhaustedAccount.map((w) => w.reason).join(", ") };
	}
	return { spent: false };
}

/** The model a new session should open on, or undefined when nothing in the list can be used. */
export function sessionModel(args: PreferenceArgs): SessionPick | undefined {
	for (const entry of args.cfg.preference) {
		const pick = resolveEntry(entry, args);
		if (!pick) continue;
		return { ...pick, reason: `session starts on ${pick.key} (${entry}, highest preference with quota left)` };
	}
	return undefined;
}

/**
 * Keep `current` unless its subscription window is spent. Confidence and the effort tier
 * do not move the model. When the window is spent, take the next usable preference entry,
 * re-resolving the current series first so a sibling that still has quota is the best
 * remaining model in that series.
 */
export function planTurn(args: PreferenceArgs & { tier: Tier; confidence: number; current: Model<Api> | undefined; contextTokens?: number }): TurnPlan {
	const { tier, confidence, current } = args;
	const currentKey = current ? modelKey(current) : undefined;
	const held = current ? evaluateCurrent(current, args) : undefined;

	if (!current || !currentKey) {
		return {
			requestedTier: tier,
			tier,
			confidence,
			switched: false,
			reason: `${tier} effort; no current model`,
			candidates: [],
		};
	}

	const spent = subscriptionSpent(current, args);
	if (!spent.spent) {
		return {
			requestedTier: tier,
			tier,
			confidence,
			model: current,
			switched: false,
			billing: held?.assessment,
			ineligibleCurrent: held?.skipped,
			reason: held?.skipped ? `${tier} effort; keeping ${currentKey} (${held.skipped})` : `${tier} effort on ${currentKey}`,
			candidates: held ? [held] : [],
		};
	}

	const next = nextUsable(current, args);
	if (!next) {
		const why = `subscription spent (${spent.reason}); no preference model is available`;
		return {
			requestedTier: tier,
			tier,
			confidence,
			model: current,
			switched: false,
			billing: held?.assessment,
			ineligibleCurrent: why,
			reason: `${why}; keeping ${currentKey}`,
			candidates: held ? [held] : [],
		};
	}

	const chosen = evaluateCurrent(next.model, args);
	return {
		requestedTier: tier,
		tier,
		confidence,
		model: next.model,
		switched: true,
		billing: chosen?.assessment,
		reason: `subscription spent (${spent.reason}); ${currentKey} -> ${next.key}`,
		candidates: [held, chosen].filter((c): c is Candidate => c !== undefined),
	};
}

/**
 * Best usable model for one preference entry, or undefined when the entry cannot be used.
 * When the series' own subscription provider is in the catalog, other providers of the same
 * series are not a fallback: a spent Claude subscription moves to the next series rather than
 * onto a pay-per-token twin of the same model.
 */
export function resolveEntry(entry: string, args: PreferenceArgs): Resolved | undefined {
	const pool = preferredPool(entry, candidatesFor(entry, args));
	const usable = pool.filter((model) => gate(model, args).ok);
	if (usable.length === 0) return undefined;
	usable.sort((a, b) => compareModels(entry, a, b));
	const model = usable[0]!;
	return { entry, model, key: modelKey(model) };
}

/** The first subscription provider in the list that actually offers this series, else the whole set. */
function preferredPool(entry: string, models: Model<Api>[]): Model<Api>[] {
	const preferred = SERIES_PROVIDER[entry.toLowerCase() as SeriesName];
	if (!preferred) return models;
	for (const provider of preferred) {
		const onProvider = models.filter((model) => model.provider === provider);
		if (onProvider.length > 0) return onProvider;
	}
	return models;
}

function nextUsable(current: Model<Api>, args: PreferenceArgs): Resolved | undefined {
	const entries = args.cfg.preference;
	const currentKey = modelKey(current);
	const idx = entries.findIndex((entry) => entryCovers(entry, current));
	const order = idx >= 0 ? [...entries.slice(idx), ...entries.slice(0, idx)] : [...entries];
	for (const entry of order) {
		const pick = resolveEntry(entry, args);
		if (pick && pick.key !== currentKey) return pick;
	}
	return undefined;
}

function candidatesFor(entry: string, args: PreferenceArgs): Model<Api>[] {
	if (entry.includes("/")) {
		const found = args.models.find((model) => modelKey(model) === entry) ?? findKey(entry, args.registry);
		return found ? [found] : [];
	}
	return args.models.filter((model) => idMatches(model.id, entry));
}

function findKey(key: string, registry: ModelRegistry): Model<Api> | undefined {
	const slash = key.indexOf("/");
	if (slash < 0) return undefined;
	return registry.find(key.slice(0, slash), key.slice(slash + 1));
}

function entryCovers(entry: string, model: Model<Api>): boolean {
	if (entry.includes("/")) return entry === modelKey(model);
	return idMatches(model.id, entry);
}

function idMatches(id: string, entry: string): boolean {
	const named = SERIES_ID[entry.toLowerCase() as SeriesName];
	if (named) return named.test(id);
	return id.toLowerCase().includes(entry.toLowerCase());
}

/** Newer version first; a tied version prefers the series' subscription provider. */
function compareModels(entry: string, a: Model<Api>, b: Model<Api>): number {
	const byVersion = versionCompare(b.id, a.id);
	if (byVersion !== 0) return byVersion;
	const byProvider = providerRank(entry, a.provider) - providerRank(entry, b.provider);
	if (byProvider !== 0) return byProvider;
	return modelKey(a).localeCompare(modelKey(b));
}

function providerRank(entry: string, provider: string): number {
	const list = SERIES_PROVIDER[entry.toLowerCase() as SeriesName];
	if (!list) return 100;
	const at = list.indexOf(provider);
	return at === -1 ? 50 : at;
}

/** Positive when `a` is a newer version than `b`. A missing trailing component loses to an explicit one (`5` < `5-1`). */
export function versionCompare(a: string, b: string): number {
	const pa = versionParts(a);
	const pb = versionParts(b);
	const n = Math.max(pa.length, pb.length);
	for (let i = 0; i < n; i++) {
		const da = pa[i] ?? -1;
		const db = pb[i] ?? -1;
		if (da !== db) return da - db;
	}
	return 0;
}

/** Numeric components up to the first date-like one (4+ digits: `0709`, `20250514`), which is a snapshot, not a version. */
function versionParts(id: string): number[] {
	const parts: number[] = [];
	for (const m of id.matchAll(/\d+/g)) {
		if (m[0].length >= 4) break;
		parts.push(Number(m[0]));
	}
	return parts;
}

function gate(model: Model<Api>, args: PreferenceArgs): { ok: true } | { ok: false; why: string } {
	if (!args.registry.hasConfiguredAuth(model)) return { ok: false, why: "no auth" };
	const spent = subscriptionSpent(model, args);
	if (spent.spent) return { ok: false, why: `subscription spent (${spent.reason})` };
	const assessment = assessBilling({ model, cfg: args.cfg, registry: args.registry, ledger: args.ledger, now: args.now });
	if (assessment.eligibility === "excluded") return { ok: false, why: assessment.reason };
	return { ok: true };
}

function evaluateCurrent(model: Model<Api>, args: PreferenceArgs & { tier: Tier; confidence: number; current: Model<Api> | undefined; contextTokens?: number }): Candidate {
	return evaluateCandidate(
		modelKey(model),
		{
			tier: args.tier,
			confidence: args.confidence,
			current: args.current,
			registry: args.registry,
			cfg: args.cfg,
			ledger: args.ledger,
			contextTokens: args.contextTokens ?? 0,
			now: args.now,
		},
		args.current ? modelKey(args.current) : undefined,
	);
}
