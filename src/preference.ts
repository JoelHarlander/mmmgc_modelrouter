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
import { type Gate, globMatch, modelKey, type RouterConfig, type Tier } from "./config.ts";
import type { Ledger } from "./ledger.ts";
import { type Candidate, evaluateCandidate } from "./router.ts";

export const SERIES = ["fable", "grok", "opus", "sonnet", "astra", "sol"] as const;
export type SeriesName = (typeof SERIES)[number];

/** Model-id test for each series. The provider is a separate tie-break. */
const SERIES_ID: Record<SeriesName, RegExp> = {
	fable: /fable/i,
	grok: /grok/i,
	opus: /opus/i,
	sonnet: /sonnet/i,
	astra: /astra/i,
	// A whole token: `sol` is gpt-6.1-sol, not upstage/solar-pro-3.
	sol: /(^|[^a-z0-9])sol([^a-z0-9]|$)/i,
};

/**
 * When two models in a series have the same version, prefer the subscription provider
 * the installation actually bills that series on.
 */
const SERIES_PROVIDER: Record<SeriesName, readonly string[]> = {
	fable: ["claude-bridge", "anthropic"],
	grok: ["xai"],
	opus: ["claude-bridge", "anthropic"],
	sonnet: ["claude-bridge", "anthropic"],
	astra: ["openai-codex", "openai"],
	sol: ["openai-codex", "openai"],
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
	/** Set when this is the configured pay-per-token backup rather than a preference entry. */
	backup?: boolean;
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

/**
 * The model a new session should open on, or undefined when nothing can be used. Three passes,
 * so a gate is a preference and never a lockout: entries whose gate is open, then any usable
 * entry (a gated subscription still beats paying), then the pay-per-token backup.
 */
export function sessionModel(args: PreferenceArgs): SessionPick | undefined {
	for (const entry of args.cfg.preference) {
		const pick = resolveThroughGates(entry, args);
		if (pick) return { ...pick, reason: `session starts on ${pick.key} (${entry}, highest preference with quota left)` };
	}
	const gated = leastGated(args.cfg.preference, args);
	if (gated) return { ...gated, reason: `session starts on ${gated.key} (${gated.entry}; every open entry is past its usage gate, so the least-used one is taken)` };
	const backup = resolveBackup(args);
	if (backup) return { ...backup, reason: `session starts on ${backup.key} (backup: no preference entry is usable)` };
	return undefined;
}

/** A gate that has tripped for `model`: the highest governing window has reached `gate.at`. */
export function gateTrip(model: Model<Api>, args: PreferenceArgs): { gate: Gate; used: number } | undefined {
	const gate = args.cfg.gates.find((g) => entryCovers(g.series, model));
	if (!gate) return undefined;
	const used = args.ledger.assess(model.provider, modelKey(model), args.cfg, args.now ?? Date.now()).modelUtilization;
	return used !== undefined && used >= gate.at ? { gate, used } : undefined;
}

export interface GateReading {
	gate: Gate;
	/** The model the gate's series resolves to right now, if any. */
	model?: Model<Api>;
	/** Its highest live window utilization, or undefined when nothing has reported one (the gate is inert). */
	used?: number;
	tripped: boolean;
}

/** What each gate sees right now, for `/router`: a gate with no reading never trips, and should say so. */
export function gateReadings(args: PreferenceArgs): GateReading[] {
	return args.cfg.gates.map((gate) => {
		const pick = resolveEntry(gate.series, args);
		const used = pick ? args.ledger.assess(pick.model.provider, pick.key, args.cfg, args.now ?? Date.now()).modelUtilization : undefined;
		return { gate, model: pick?.model, used, tripped: used !== undefined && used >= gate.at };
	});
}

function percent(n: number): string {
	return `${Math.round(n * 100)}%`;
}

/**
 * `resolveEntry`, but an entry past its usage gate hands over to the gate's `then` (itself gated
 * in turn), or yields nothing so the caller tries the next preference entry. `seen` stops a loop.
 */
function resolveThroughGates(entry: string, args: PreferenceArgs, seen = new Set<string>()): Resolved | undefined {
	const pick = resolveEntry(entry, args);
	if (!pick) return undefined;
	const trip = gateTrip(pick.model, args);
	if (!trip) return pick;
	if (seen.has(entry)) return undefined;
	seen.add(entry);
	return trip.gate.then ? resolveThroughGates(trip.gate.then, args, seen) : undefined;
}

/** Models the backup entry names: a glob over `provider/modelId`, a concrete key, or a series. */
function backupCandidates(args: PreferenceArgs): Model<Api>[] {
	const entry = args.cfg.backup;
	if (!entry) return [];
	// `:batch`, `:free`, `:thinking` and the like are routes to a model, not a newer model: skip them unless the glob asks.
	if (entry.includes("*")) return args.models.filter((model) => globMatch(entry, modelKey(model)) && (entry.includes(":") || !model.id.includes(":")));
	return candidatesFor(entry, args);
}

/** The newest usable backup model. A tie on version prefers the shorter id: `glm-5.3` over `glm-5.3-flash`. */
export function resolveBackup(args: PreferenceArgs, exclude?: string): Resolved | undefined {
	const usable = backupCandidates(args).filter((model) => modelKey(model) !== exclude && gate(model, args).ok);
	usable.sort((a, b) => versionCompare(b.id, a.id) || a.id.length - b.id.length || modelKey(a).localeCompare(modelKey(b)));
	const model = usable[0];
	return model ? { entry: args.cfg.backup, key: modelKey(model), model, backup: true } : undefined;
}

/** True when `model` is the backup and no preference entry also claims it. */
function onBackup(model: Model<Api>, args: PreferenceArgs): boolean {
	if (args.cfg.preference.some((entry) => entryCovers(entry, model))) return false;
	return backupCandidates(args).some((candidate) => modelKey(candidate) === modelKey(model));
}

/**
 * A model change a still-unspent `current` should make: off the backup once any preference entry
 * is usable again, or off a model past its usage gate. Undefined keeps `current`.
 */
function reroute(current: Model<Api>, args: PreferenceArgs): { next: Resolved; why: string } | undefined {
	const currentKey = modelKey(current);
	if (onBackup(current, args)) {
		const back = firstUsable(args.cfg.preference, args, currentKey);
		return back ? { next: back, why: `backup ${currentKey} is only for when nothing else is usable, and ${back.entry} is` } : undefined;
	}
	const trip = gateTrip(current, args);
	if (!trip) return undefined;
	const order = trip.gate.then ? [trip.gate.then, ...rotated(current, args)] : rotated(current, args);
	const why = `${trip.gate.series} gate: ${percent(trip.used)} used >= ${percent(trip.gate.at)}`;
	for (const entry of order) {
		const pick = resolveThroughGates(entry, args);
		if (pick && pick.key !== currentKey) return { next: pick, why };
	}
	// Everything else is past its gate too. Gates only demote, so move to the least-used one, but only on a
	// strict improvement: that is what keeps two gated models from trading the session back and forth.
	const alt = leastGated(order, args, currentKey);
	if (alt && usedOf(alt.model, args) < trip.used) return { next: alt, why: `${why}; ${alt.key} has used less (${percent(usedOf(alt.model, args))})` };
	return undefined;
}

/** Highest live quota utilization governing `model`, 0..1; none known reads as 0. */
function usedOf(model: Model<Api>, args: PreferenceArgs): number {
	return args.ledger.assess(model.provider, modelKey(model), args.cfg, args.now ?? Date.now()).modelUtilization ?? 0;
}

/** First usable entry in `entries`, preferring open gates, never `exclude`. */
function firstUsable(entries: readonly string[], args: PreferenceArgs, exclude?: string): Resolved | undefined {
	for (const entry of entries) {
		const pick = resolveThroughGates(entry, args);
		if (pick && pick.key !== exclude) return pick;
	}
	return leastGated(entries, args, exclude);
}

/** Of the usable entries, the one that has used the least of its quota; preference order breaks a tie. */
function leastGated(entries: readonly string[], args: PreferenceArgs, exclude?: string): Resolved | undefined {
	let best: Resolved | undefined;
	let bestUsed = Number.POSITIVE_INFINITY;
	for (const entry of entries) {
		const pick = resolveEntry(entry, args);
		if (!pick || pick.key === exclude) continue;
		const used = usedOf(pick.model, args);
		if (used < bestUsed) {
			best = pick;
			bestUsed = used;
		}
	}
	return best;
}

/** The preference list starting at the entry that covers `current`, wrapping once. */
function rotated(current: Model<Api>, args: PreferenceArgs): string[] {
	const entries = args.cfg.preference;
	const idx = entries.findIndex((entry) => entryCovers(entry, current));
	return idx >= 0 ? [...entries.slice(idx), ...entries.slice(0, idx)] : [...entries];
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
		const moved = reroute(current, args);
		if (moved) return switchPlan(args, held, moved.next, `${moved.why}; ${currentKey} -> ${moved.next.key}`);
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

	return switchPlan(args, held, next, `subscription spent (${spent.reason}); ${currentKey} -> ${next.key}${next.backup ? " (backup)" : ""}`);
}

function switchPlan(
	args: PreferenceArgs & { tier: Tier; confidence: number; current: Model<Api> | undefined; contextTokens?: number },
	held: Candidate | undefined,
	next: Resolved,
	reason: string,
): TurnPlan {
	const chosen = evaluateCurrent(next.model, args);
	return {
		requestedTier: args.tier,
		tier: args.tier,
		confidence: args.confidence,
		model: next.model,
		switched: true,
		billing: chosen?.assessment,
		reason,
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
	return firstUsable(rotated(current, args), args, modelKey(current)) ?? resolveBackup(args, modelKey(current));
}

function candidatesFor(entry: string, args: PreferenceArgs): Model<Api>[] {
	if (entry.includes("/")) {
		const found = args.models.find((model) => modelKey(model) === entry) ?? findKey(entry, args.registry);
		return found ? [found] : [];
	}
	const matched = args.models.filter((model) => idMatches(model.id, entry));
	// `:batch`, `:free`, `:thinking` and the like are routes to a model, not a newer model: take the plain ids
	// when there are any, and the variants only when that is all there is.
	const plain = matched.filter((model) => !model.id.includes(":"));
	return plain.length > 0 ? plain : matched;
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

/** A built-in series by its pattern; any other name by whole tokens, so `glm` is glm-5.3 and `sol` is not solar. */
function idMatches(id: string, entry: string): boolean {
	const named = SERIES_ID[entry.toLowerCase() as SeriesName];
	if (named) return named.test(id);
	const token = entry.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "i").test(id);
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

/**
 * Numeric components up to the first date-like one (4+ digits: `0709`, `20250514`), which is a snapshot, not a
 * version. A component after a dot is a decimal fraction: xAI's grok-4.20 came before grok-4.3 and grok-4.7, as
 * glm-5.3 follows glm-5.2. Components after a dash stay whole numbers (claude-opus-5-5).
 */
function versionParts(id: string): number[] {
	const parts: number[] = [];
	for (const m of id.matchAll(/\d+/g)) {
		if (m[0].length >= 4) break;
		parts.push(id[m.index - 1] === "." ? Number(`0.${m[0]}`) : Number(m[0]));
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
