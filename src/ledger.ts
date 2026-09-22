/**
 * Usage ledger + subscription quota state.
 *
 * - Records tokens/cost per provider/model from assistant messages (session + persisted totals).
 * - Harvests quota windows and credit facts from response headers (Anthropic unified, Codex) and
 *   429/402 responses, and accepts the same facts from the read-only entitlement polls in
 *   `entitlement.ts`, so routing can tell subscription usage from extra billed usage.
 * - Windows are kept individually, so a model-scoped window (Anthropic's Fable bucket, a Codex
 *   per-model family) can exclude one model while its provider stays usable.
 * - The shared usage file is written under a lock and merged against what is on disk, so
 *   concurrent sessions do not clobber each other's totals.
 *
 * Header names, value scales and JSON shapes per docs/research/plan-quotas.md.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { anyGlobMatch, globMatch, type RouterConfig } from "./config.ts";

export interface ModelTotals {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}

/** One quota window (Anthropic `5h`/`7d`/`7d_oi`/`overage`, Codex `primary`/`secondary`/`<family>:primary`). */
export interface WindowState {
	/** 0..1, normalised from whichever scale the source uses. */
	utilization?: number;
	/** `allowed` | `allowed_warning` | `rejected`, when the source reports one. */
	status?: string;
	/** Epoch ms when this window resets. */
	resetAt?: number;
	source: EvidenceSource;
	lastSeen: number;
}

/** Extra billed usage beyond the subscription: ChatGPT credits, Anthropic usage credits (overage). */
export interface CreditState {
	hasCredits?: boolean;
	unlimited?: boolean;
	/** Opaque balance string as the provider reports it. Never a secret. */
	balance?: string;
	/** Non-empty when the account has extra usage switched off. */
	disabledReason?: string;
	source: EvidenceSource;
	lastSeen: number;
}

export type EvidenceSource = "header" | "poll";

export interface ProviderState {
	/** Plan id as the provider reports it (`plus`, `pro`, ...). Never inferred from a name. */
	plan?: string;
	windows: Record<string, WindowState>;
	credits?: CreditState;
	/** Epoch ms until which the provider is considered unusable (429/402). */
	cooldownUntil?: number;
	cooldownReason?: string;
	/** Last read-only entitlement poll. */
	probedAt?: number;
	probeError?: string;
	lastSeen: number;
}

interface LedgerFile {
	version: 2;
	totals: Record<string, ModelTotals>;
	providers: Record<string, ProviderState>;
}

/** Windows that meter extra billed usage rather than included subscription usage. */
const OVERAGE_WINDOWS = new Set(["overage"]);

/** What the router needs to know about one provider/model pair right now. */
export interface QuotaAssessment {
	cooldown?: { until: number; reason: string };
	/** Account-wide windows that are exhausted (the whole credential is spent). */
	exhaustedAccount: ExhaustedWindow[];
	/** Model-scoped windows governing this model that are exhausted. */
	exhaustedScoped: ExhaustedWindow[];
	/** Account-wide windows this provider actually reported. Empty means nothing was observed. */
	accountWindows: string[];
	/** Highest account-wide utilization observed, 0..1. */
	accountUtilization?: number;
	credits?: CreditState;
	/** The extra-billed bucket, when the provider reports one. */
	overage?: WindowState;
	/** Newest evidence timestamp across everything consulted. */
	lastEvidenceAt?: number;
	/** Distinct evidence sources behind this assessment. */
	sources: EvidenceSource[];
	plan?: string;
}

export interface ExhaustedWindow {
	id: string;
	reason: string;
}

export class Ledger {
	readonly session: Record<string, ModelTotals> = {};
	private data: LedgerFile = { version: 2, totals: {}, providers: {} };
	/** `data.totals` as of the last disk sync; the delta against it is what a merged save applies. */
	private baseline: Record<string, ModelTotals> = {};
	private saveTimer: NodeJS.Timeout | undefined;

	constructor(private readonly file: string) {
		const loaded = readLedgerFile(file);
		if (loaded) {
			this.data = loaded;
			this.baseline = structuredClone(loaded.totals);
		}
	}

	record(provider: string, modelId: string, usage: Usage | undefined): void {
		if (!usage) return;
		const key = `${provider}/${modelId}`;
		for (const bucket of [this.session, this.data.totals]) {
			const t = (bucket[key] ??= emptyTotals());
			t.calls += 1;
			t.input += usage.input ?? 0;
			t.output += usage.output ?? 0;
			t.cacheRead += usage.cacheRead ?? 0;
			t.cacheWrite += usage.cacheWrite ?? 0;
			t.costUsd += usage.cost?.total ?? 0;
		}
		this.scheduleSave();
	}

	/** Jev classification calls are tracked under a synthetic "jev" provider so the router's own overhead is visible. */
	recordJev(transport: string, model: string, inputTokens: number, outputTokens: number, costUsd: number): void {
		this.record(`jev:${transport}`, model, {
			input: inputTokens,
			output: outputTokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + outputTokens,
			cost: { input: costUsd, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd },
		});
	}

	/** Called from after_provider_response. Headers are lower-cased by pi. */
	observeResponse(provider: string, status: number, headers: Record<string, string>, cfg: RouterConfig, now = Date.now()): void {
		const state = this.providerState(provider, now);
		const h = (name: string) => headers[name] ?? headers[name.toLowerCase()];

		applyAnthropicHeaders(state, headers, now);
		applyCodexHeaders(state, headers, now);

		if (status === 429 || status === 402) {
			// A bare 429 with no quota headers is Anthropic's entitlement gate, not quota pressure
			// (docs/research/plan-quotas.md §1): cool down briefly, but never record it as utilization.
			const retryAfter = num(h("retry-after"));
			const fallbackMs = cfg.plan.cooldownMinutesOn429 * 60_000;
			const rejectedReset = earliestRejectedReset(state, now);
			const until = retryAfter !== undefined ? now + retryAfter * 1000 : (rejectedReset ?? now + fallbackMs);
			state.cooldownUntil = until;
			state.cooldownReason = status === 402 ? "budget exhausted (402)" : "rate limited (429)";
		} else if (status >= 200 && status < 300 && state.cooldownUntil && !hasRejectedWindow(state, now)) {
			// A successful call clears a stale cooldown.
			state.cooldownUntil = undefined;
			state.cooldownReason = undefined;
		}
		this.scheduleSave();
	}

	/** Merge facts from a read-only entitlement poll (see entitlement.ts). Never inference. */
	applyEntitlement(provider: string, facts: EntitlementFacts, now = Date.now()): void {
		const state = this.providerState(provider, now);
		state.probedAt = now;
		state.probeError = undefined;
		if (facts.plan) state.plan = facts.plan;
		for (const [id, w] of Object.entries(facts.windows ?? {})) {
			state.windows[id] = { ...w, source: "poll", lastSeen: now };
		}
		if (facts.credits) state.credits = { ...facts.credits, source: "poll", lastSeen: now };
		this.scheduleSave();
	}

	/** Record that a probe was attempted and failed, so the age of the attempt is visible. */
	recordProbeError(provider: string, error: string, now = Date.now()): void {
		const state = this.providerState(provider, now);
		state.probedAt = now;
		state.probeError = error;
		this.scheduleSave();
	}

	/**
	 * Everything routing needs about one provider/model pair. Model-scoped windows are matched
	 * against `modelKey` through `cfg.scopes`, so an exhausted scoped quota excludes only its models.
	 */
	assess(provider: string, modelKey: string | undefined, cfg: RouterConfig, now = Date.now()): QuotaAssessment {
		const out: QuotaAssessment = { exhaustedAccount: [], exhaustedScoped: [], accountWindows: [], sources: [] };
		const state = this.data.providers[provider];
		if (!state) return out;
		out.plan = state.plan;
		out.credits = state.credits;
		const sources = new Set<EvidenceSource>();
		let newest: number | undefined;

		if (state.cooldownUntil && state.cooldownUntil > now) {
			out.cooldown = { until: state.cooldownUntil, reason: state.cooldownReason ?? "cooldown" };
		}

		for (const [id, w] of Object.entries(state.windows)) {
			sources.add(w.source);
			newest = Math.max(newest ?? 0, w.lastSeen);
			if (OVERAGE_WINDOWS.has(id)) {
				out.overage = w;
				continue;
			}
			const globs = scopeGlobs(cfg, provider, id);
			const scoped = globs !== undefined;
			if (scoped && !(modelKey && anyGlobMatch(globs, modelKey))) continue;
			const spent = windowExhausted(w, cfg, now);
			if (!scoped) {
				out.accountWindows.push(id);
				if (w.utilization !== undefined) out.accountUtilization = Math.max(out.accountUtilization ?? 0, w.utilization);
			}
			if (!spent) continue;
			(scoped ? out.exhaustedScoped : out.exhaustedAccount).push({ id, reason: `${id} ${spent}` });
		}
		if (state.credits) {
			sources.add(state.credits.source);
			newest = Math.max(newest ?? 0, state.credits.lastSeen);
		}
		out.lastEvidenceAt = newest;
		out.sources = [...sources];
		return out;
	}

	providerState(provider: string, now = Date.now()): ProviderState {
		const state = (this.data.providers[provider] ??= { windows: {}, lastSeen: now });
		state.lastSeen = now;
		return state;
	}

	peekProvider(provider: string): ProviderState | undefined {
		return this.data.providers[provider];
	}

	summaryLines(): string[] {
		const lines: string[] = [];
		const entries = Object.entries(this.session);
		if (entries.length === 0) lines.push("session: no model calls yet");
		for (const [key, t] of entries) {
			lines.push(`session ${key}: ${t.calls} calls, in ${fmt(t.input)} (cache ${fmt(t.cacheRead)}), out ${fmt(t.output)}, $${t.costUsd.toFixed(4)}`);
		}
		for (const [provider, p] of Object.entries(this.data.providers)) {
			const parts: string[] = [];
			if (p.plan) parts.push(`plan ${p.plan}`);
			for (const [id, w] of Object.entries(p.windows)) {
				const bits = [id];
				if (w.utilization !== undefined) bits.push(`${Math.round(w.utilization * 100)}%`);
				if (w.status) bits.push(w.status);
				parts.push(bits.join(" "));
			}
			if (p.credits) parts.push(describeCredits(p.credits));
			if (p.cooldownUntil && p.cooldownUntil > Date.now()) parts.push(`COOLDOWN ${p.cooldownReason}`);
			if (p.probeError) parts.push(`probe: ${p.probeError}`);
			if (parts.length) lines.push(`quota ${provider}: ${parts.join(", ")}`);
		}
		return lines;
	}

	private scheduleSave(): void {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			this.save();
		}, 2000);
		this.saveTimer.unref?.();
	}

	/**
	 * Locked read-modify-write. Totals are applied as deltas against the last disk sync, so a
	 * concurrent session's calls survive; quota facts win by recency per window.
	 */
	save(): void {
		const lock = `${this.file}.lock`;
		let held = false;
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			held = acquireLock(lock);
			const onDisk = readLedgerFile(this.file);
			const merged = onDisk ? mergeLedgers(onDisk, this.data, this.baseline) : this.data;
			const tmp = `${this.file}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(merged, null, 2));
			renameSync(tmp, this.file);
			this.data = merged;
			this.baseline = structuredClone(merged.totals);
		} catch {
			// best effort: a failed save must never break a turn
		} finally {
			if (held) releaseLock(lock);
		}
	}
}

/** Quota facts a read-only entitlement poll produced. */
export interface EntitlementFacts {
	plan?: string;
	windows?: Record<string, Omit<WindowState, "source" | "lastSeen">>;
	credits?: Omit<CreditState, "source" | "lastSeen">;
}

/**
 * Model globs a window governs, or undefined when the window is account-wide.
 * Scope keys are `"<providerGlob>:<windowId>"`; window ids may themselves contain `:`
 * (a Codex per-model family arrives as `<family>:primary`), so only the first `:` splits.
 */
export function scopeGlobs(cfg: RouterConfig, provider: string, windowId: string): string[] | undefined {
	for (const [key, globs] of Object.entries(cfg.scopes)) {
		const colon = key.indexOf(":");
		if (colon < 0) continue;
		if (key.slice(colon + 1) !== windowId) continue;
		if (globMatch(key.slice(0, colon), provider)) return globs;
	}
	return undefined;
}

/** Human reason when a window is spent, or undefined when it still has room. */
export function windowExhausted(w: WindowState, cfg: RouterConfig, now: number): string | undefined {
	if (w.resetAt !== undefined && w.resetAt <= now) return undefined;
	if (w.status === "rejected") return "rejected";
	if (w.utilization !== undefined && w.utilization >= cfg.plan.utilizationCeiling) return `${Math.round(w.utilization * 100)}% used`;
	return undefined;
}

function hasRejectedWindow(state: ProviderState, now: number): boolean {
	return Object.values(state.windows).some((w) => w.status === "rejected" && (w.resetAt === undefined || w.resetAt > now));
}

function earliestRejectedReset(state: ProviderState, now: number): number | undefined {
	const resets = Object.values(state.windows)
		.filter((w) => w.status === "rejected" && w.resetAt !== undefined && w.resetAt > now)
		.map((w) => w.resetAt!);
	return resets.length ? Math.min(...resets) : undefined;
}

export function describeCredits(c: CreditState): string {
	if (c.disabledReason) return `extra usage off (${c.disabledReason})`;
	if (c.unlimited) return "credits unlimited";
	if (c.hasCredits === false) return "no credits";
	if (c.hasCredits) return `credits available${c.balance ? ` (${c.balance})` : ""}`;
	return "credits unknown";
}

// ---- header parsing --------------------------------------------------------

const ANTHROPIC_WINDOW = /^anthropic-ratelimit-unified-(.+)-(utilization|status|reset)$/;
const CODEX_FIELD = /^x-codex-(?:(.+)-)?(primary|secondary)-(used-percent|reset-after-seconds|reset-at)$/;

/**
 * Anthropic unified headers. Utilization is already 0..1 here; the poll path is 0..100 and is
 * normalised in entitlement.ts. Unknown window names are kept verbatim rather than dropped.
 */
function applyAnthropicHeaders(state: ProviderState, headers: Record<string, string>, now: number): void {
	let touched = false;
	for (const [rawName, rawValue] of Object.entries(headers)) {
		const name = rawName.toLowerCase();
		const m = ANTHROPIC_WINDOW.exec(name);
		if (!m) continue;
		const [, id, field] = m as unknown as [string, string, string];
		const w = (state.windows[id] ??= { source: "header", lastSeen: now });
		w.source = "header";
		w.lastSeen = now;
		if (field === "utilization") w.utilization = clamp01(num(rawValue));
		else if (field === "status") w.status = rawValue;
		else if (field === "reset") w.resetAt = epochMs(rawValue);
		touched = true;
	}
	const disabled = headers["anthropic-ratelimit-unified-overage-disabled-reason"];
	if (disabled !== undefined && disabled !== "") {
		state.credits = { ...(state.credits ?? {}), disabledReason: disabled, hasCredits: false, source: "header", lastSeen: now };
		touched = true;
	}
	if (touched) state.lastSeen = now;
}

/**
 * Codex `x-codex-*` headers. `used-percent` is 0..100. Per-model families arrive as
 * `x-codex-<family>-primary-*` and become `<family>:primary` windows.
 */
function applyCodexHeaders(state: ProviderState, headers: Record<string, string>, now: number): void {
	let touched = false;
	for (const [rawName, rawValue] of Object.entries(headers)) {
		const name = rawName.toLowerCase();
		const m = CODEX_FIELD.exec(name);
		if (!m) continue;
		const [, family, role, field] = m as unknown as [string, string | undefined, string, string];
		const id = family ? `${family}:${role}` : role;
		const w = (state.windows[id] ??= { source: "header", lastSeen: now });
		w.source = "header";
		w.lastSeen = now;
		if (field === "used-percent") w.utilization = clamp01(divide100(num(rawValue)));
		else if (field === "reset-after-seconds") {
			const secs = num(rawValue);
			if (secs !== undefined) w.resetAt = now + secs * 1000;
		} else if (field === "reset-at") w.resetAt = epochMs(rawValue);
		touched = true;
	}
	const plan = headers["x-codex-plan-type"];
	if (plan) {
		state.plan = plan;
		touched = true;
	}
	const hasCredits = headers["x-codex-credits-has-credits"];
	const unlimited = headers["x-codex-credits-unlimited"];
	const balance = headers["x-codex-credits-balance"];
	if (hasCredits !== undefined || unlimited !== undefined || balance !== undefined) {
		state.credits = {
			...(state.credits ?? {}),
			hasCredits: hasCredits !== undefined ? truthy(hasCredits) : state.credits?.hasCredits,
			unlimited: unlimited !== undefined ? truthy(unlimited) : state.credits?.unlimited,
			balance: balance ?? state.credits?.balance,
			source: "header",
			lastSeen: now,
		};
		touched = true;
	}
	if (touched) state.lastSeen = now;
}

// ---- persistence -----------------------------------------------------------

function readLedgerFile(file: string): LedgerFile | undefined {
	if (!existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LedgerFile> & { version?: number; plans?: Record<string, unknown> };
		if (parsed?.version === 2) return { version: 2, totals: parsed.totals ?? {}, providers: parsed.providers ?? {} };
		if (parsed?.version === 1) return { version: 2, totals: (parsed.totals as Record<string, ModelTotals>) ?? {}, providers: {} };
	} catch {
		// corrupt ledger: start fresh, keep the old file until the next save replaces it
	}
	return undefined;
}

/**
 * `disk` is authoritative for whatever other sessions wrote; `mine` contributes the token/cost
 * delta it accumulated since `baseline` plus any quota fact that is newer than the disk copy.
 */
export function mergeLedgers(disk: LedgerFile, mine: LedgerFile, baseline: Record<string, ModelTotals>): LedgerFile {
	const totals: Record<string, ModelTotals> = structuredClone(disk.totals);
	for (const [key, mineTotals] of Object.entries(mine.totals)) {
		const base = baseline[key] ?? emptyTotals();
		const target = (totals[key] ??= emptyTotals());
		target.calls += mineTotals.calls - base.calls;
		target.input += mineTotals.input - base.input;
		target.output += mineTotals.output - base.output;
		target.cacheRead += mineTotals.cacheRead - base.cacheRead;
		target.cacheWrite += mineTotals.cacheWrite - base.cacheWrite;
		target.costUsd += mineTotals.costUsd - base.costUsd;
	}

	const providers: Record<string, ProviderState> = structuredClone(disk.providers);
	for (const [name, mineState] of Object.entries(mine.providers)) {
		const theirs = providers[name];
		if (!theirs) {
			providers[name] = structuredClone(mineState);
			continue;
		}
		// Strictly newer wins, so replaying an observation another session already superseded
		// cannot roll it back.
		const newer = mineState.lastSeen > theirs.lastSeen ? mineState : theirs;
		const merged: ProviderState = { ...theirs, ...newer, windows: { ...theirs.windows } };
		for (const [id, w] of Object.entries(mineState.windows)) {
			const existing = merged.windows[id];
			if (!existing || w.lastSeen > existing.lastSeen) merged.windows[id] = w;
		}
		if (mineState.credits && (!theirs.credits || mineState.credits.lastSeen > theirs.credits.lastSeen)) merged.credits = mineState.credits;
		else if (theirs.credits) merged.credits = theirs.credits;
		merged.lastSeen = Math.max(mineState.lastSeen, theirs.lastSeen);
		providers[name] = merged;
	}
	return { version: 2, totals, providers };
}

const LOCK_STALE_MS = 10_000;
const LOCK_ATTEMPTS = 50;
const LOCK_WAIT_MS = 20;

/** Directory-based mutex: mkdir is atomic on every platform pi runs on. */
function acquireLock(lock: string): boolean {
	for (let i = 0; i < LOCK_ATTEMPTS; i++) {
		try {
			mkdirSync(lock);
			return true;
		} catch {
			try {
				if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
					rmdirSync(lock);
					continue;
				}
			} catch {
				continue;
			}
			sleepSync(LOCK_WAIT_MS);
		}
	}
	// Writing without the lock is still better than dropping the session's usage entirely.
	return false;
}

function releaseLock(lock: string): void {
	try {
		rmdirSync(lock);
	} catch {
		// already gone
	}
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The shared usage file inside a ledger directory. */
export function ledgerPath(dir: string): string {
	return join(dir, "usage.json");
}

/** Remove a ledger's lock directory; used when a test or tool aborts mid-save. */
export function clearLedgerLock(file: string): void {
	try {
		rmdirSync(`${file}.lock`);
	} catch {
		// nothing to clear
	}
	try {
		unlinkSync(`${file}.${process.pid}.tmp`);
	} catch {
		// nothing to clear
	}
}

// ---- small helpers ---------------------------------------------------------

function emptyTotals(): ModelTotals {
	return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
}

function num(v: string | undefined): number | undefined {
	if (v === undefined || v === "") return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

function divide100(n: number | undefined): number | undefined {
	return n === undefined ? undefined : n / 100;
}

function clamp01(n: number | undefined): number | undefined {
	return n === undefined ? undefined : Math.min(1, Math.max(0, n));
}

/** Epoch seconds, or an RFC 3339 / HTTP date. Providers have shipped all three. */
function epochMs(v: string | undefined): number | undefined {
	const n = num(v);
	if (n !== undefined) return n * 1000;
	if (!v) return undefined;
	const parsed = Date.parse(v);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function truthy(v: string): boolean {
	return /^(true|1|yes)$/i.test(v.trim());
}

function fmt(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}
