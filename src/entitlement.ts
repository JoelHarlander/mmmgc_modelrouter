/**
 * Read-only entitlement / usage probes.
 *
 * These are the "is this really covered by the subscription?" queries. They hit the providers'
 * own usage endpoints (docs/research/plan-quotas.md), never an inference endpoint, so probing a
 * provider costs nothing and cannot bill a token. Failures are recorded as failures: the router
 * then routes on an unverified basis and says so, rather than assuming either answer.
 *
 * Nothing here logs, stores or returns a credential value.
 */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { credentialOf, type EntitlementSource, type RouterConfig, routableModels } from "./config.ts";
import { type EntitlementFacts, type Ledger, meteredModel, type WindowState } from "./ledger.ts";

type RawWindow = Omit<WindowState, "source" | "lastSeen">;

/** Anthropic's poll payload names windows differently from its headers. */
const ANTHROPIC_WINDOW_IDS: Record<string, string> = {
	five_hour: "5h",
	seven_day: "7d",
	seven_day_overage_included: "7d_oi",
	seven_day_opus: "7d_opus",
	seven_day_sonnet: "7d_sonnet",
	overage: "overage",
};

export interface ProbeOptions {
	cfg: RouterConfig;
	registry: ModelRegistry;
	ledger: Ledger;
	/** Providers worth probing; defaults to every provider named in the config. */
	providers?: string[];
	now?: number;
	/** Injectable for tests. Defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

/** Providers named anywhere the router can route to. */
export function routableProviders(cfg: RouterConfig): string[] {
	return [...new Set(routableModels(cfg).map((k) => k.slice(0, k.indexOf("/"))).filter(Boolean))];
}

/**
 * Establish which provider ids are one account, then probe each account whose evidence is missing
 * or older than the configured interval. An account is one probe, not one per id. Always resolves;
 * individual failures are recorded, not thrown.
 */
export async function refreshEntitlements(opts: ProbeOptions): Promise<void> {
	const { cfg, ledger } = opts;
	if (!cfg.billing.probe.enabled) return;
	const now = opts.now ?? Date.now();
	const providers = opts.providers ?? routableProviders(cfg);
	// Identity first, so a link proven now collapses this turn's probes. The links live in this
	// session's memory, so a session that has no answer yet asks for one whatever the probe's
	// interval says: routing on a guess of "not shared" would file this account's windows under a
	// second name that nothing ever merges back. After that it is asked again only when the probe
	// is due, since resolving a credential can cost an OAuth refresh on the turn's critical path.
	await Promise.all(
		providers
			.filter((p) => credentialOf(cfg, p) !== p && (!ledger.accountResolved(p) || isDue(ledger, ledger.accountOf(p), cfg, now)))
			.map((p) => resolveAccount(p, opts)),
	);
	const sources = new Map<string, EntitlementSource>();
	for (const provider of providers) {
		const source = cfg.entitlement[provider];
		if (!source) continue;
		const account = ledger.accountOf(provider);
		// The credential's own entry describes the account best when the config carries one.
		if (provider === account || !sources.has(account)) sources.set(account, cfg.entitlement[account] ?? source);
	}
	const due = [...sources].filter(([account]) => isDue(ledger, account, cfg, now));
	await Promise.all(due.map(([account, source]) => probeProvider(account, source, opts, now)));
}

/**
 * Whether a provider id is one account with the credential it claims. `entitlement.<id>.authProvider`
 * only says which pair is worth asking about; the answer is the credential pi hands out for each,
 * compared here and discarded. A pair pi resolves differently is two accounts - treating them as
 * one would exclude a route on the strength of a subscription that does not bill it, while two
 * halves of one account only cost a second probe - and a lookup that answers nothing changes
 * nothing.
 */
async function resolveAccount(provider: string, opts: ProbeOptions): Promise<void> {
	const { cfg, registry, ledger } = opts;
	const declared = credentialOf(cfg, provider);
	const same = await sameCredential(registry, provider, declared, cfg);
	if (same !== undefined) ledger.linkAccount(provider, same ? declared : provider);
}

/**
 * Compared in memory and dropped: no credential value is returned, stored, logged or reported.
 * Undefined where pi resolved nothing to compare, which is not evidence either way.
 */
async function sameCredential(registry: ModelRegistry, provider: string, other: string, cfg: RouterConfig): Promise<boolean | undefined> {
	try {
		const [mine, theirs] = await Promise.all([credentialOrTimeout(registry, provider, cfg), credentialOrTimeout(registry, other, cfg)]);
		if (!mine || !theirs) return undefined;
		return mine === theirs;
	} catch {
		return undefined;
	}
}

/**
 * Resolving a credential can take a cross-process store lock and an OAuth refresh, and this runs
 * before the turn's routing decision: it waits `billing.probe.timeoutMs` like the probe itself and
 * then gives up, leaving the last answer standing rather than the turn.
 */
async function credentialOrTimeout(registry: ModelRegistry, provider: string, cfg: RouterConfig): Promise<string | undefined> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			registry.getApiKeyForProvider(provider),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), cfg.billing.probe.timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function isDue(ledger: Ledger, account: string, cfg: RouterConfig, now: number): boolean {
	const probedAt = ledger.peekProvider(account)?.probedAt;
	return probedAt === undefined || now - probedAt >= cfg.billing.probe.minIntervalMinutes * 60_000;
}

async function probeProvider(account: string, source: EntitlementSource, opts: ProbeOptions, now: number): Promise<void> {
	const { cfg, registry, ledger } = opts;
	const doFetch = opts.fetchImpl ?? fetch;
	let token: string | undefined;
	try {
		token = await credentialOrTimeout(registry, account, cfg);
	} catch (err) {
		ledger.recordProbeError(account, `credential unavailable: ${redact(errText(err))}`, now);
		return;
	}
	if (!token) {
		ledger.recordProbeError(account, `no ${account} credential to query entitlement with`, now);
		return;
	}
	try {
		const res = await doFetch(source.url, {
			method: "GET",
			headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(source.headers ?? {}) },
			signal: AbortSignal.timeout(cfg.billing.probe.timeoutMs),
		});
		if (!res.ok) {
			ledger.recordProbeError(account, `entitlement query returned HTTP ${res.status}`, now);
			return;
		}
		const facts = parseEntitlement(source.kind, (await res.json()) as unknown);
		ledger.applyEntitlement(account, facts, now);
	} catch (err) {
		ledger.recordProbeError(account, `entitlement query failed: ${redact(errText(err))}`, now);
	}
}

/** Shape-specific parsing, kept lenient: unknown fields are ignored, known ones are normalised. */
export function parseEntitlement(kind: EntitlementSource["kind"], body: unknown): EntitlementFacts {
	switch (kind) {
		case "anthropic-oauth-usage":
			return parseAnthropicUsage(body);
		case "codex-wham-usage":
			return parseCodexUsage(body);
		case "openrouter-key":
			return parseOpenRouterKey(body);
		case "vercel-credits":
			return parseVercelCredits(body);
	}
}

/**
 * `GET /api/oauth/usage`. Utilization is 0-100 on this path (unlike the 0-1 headers), so it is
 * divided here and nowhere else.
 */
function parseAnthropicUsage(body: unknown): EntitlementFacts {
	const root = obj(body);
	const windows: Record<string, RawWindow> = {};
	// Claude Code exposes the same pools at the top level or nested under `rate_limits`.
	const pools = obj(root?.rate_limits) ?? root;
	for (const [name, id] of Object.entries(ANTHROPIC_WINDOW_IDS)) {
		const raw = obj(pools?.[name]);
		if (!raw) continue;
		const w: RawWindow = {};
		const util = numOf(raw.utilization);
		if (util !== undefined) w.utilization = Math.min(1, Math.max(0, util / 100));
		const status = strOf(raw.status);
		if (status) w.status = status;
		const reset = epochMs(raw.resets_at ?? raw.reset_at ?? raw.resets_at_unix);
		if (reset !== undefined) w.resetAt = reset;
		if (Object.keys(w).length > 0) windows[id] = w;
	}
	const facts: EntitlementFacts = { windows };
	const plan = strOf(root?.plan ?? root?.plan_type ?? obj(root?.subscription)?.plan);
	if (plan) facts.plan = plan;
	const overage = obj(pools?.overage);
	const disabledReason = strOf(root?.overage_disabled_reason ?? overage?.disabled_reason);
	// The overage pool's mere presence says nothing about credit availability: without an explicit
	// status the credit state stays unknown rather than being read as "credits available".
	const overageStatus = strOf(overage?.status);
	if (disabledReason) facts.credits = { disabledReason, hasCredits: false };
	else if (overageStatus) facts.credits = { hasCredits: overageStatus !== "rejected" };
	return facts;
}

/** `GET /backend-api/wham/usage`. `used_percent` is 0-100; per-model families come as a list. */
function parseCodexUsage(body: unknown): EntitlementFacts {
	const root = obj(body);
	const facts: EntitlementFacts = { windows: {} };
	const plan = strOf(root?.plan_type);
	if (plan) facts.plan = plan;
	addCodexRateLimit(facts.windows!, "", obj(root?.rate_limit));
	for (const entry of arr(root?.additional_rate_limits)) {
		const e = obj(entry);
		const name = strOf(e?.limit_name) ?? strOf(e?.metered_feature);
		if (!name) continue;
		addCodexRateLimit(facts.windows!, `${meteredModel(name)}:`, obj(e?.rate_limit));
	}
	const credits = obj(root?.credits);
	if (credits) {
		facts.credits = {
			hasCredits: boolOf(credits.has_credits),
			unlimited: boolOf(credits.unlimited),
			balance: credits.balance === undefined ? undefined : String(credits.balance),
		};
	}
	return facts;
}

function addCodexRateLimit(windows: Record<string, RawWindow>, prefix: string, rateLimit: Record<string, unknown> | undefined): void {
	if (!rateLimit) return;
	const reached = boolOf(rateLimit.limit_reached) === true || boolOf(rateLimit.allowed) === false;
	const roles: [string, unknown][] = [
		["primary", rateLimit.primary_window],
		["secondary", rateLimit.secondary_window],
	];
	let worst: { id: string; used: number } | undefined;
	for (const [role, raw] of roles) {
		const w = obj(raw);
		if (!w) continue;
		const id = `${prefix}${role}`;
		const out: RawWindow = {};
		const used = numOf(w.used_percent);
		if (used !== undefined) {
			out.utilization = Math.min(1, Math.max(0, used / 100));
			if (worst === undefined || used > worst.used) worst = { id, used };
		}
		const reset = epochMs(w.reset_at) ?? (numOf(w.reset_after_seconds) !== undefined ? Date.now() + numOf(w.reset_after_seconds)! * 1000 : undefined);
		if (reset !== undefined) out.resetAt = reset;
		// A window the payload states nothing about is no news, not proof of headroom: recording it
		// empty would replace whatever the response headers already established.
		if (Object.keys(out).length > 0) windows[id] = out;
	}
	// `limit_reached` names the credential as spent without naming the window; attribute it to
	// the fullest window so a model-scoped family stays distinguishable from the account limit,
	// and to the group's primary window when no window carried a utilization at all.
	if (reached) (windows[worst?.id ?? `${prefix}primary`] ??= {}).status = "rejected";
}

/**
 * `GET /api/v1/key`. A prepaid key cap, not a subscription window: the balance is recorded as
 * remaining credit, so what is left is spendable to the last cent and only an empty key blocks.
 */
function parseOpenRouterKey(body: unknown): EntitlementFacts {
	const data = obj(obj(body)?.data) ?? obj(body);
	const facts: EntitlementFacts = { windows: {} };
	const limit = numOf(data?.limit);
	const remaining = numOf(data?.limit_remaining);
	// An uncapped key says nothing about the account balance behind it, which this endpoint never
	// reports, so credit state stays unknown rather than being called unlimited.
	if (limit !== undefined && limit > 0 && remaining !== undefined) {
		facts.credits = { hasCredits: remaining > 0, balance: String(remaining) };
	}
	const free = obj(data?.free_model_daily_requests);
	const used = numOf(free?.used);
	const freeLimit = numOf(free?.limit);
	if (used !== undefined && freeLimit !== undefined && freeLimit > 0) {
		facts.windows!.free_daily = { utilization: Math.min(1, Math.max(0, used / freeLimit)) };
	}
	return facts;
}

/** Gateway credit balance. Funded separately from any model subscription. */
function parseVercelCredits(body: unknown): EntitlementFacts {
	const root = obj(body) ?? {};
	const balance = numOf(root.balance ?? obj(root.credits)?.balance);
	if (balance === undefined) return { windows: {} };
	return { windows: {}, credits: { hasCredits: balance > 0, balance: String(balance) } };
}

// ---- parsing helpers -------------------------------------------------------

function obj(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function arr(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}

function numOf(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
	return undefined;
}

function strOf(v: unknown): string | undefined {
	return typeof v === "string" && v !== "" ? v : undefined;
}

function boolOf(v: unknown): boolean | undefined {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") return /^(true|1|yes)$/i.test(v.trim()) ? true : /^(false|0|no)$/i.test(v.trim()) ? false : undefined;
	return undefined;
}

function epochMs(v: unknown): number | undefined {
	const n = numOf(v);
	if (n !== undefined) return n > 1e12 ? n : n * 1000;
	const s = strOf(v);
	if (!s) return undefined;
	const parsed = Date.parse(s);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function errText(err: unknown): string {
	return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Defence in depth: never let a credential-looking string reach a stored error message. */
export function redact(text: string): string {
	return text.replace(/\b(?:sk|vck|oat|sess)[-_][A-Za-z0-9._-]{8,}/gi, "[redacted]").replace(/\b[A-Za-z0-9._-]{40,}\b/g, "[redacted]").slice(0, 200);
}
