/**
 * Spent limits exclude only the models the window governs, for every provider the router meters.
 * Fixtures are the documented payloads: Claude bridge rejections carry rateLimitType and resetsAt
 * and no rate-limit headers; xAI names a model in the exhaustion body; Codex, OpenRouter, and
 * Vercel keep the poll and header signals they already document.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { assessBilling } from "../src/billing.ts";
import { DEFAULT_CONFIG, mergeConfig, type RouterConfig } from "../src/config.ts";
import { parseEntitlement } from "../src/entitlement.ts";
import { Ledger, ledgerPath } from "../src/ledger.ts";
import { chooseModel } from "../src/router.ts";

function model(provider: string, id: string, cost: Partial<Model<Api>["cost"]> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://x",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...cost },
		contextWindow: 128000,
		maxTokens: 8192,
	} as Model<Api>;
}

function fakeRegistry(models: Model<Api>[], oauth: string[]): ModelRegistry {
	return {
		find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
		hasConfiguredAuth: () => true,
		isUsingOAuth: (m: Model<Api>) => oauth.includes(m.provider),
	} as unknown as ModelRegistry;
}

function ledger(): Ledger {
	return new Ledger(ledgerPath(mkdtempSync(join(tmpdir(), "mr-limits-"))));
}

const opus = model("claude-bridge", "claude-opus-5", { input: 15, output: 75 });
const sonnet = model("claude-bridge", "claude-sonnet-5", { input: 3, output: 15 });
const fable = model("claude-bridge", "claude-fable-5-1", { input: 15, output: 75 });
const codex = model("openai-codex", "gpt-6-astra", { input: 1.25, output: 10 });
const codexMini = model("openai-codex", "gpt-6-mini", { input: 0.5, output: 2 });
const grokFree = model("xai", "grok-4.5-build-free", { input: 0, output: 0 });
const grok = model("xai", "grok-4.7", { input: 3, output: 15 });
const router = model("openrouter", "z-ai/glm-5.3", { input: 0.5, output: 2 });
const gateway = model("vercel-ai-gateway", "deepseek/deepseek-v4.1-flash", { input: 0.3, output: 1 });
const ALL = [opus, sonnet, fable, codex, codexMini, grokFree, grok, router, gateway];

const cfg: RouterConfig = mergeConfig(DEFAULT_CONFIG, {
	tiers: {
		light: ["claude-bridge/claude-opus-5"],
		standard: ["claude-bridge/claude-opus-5", "claude-bridge/claude-sonnet-5", "xai/grok-4.5-build-free", "xai/grok-4.7"],
		heavy: ["claude-bridge/claude-fable-5-1", "openai-codex/gpt-6-astra"],
	},
	billing: { ...DEFAULT_CONFIG.billing, probe: { ...DEFAULT_CONFIG.billing.probe, enabled: false } },
});

const registry = fakeRegistry(ALL, ["claude-bridge", "openai-codex", "xai"]);

function assess(m: Model<Api>, l: Ledger, now?: number) {
	return assessBilling({ model: m, cfg, registry, ledger: l, now });
}

const NO_HEADERS: Record<string, string> = {};

test("a Claude bridge Fable rejection with no headers excludes Fable and leaves Opus eligible", () => {
	const l = ledger();
	const now = Date.now();
	const resetsAt = Math.floor(now / 1000) + 3600;
	l.observeResponse("claude-bridge", 0, NO_HEADERS, cfg, now, {
		rateLimitType: "seven_day_overage_included",
		resetsAt,
	});

	assert.equal(l.peekProvider("claude-bridge")?.windows["7d_oi"]?.resetAt, resetsAt * 1000);
	assert.equal(assess(fable, l, now).eligibility, "excluded");
	assert.match(assess(fable, l, now).reason, /7d_oi rejected/);
	assert.notEqual(assess(opus, l, now).eligibility, "excluded");
	assert.notEqual(assess(sonnet, l, now).eligibility, "excluded");

	assert.notEqual(assess(fable, l, resetsAt * 1000 + 1).eligibility, "excluded", "eligible again after the named reset");
});

test("a spent Claude bridge window and a spent xAI window both lift once the clock passes the named reset", () => {
	const now = 1_790_214_000_000;
	const resetsAt = Math.floor(now / 1000) + 3600;

	const claude = ledger();
	claude.observeResponse("claude-bridge", 0, NO_HEADERS, cfg, now, {
		rateLimitType: "seven_day_overage_included",
		resetsAt,
	});
	const claudeReset = claude.peekProvider("claude-bridge")?.windows["7d_oi"]?.resetAt;
	assert.equal(claudeReset, resetsAt * 1000);
	assert.equal(assess(fable, claude, claudeReset! - 1).eligibility, "excluded");
	const claudeAfter = assess(fable, claude, claudeReset! + 1);
	assert.equal(claudeAfter.eligibility, "allowed");

	const xai = ledger();
	xai.observeResponse("xai", 0, NO_HEADERS, cfg, now, {
		code: "subscription:free-usage-exhausted",
		error:
			"You've used all the included free usage for model grok-4.5-build-free for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 1065387/1000000.",
		resetsAt,
	});
	const xaiReset = xai.peekProvider("xai")?.windows["grok-4.5-build-free:exhausted"]?.resetAt;
	assert.equal(xaiReset, resetsAt * 1000);
	assert.equal(assess(grokFree, xai, xaiReset! - 1).eligibility, "excluded");
	const xaiAfter = assess(grokFree, xai, xaiReset! + 1);
	assert.equal(xaiAfter.eligibility, "preferred");
});

test("the bridge error sentence for that same Fable rejection is enough evidence", () => {
	const l = ledger();
	const now = Date.now();
	l.observeResponse(
		"claude-bridge",
		0,
		NO_HEADERS,
		cfg,
		now,
		"Claude rate limit (seven_day_overage_included) — resets 13:00:00: You've reached your Fable limit.",
	);
	const resetAt = l.peekProvider("claude-bridge")?.windows["7d_oi"]?.resetAt;
	assert.equal(assess(fable, l, now).eligibility, "excluded");
	assert.notEqual(assess(opus, l, now).eligibility, "excluded");
	assert.ok(resetAt !== undefined && resetAt > now);
	assert.notEqual(assess(fable, l, resetAt! + 1).eligibility, "excluded");
});

test("an Opus-scoped bridge rejection leaves Fable eligible, and a Sonnet one leaves both", () => {
	const now = Date.now();
	const resetsAt = Math.floor(now / 1000) + 3600;

	const opusOnly = ledger();
	opusOnly.observeResponse("claude-bridge", 0, NO_HEADERS, cfg, now, { rateLimitType: "seven_day_opus", resetsAt });
	assert.equal(assess(opus, opusOnly, now).eligibility, "excluded");
	assert.notEqual(assess(fable, opusOnly, now).eligibility, "excluded");
	assert.notEqual(assess(sonnet, opusOnly, now).eligibility, "excluded");

	const sonnetOnly = ledger();
	sonnetOnly.observeResponse("claude-bridge", 0, NO_HEADERS, cfg, now, { rateLimitType: "seven_day_sonnet", resetsAt });
	assert.equal(assess(sonnet, sonnetOnly, now).eligibility, "excluded");
	assert.notEqual(assess(opus, sonnetOnly, now).eligibility, "excluded");
	assert.notEqual(assess(fable, sonnetOnly, now).eligibility, "excluded");
});

test("an account-wide bridge rejection excludes every model on the credential until reset", () => {
	const now = Date.now();
	const resetsAt = Math.floor(now / 1000) + 3600;
	for (const rateLimitType of ["five_hour", "seven_day"]) {
		const l = ledger();
		l.observeResponse("claude-bridge", 0, NO_HEADERS, cfg, now, { rateLimitType, resetsAt });
		for (const m of [opus, fable, sonnet]) {
			assert.equal(assess(m, l, now).eligibility, "excluded", `${rateLimitType} ${m.id}`);
		}
		assert.notEqual(assess(fable, l, resetsAt * 1000 + 1).eligibility, "excluded", `${rateLimitType} lifts`);
		assert.notEqual(assess(opus, l, resetsAt * 1000 + 1).eligibility, "excluded", `${rateLimitType} lifts`);
	}
});

test("an xAI free-usage exhaustion names one model and leaves another xAI model eligible", () => {
	const l = ledger();
	const now = Date.now();
	const resetsAt = Math.floor(now / 1000) + 86_400;
	l.observeResponse("xai", 0, NO_HEADERS, cfg, now, {
		code: "subscription:free-usage-exhausted",
		error:
			"You've used all the included free usage for model grok-4.5-build-free for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 1065387/1000000.",
		resetsAt,
	});
	assert.equal(assess(grokFree, l, now).eligibility, "excluded");
	assert.notEqual(assess(grok, l, now).eligibility, "excluded");
	assert.notEqual(assess(grokFree, l, resetsAt * 1000 + 1).eligibility, "excluded");
});

test("Pi's xAI free-usage error string excludes that model until the 24-hour reset", () => {
	// generate() keeps the error string, so the live message is the OpenAI SDK form of the
	// documented sentence and does not carry subscription:free-usage-exhausted or resetsAt.
	const l = ledger();
	const now = 1_790_214_000_000;
	const piMessage =
		'429 "You\'ve used all the included free usage for model grok-4.5-build-free for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 1065387/1000000."';
	l.observeResponse("xai", 0, NO_HEADERS, cfg, now, piMessage);

	const resetAt = l.peekProvider("xai")?.windows["grok-4.5-build-free:exhausted"]?.resetAt;
	assert.equal(resetAt, now + 24 * 60 * 60 * 1000);
	assert.equal(assess(grokFree, l, now).eligibility, "excluded");
	assert.notEqual(assess(grok, l, now).eligibility, "excluded");
	assert.equal(assess(grokFree, l, resetAt! - 1).eligibility, "excluded");
	assert.equal(assess(grokFree, l, resetAt!).eligibility, "preferred");
});

test("an xAI weekly-pool refusal that names a model does not exclude the other xAI model", () => {
	const l = ledger();
	const now = Date.now();
	const resetsAt = Math.floor(now / 1000) + 7 * 86_400;
	l.observeResponse("xai", 0, NO_HEADERS, cfg, now, {
		code: "subscription:weekly-pool-exhausted",
		error: "You've used your weekly usage pool for model grok-4.7.",
		resetsAt,
	});
	assert.equal(assess(grok, l, now).eligibility, "excluded");
	assert.notEqual(assess(grokFree, l, now).eligibility, "excluded");
	assert.notEqual(assess(grok, l, resetsAt * 1000 + 1).eligibility, "excluded");
});

test("a Codex family window excludes only that model", () => {
	const l = ledger();
	const now = Date.now();
	l.observeResponse(
		"openai-codex",
		200,
		{
			"x-codex-primary-used-percent": "16",
			"x-codex-bengalfox-primary-used-percent": "100",
			"x-codex-bengalfox-limit-name": "gpt-6-astra",
		},
		cfg,
		now,
	);
	assert.equal(assess(codex, l, now).eligibility, "excluded");
	assert.notEqual(assess(codexMini, l, now).eligibility, "excluded");
});

test("an OpenRouter key with no remaining limit excludes that route", () => {
	const l = ledger();
	const now = Date.now();
	l.applyEntitlement("openrouter", parseEntitlement("openrouter-key", { data: { limit: 10, limit_remaining: 0 } }), now);
	assert.equal(assess(router, l, now).eligibility, "excluded");
	assert.notEqual(assess(gateway, l, now).eligibility, "excluded");
});

test("a Vercel budget exhaustion excludes that route; a gateway error sentence is not a spent window", () => {
	const now = Date.now();
	const budget = ledger();
	budget.applyEntitlement("vercel-ai-gateway", parseEntitlement("vercel-credits", { balance: 0 }), now);
	assert.equal(assess(gateway, budget, now).eligibility, "excluded");
	assert.notEqual(assess(router, budget, now).eligibility, "excluded");

	// The 429/402 header path records gateway refusals; the message text alone records nothing.
	const rate = ledger();
	rate.observeResponse("vercel-ai-gateway", 0, NO_HEADERS, cfg, now, {
		error: { message: "Rate limit exceeded", type: "rate_limit_exceeded" },
		resetsAt: Math.floor(now / 1000) + 60,
	});
	rate.observeResponse("openrouter", 0, NO_HEADERS, cfg, now, {
		error: { message: "Key limit exceeded", type: "quota_for_entity_exceeded", metadata: { limit_source: "openrouter_key_limit" } },
	});
	assert.deepEqual(rate.peekProvider("vercel-ai-gateway")?.windows ?? {}, {});
	assert.deepEqual(rate.peekProvider("openrouter")?.windows ?? {}, {});
	assert.notEqual(assess(gateway, rate, now).eligibility, "excluded");
	assert.notEqual(assess(router, rate, now).eligibility, "excluded");
});

test("a spent window whose refusal names no reset lifts after the 429 cooldown instead of never", () => {
	const l = ledger();
	const now = Date.now();
	l.observeResponse("claude-bridge", 0, NO_HEADERS, cfg, now, "Claude rate limit (five_hour) — resets 3pm");
	l.observeResponse("xai", 0, NO_HEADERS, cfg, now, "You've used your weekly usage pool for model grok-4.7.");
	const lifts = now + cfg.plan.cooldownMinutesOn429 * 60_000;
	assert.equal(l.peekProvider("claude-bridge")?.windows["5h"]?.resetAt, lifts);
	assert.equal(l.peekProvider("xai")?.windows["grok-4.7:exhausted"]?.resetAt, lifts);
	assert.equal(assess(opus, l, now).eligibility, "excluded");
	assert.equal(assess(grok, l, now).eligibility, "excluded");
	assert.notEqual(assess(opus, l, lifts).eligibility, "excluded");
	assert.notEqual(assess(grok, l, lifts).eligibility, "excluded");
});

test("a usage poll HTTP 401 writes no window and leaves the limit unverified", () => {
	const now = Date.now();
	const bare = ledger();
	const rejected = ledger();
	rejected.recordProbeError("claude-bridge", "entitlement query returned HTTP 401", now);

	assert.deepEqual(rejected.peekProvider("claude-bridge")?.windows, {});
	const without = assess(opus, bare, now);
	const withProbe = assess(opus, rejected, now);
	assert.equal(withProbe.eligibility, without.eligibility);
	assert.equal(withProbe.eligibility, "allowed");
	assert.match(withProbe.reason, /limit is unverified/);
	assert.doesNotMatch(withProbe.reason, /exhausted|rejected|refusing/);
});

test("with Fable spent and Codex under its windows the heavy tier selects Codex and cites the Fable limit", () => {
	const l = ledger();
	const now = Date.now();
	const resetsAt = Math.floor(now / 1000) + 7200;
	l.observeResponse("claude-bridge", 0, NO_HEADERS, cfg, now, {
		rateLimitType: "seven_day_overage_included",
		resetsAt,
	});
	l.observeResponse(
		"openai-codex",
		200,
		{
			"x-codex-primary-used-percent": "16",
			"x-codex-secondary-used-percent": "48",
			"x-codex-plan-type": "plus",
		},
		cfg,
		now,
	);
	const d = chooseModel({
		tier: "heavy",
		confidence: 0.9,
		current: fable,
		registry,
		cfg,
		ledger: l,
		contextTokens: 1000,
		now,
	});
	assert.equal(d.model?.provider, "openai-codex");
	assert.equal(d.model?.id, "gpt-6-astra");
	assert.match(d.reason, /claude-fable/);
	assert.match(d.reason, /7d_oi/);
});
