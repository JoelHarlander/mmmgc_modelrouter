/**
 * Usage ledger + plan-quota state.
 *
 * - Records tokens/cost per provider/model from assistant messages (session + persisted totals).
 * - Harvests plan utilization from response headers (Anthropic unified, Codex) and
 *   429/402 responses, so the router can steer away from exhausted subscriptions.
 *
 * Header names per docs/research/plan-quotas.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { RouterConfig } from "./config.ts";

export interface ModelTotals {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}

export interface PlanState {
	/** 0..1, max over the provider's windows. */
	utilization?: number;
	status?: string;
	/** Epoch ms when the binding window resets. */
	resetAt?: number;
	/** Epoch ms until which the provider is considered unusable (429/402). */
	cooldownUntil?: number;
	cooldownReason?: string;
	lastSeen: number;
}

interface LedgerFile {
	version: 1;
	totals: Record<string, ModelTotals>;
	plans: Record<string, PlanState>;
}

export class Ledger {
	readonly session: Record<string, ModelTotals> = {};
	private data: LedgerFile = { version: 1, totals: {}, plans: {} };
	private saveTimer: NodeJS.Timeout | undefined;

	constructor(private readonly file: string) {
		if (existsSync(file)) {
			try {
				const parsed = JSON.parse(readFileSync(file, "utf8")) as LedgerFile;
				if (parsed && parsed.version === 1) this.data = parsed;
			} catch {
				// corrupt ledger: start fresh, keep the old file until next save overwrites it
			}
		}
	}

	record(provider: string, modelId: string, usage: Usage | undefined): void {
		if (!usage) return;
		const key = `${provider}/${modelId}`;
		for (const bucket of [this.session, this.data.totals]) {
			const t = (bucket[key] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
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
	observeResponse(provider: string, status: number, headers: Record<string, string>, cfg: RouterConfig): void {
		const now = Date.now();
		const plan = (this.data.plans[provider] ??= { lastSeen: now });
		plan.lastSeen = now;
		const h = (name: string) => headers[name] ?? headers[name.toLowerCase()];

		// Anthropic OAuth (Claude Pro/Max): unified windows, utilization is 0..1
		const anth5h = num(h("anthropic-ratelimit-unified-5h-utilization"));
		const anth7d = num(h("anthropic-ratelimit-unified-7d-utilization"));
		if (anth5h !== undefined || anth7d !== undefined) {
			plan.utilization = Math.max(anth5h ?? 0, anth7d ?? 0);
			plan.status = h("anthropic-ratelimit-unified-status") ?? plan.status;
			const reset = num(h("anthropic-ratelimit-unified-reset"));
			if (reset !== undefined) plan.resetAt = reset * 1000;
		}

		// OpenAI Codex (ChatGPT plan): used-percent is 0..100
		const codexPrimary = num(h("x-codex-primary-used-percent"));
		const codexSecondary = num(h("x-codex-secondary-used-percent"));
		if (codexPrimary !== undefined || codexSecondary !== undefined) {
			plan.utilization = Math.max(codexPrimary ?? 0, codexSecondary ?? 0) / 100;
			const resetAfter = num(h("x-codex-primary-reset-after-seconds"));
			const resetAt = num(h("x-codex-primary-reset-at"));
			if (resetAfter !== undefined) plan.resetAt = now + resetAfter * 1000;
			else if (resetAt !== undefined) plan.resetAt = resetAt * 1000;
		}

		if (status === 429 || status === 402) {
			const retryAfter = num(h("retry-after"));
			const fallbackMs = cfg.plan.cooldownMinutesOn429 * 60_000;
			const until = retryAfter !== undefined ? now + retryAfter * 1000 : (plan.resetAt && plan.resetAt > now ? plan.resetAt : now + fallbackMs);
			plan.cooldownUntil = until;
			plan.cooldownReason = status === 402 ? "budget exhausted (402)" : "rate limited (429)";
		} else if (status >= 200 && status < 300 && plan.cooldownUntil && plan.status !== "rejected") {
			// A successful call clears a stale cooldown.
			plan.cooldownUntil = undefined;
			plan.cooldownReason = undefined;
		}
		this.scheduleSave();
	}

	isBlocked(provider: string, cfg: RouterConfig, now = Date.now()): { blocked: boolean; reason?: string } {
		const plan = this.data.plans[provider];
		if (!plan) return { blocked: false };
		if (plan.cooldownUntil && plan.cooldownUntil > now) {
			return { blocked: true, reason: `${plan.cooldownReason ?? "cooldown"} until ${new Date(plan.cooldownUntil).toLocaleTimeString()}` };
		}
		if (plan.status === "rejected" && (!plan.resetAt || plan.resetAt > now)) {
			return { blocked: true, reason: "plan window rejected" };
		}
		if (plan.utilization !== undefined && plan.utilization >= cfg.plan.utilizationCeiling && (!plan.resetAt || plan.resetAt > now)) {
			return { blocked: true, reason: `plan ${Math.round(plan.utilization * 100)}% used` };
		}
		return { blocked: false };
	}

	planState(provider: string): PlanState | undefined {
		return this.data.plans[provider];
	}

	summaryLines(): string[] {
		const lines: string[] = [];
		const entries = Object.entries(this.session);
		if (entries.length === 0) lines.push("session: no model calls yet");
		for (const [key, t] of entries) {
			lines.push(`session ${key}: ${t.calls} calls, in ${fmt(t.input)} (cache ${fmt(t.cacheRead)}), out ${fmt(t.output)}, $${t.costUsd.toFixed(4)}`);
		}
		for (const [provider, p] of Object.entries(this.data.plans)) {
			const parts: string[] = [];
			if (p.utilization !== undefined) parts.push(`${Math.round(p.utilization * 100)}% used`);
			if (p.status) parts.push(p.status);
			if (p.resetAt) parts.push(`resets ${new Date(p.resetAt).toLocaleTimeString()}`);
			if (p.cooldownUntil && p.cooldownUntil > Date.now()) parts.push(`COOLDOWN ${p.cooldownReason}`);
			if (parts.length) lines.push(`plan ${provider}: ${parts.join(", ")}`);
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

	save(): void {
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			writeFileSync(this.file, JSON.stringify(this.data, null, 2));
		} catch {
			// best effort
		}
	}
}

function num(v: string | undefined): number | undefined {
	if (v === undefined || v === "") return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

function fmt(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}
