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
import type { EntitlementSource, RouterConfig } from "./config.ts";
import type { EntitlementFacts, Ledger, WindowState } from "./ledger.ts";

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
	const keys = [...Object.values(cfg.tiers).flat(), ...cfg.parallel.models];
	return [...new Set(keys.map((k) => k.slice(0, k.indexOf("/"))).filter(Boolean))];
}

/**
 * Probe every configured provider whose evidence is missing or older than the configured
 * interval. Always resolves; individual failures are recorded, not thrown.
 */
export async function refreshEntitlements(opts: ProbeOptions): Promise<void> {
	const { cfg, ledger } = opts;
	if (!cfg.billing.probe.enabled) return;
	const now = opts.now ?? Date.now();
	const providers = opts.providers ?? routableProviders(cfg);
	const due = providers.filter((p) => cfg.entitlement[p] && isDue(ledger, p, cfg, now));
	await Promise.all(due.map((p) => probeProvider(p, cfg.entitlement[p]!, opts, now)));
}

function isDue(ledger: Ledger, provider: string, cfg: RouterConfig, now: number): boolean {
	const probedAt = ledger.peekProvider(provider)?.probedAt;
	return probedAt === undefined || now - probedAt >= cfg.billing.probe.minIntervalMinutes * 60_000;
}

async function probeProvider(provider: string, source: EntitlementSource, opts: ProbeOptions, now: number): Promise<void> {
	const { cfg, registry, ledger } = opts;
	const doFetch = opts.fetchImpl ?? fetch;
	let token: string | undefined;
	try {
		token = await registry.getApiKeyForProvider(source.authProvider ?? provider);
	} catch (err) {
		ledger.recordProbeError(provider, `credential unavailable: ${redact(errText(err))}`, now);
		return;
	}
	if (!token) {
		ledger.recordProbeError(provider, `no ${source.authProvider ?? provider} credential to query entitlement with`, now);
		return;
	}
	try {
		const res = await doFetch(source.url, {
			method: "GET",
			headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(source.headers ?? {}) },
			signal: AbortSignal.timeout(cfg.billing.probe.timeoutMs),
		});
		if (!res.ok) {
			ledger.recordProbeError(provider, `entitlement query returned HTTP ${res.status}`, now);
			return;
		}
		const facts = parseEntitlement(source.kind, (await res.json()) as unknown);
		ledger.applyEntitlement(provider, facts, now);
	} catch (err) {
		ledger.recordProbeError(provider, `entitlement query failed: ${redact(errText(err))}`, now);
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
	if (disabledReason) facts.credits = { disabledReason, hasCredits: false };
	else if (overage) facts.credits = { hasCredits: overage.status !== "rejected" };
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
		addCodexRateLimit(facts.windows!, `${slug(name)}:`, obj(e?.rate_limit));
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
		windows[id] = out;
	}
	// `limit_reached` names the credential as spent without naming the window; attribute it to
	// the fullest window so a model-scoped family stays distinguishable from the account limit.
	if (reached && worst) windows[worst.id]!.status = "rejected";
}

/** `GET /api/v1/key`. A prepaid key cap, not a subscription: recorded so a spent key blocks. */
function parseOpenRouterKey(body: unknown): EntitlementFacts {
	const data = obj(obj(body)?.data) ?? obj(body);
	const facts: EntitlementFacts = { windows: {} };
	const limit = numOf(data?.limit);
	const remaining = numOf(data?.limit_remaining);
	if (limit !== undefined && limit > 0 && remaining !== undefined) {
		facts.windows!.key_limit = { utilization: Math.min(1, Math.max(0, 1 - remaining / limit)) };
		facts.credits = { hasCredits: remaining > 0, balance: String(remaining) };
	} else if (data !== undefined && "limit" in data && data.limit === null) {
		// An explicit null cap means the key is uncapped, not that the field was missing.
		facts.credits = { unlimited: true };
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

export function slug(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function errText(err: unknown): string {
	return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Defence in depth: never let a credential-looking string reach a stored error message. */
export function redact(text: string): string {
	return text.replace(/\b(?:sk|vck|oat|sess)[-_][A-Za-z0-9._-]{8,}/gi, "[redacted]").replace(/\b[A-Za-z0-9._-]{40,}\b/g, "[redacted]").slice(0, 200);
}
