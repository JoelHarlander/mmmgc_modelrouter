/**
 * Billing eligibility as a routing input: basis, verification, and what the configuration
 * permits. Fixtures use the header names and value scales recorded in
 * docs/research/plan-quotas.md, so the parsing under test matches the real wire format.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { assessBilling, describeBasis } from "../src/billing.ts";
import { DEFAULT_CONFIG, mergeConfig, modelKey, type RouterConfig } from "../src/config.ts";
import { parseEntitlement } from "../src/entitlement.ts";
import { Ledger } from "../src/ledger.ts";
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

function fakeRegistry(models: Model<Api>[], oauth: string[] = [], unauthed: string[] = []): ModelRegistry {
	return {
		find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
		hasConfiguredAuth: (m: Model<Api>) => !unauthed.includes(m.provider),
		isUsingOAuth: (m: Model<Api>) => oauth.includes(m.provider),
	} as unknown as ModelRegistry;
}

function ledger(): Ledger {
	return new Ledger(join(mkdtempSync(join(tmpdir(), "mr-billing-")), "usage.json"));
}

const opus = model("claude-bridge", "claude-opus-5", { input: 15, output: 75 });
const fable = model("claude-bridge", "claude-fable-5-1", { input: 15, output: 75 });
const codex = model("openai-codex", "gpt-6-astra", { input: 1.25, output: 10 });
const grok = model("xai", "grok-4.7", { input: 3, output: 15 });
const claudeApi = model("anthropic", "claude-opus-5", { input: 15, output: 75 });
const router = model("openrouter", "z-ai/glm-5.3", { input: 0.5, output: 2 });
const routerFree = model("openrouter", "z-ai/glm-5.3:free");
const gateway = model("vercel-ai-gateway", "deepseek/deepseek-v4.1-flash", { input: 0.3, output: 1 });
const ALL = [opus, fable, codex, grok, claudeApi, router, routerFree, gateway];

/** Tiers pointing at the real provider ids, so the shipped default policy is what is exercised. */
const cfg: RouterConfig = mergeConfig(DEFAULT_CONFIG, {
	tiers: {
		light: ["openrouter/z-ai/glm-5.3"],
		standard: ["claude-bridge/claude-opus-5", "openrouter/z-ai/glm-5.3"],
		heavy: ["claude-bridge/claude-fable-5-1", "claude-bridge/claude-opus-5"],
	},
	billing: { ...DEFAULT_CONFIG.billing, probe: { ...DEFAULT_CONFIG.billing.probe, enabled: false } },
});

/** The unified headers a healthy Claude subscription returns (0..1 scale). */
const HEALTHY_ANTHROPIC = {
	"anthropic-ratelimit-unified-5h-utilization": "0.12",
	"anthropic-ratelimit-unified-5h-status": "allowed",
	"anthropic-ratelimit-unified-7d-utilization": "0.51",
	"anthropic-ratelimit-unified-7d-status": "allowed",
};

function assess(m: Model<Api>, l: Ledger, c: RouterConfig = cfg, now?: number) {
	return assessBilling({ model: m, cfg: c, registry: fakeRegistry(ALL, ["claude-bridge", "openai-codex", "xai"]), ledger: l, now });
}

// ---- basis and verification ------------------------------------------------

test("a plan label with no live evidence is allowed but only as an assumption", () => {
	const a = assess(opus, ledger());
	assert.equal(a.basis, "subscription");
	assert.equal(a.verification, "unverified");
	assert.equal(a.eligibility, "allowed");
	assert.ok(a.uncertainty.some((u) => /comes from configuration/.test(u)), a.uncertainty.join(" | "));
	assert.match(describeBasis(a), /subscription \(unverified\)/);
});

test("live subscription windows verify the basis and make the route preferred", () => {
	const l = ledger();
	l.observeResponse("claude-bridge", 200, HEALTHY_ANTHROPIC, cfg);
	const a = assess(opus, l);
	assert.equal(a.basis, "subscription");
	assert.equal(a.verification, "verified");
	assert.equal(a.eligibility, "preferred");
	assert.deepEqual(a.uncertainty, []);
	assert.ok(a.evidence.some((e) => /subscription 51% used/.test(e)), a.evidence.join(" | "));
});

test("evidence older than billing.evidenceMaxAgeMinutes degrades to stale, not verified", () => {
	const l = ledger();
	l.observeResponse("claude-bridge", 200, HEALTHY_ANTHROPIC, cfg);
	const later = Date.now() + 31 * 60_000;
	const a = assess(opus, l, cfg, later);
	assert.equal(a.verification, "stale");
	assert.equal(a.eligibility, "allowed");
	assert.ok(a.uncertainty.some((u) => /older than 30m/.test(u)), a.uncertainty.join(" | "));
});

test("allowUnverifiedSubscription false excludes a plan route until it is verified", () => {
	const strict = mergeConfig(cfg, { billing: { ...cfg.billing, allowUnverifiedSubscription: false } });
	const a = assess(opus, ledger(), strict);
	assert.equal(a.eligibility, "excluded");
	assert.match(a.reason, /not verified/);
});

test("a zero-cost model is free, verified from the catalog price, and preferred", () => {
	const local = model("ds4", "deepseek-v4-flash");
	const a = assessBilling({ model: local, cfg, registry: fakeRegistry([local]), ledger: ledger() });
	assert.equal(a.basis, "free");
	assert.equal(a.eligibility, "preferred");
});

// ---- subscription vs extra billed usage ------------------------------------

/** A real ChatGPT Plus exhaustion: plan spent, credits on the account (pi#4172 shape). */
const CODEX_EXHAUSTED_WITH_CREDITS = {
	"x-codex-plan-type": "plus",
	"x-codex-primary-used-percent": "100",
	"x-codex-secondary-used-percent": "30",
	"x-codex-primary-reset-after-seconds": "13873",
	"x-codex-credits-has-credits": "True",
	"x-codex-credits-unlimited": "False",
	"x-codex-credits-balance": "12",
};

test("exhausted subscription with credits is extra-credits, not subscription, and says so", () => {
	const l = ledger();
	l.observeResponse("openai-codex", 200, CODEX_EXHAUSTED_WITH_CREDITS, cfg);
	const a = assess(codex, l);
	assert.equal(a.basis, "extra-credits");
	assert.equal(a.eligibility, "allowed");
	assert.notEqual(a.eligibility, "preferred");
	assert.ok(a.uncertainty.some((u) => /bills extra usage on top of the subscription/.test(u)), a.uncertainty.join(" | "));
	assert.ok(a.evidence.some((e) => /credits available \(12\)/.test(e)), a.evidence.join(" | "));
});

test("extra billed usage is refused without live credit evidence", () => {
	const l = ledger();
	l.observeResponse("openai-codex", 200, { "x-codex-primary-used-percent": "100", "x-codex-plan-type": "plus" }, cfg);
	const a = assess(codex, l);
	assert.equal(a.eligibility, "excluded");
	assert.match(a.reason, /needs verified credits/);
});

test("extra billed usage is refused for providers outside billing.allowExtraBilled", () => {
	const l = ledger();
	l.observeResponse(
		"claude-bridge",
		200,
		{ "anthropic-ratelimit-unified-7d-utilization": "1", "anthropic-ratelimit-unified-7d-status": "rejected" },
		cfg,
	);
	const a = assess(opus, l);
	assert.equal(a.eligibility, "excluded");
	assert.match(a.reason, /not in billing\.allowExtraBilled/);
});

test("an account with extra usage switched off is excluded once its subscription is spent", () => {
	const allowAnthropicCredits = mergeConfig(cfg, { billing: { ...cfg.billing, allowExtraBilled: ["claude-bridge/*"] } });
	const l = ledger();
	l.observeResponse(
		"claude-bridge",
		200,
		{
			"anthropic-ratelimit-unified-7d-utilization": "1",
			"anthropic-ratelimit-unified-7d-status": "rejected",
			"anthropic-ratelimit-unified-overage-disabled-reason": "disabled_by_user",
		},
		allowAnthropicCredits,
	);
	const a = assess(opus, l, allowAnthropicCredits);
	assert.equal(a.eligibility, "excluded");
	assert.match(a.reason, /extra usage is off on the account/);
});

test("an overage pool the provider states nothing about is not evidence of credits", () => {
	const allowAnthropicCredits = mergeConfig(cfg, { billing: { ...cfg.billing, allowExtraBilled: ["claude-bridge/*"] } });
	const l = ledger();
	l.applyEntitlement(
		"claude-bridge",
		parseEntitlement("anthropic-oauth-usage", { rate_limits: { seven_day: { utilization: 100, status: "rejected" }, overage: { utilization: 12 } } }),
	);
	const a = assess(opus, l, allowAnthropicCredits);
	assert.equal(a.basis, "extra-credits");
	assert.equal(a.eligibility, "excluded");
	assert.match(a.reason, /needs verified credits/);
});

test("an extra-usage window that is itself spent excludes extra billed usage", () => {
	const allowAnthropicCredits = mergeConfig(cfg, { billing: { ...cfg.billing, allowExtraBilled: ["claude-bridge/*"] } });
	const l = ledger();
	l.applyEntitlement(
		"claude-bridge",
		parseEntitlement("anthropic-oauth-usage", {
			rate_limits: { seven_day: { utilization: 100, status: "rejected" }, overage: { utilization: 100, status: "allowed" } },
		}),
	);
	const a = assess(opus, l, allowAnthropicCredits);
	assert.equal(a.eligibility, "excluded");
	assert.match(a.reason, /extra-usage window is 100% used/);
});

// ---- deny paid fallback ----------------------------------------------------

test("the paid Anthropic API is reachable, priced and ranked last rather than refused", () => {
	// Nothing labels `anthropic/*`: pi's auth says API key, so the basis is per-token billing.
	const a = assess(claudeApi, ledger());
	assert.equal(a.basis, "pay-per-token");
	assert.equal(a.eligibility, "allowed");
	assert.ok(a.uncertainty.some((u) => /list-price estimate/.test(u)), a.uncertainty.join(" | "));
	assert.ok(a.rank > assess(codex, ledger()).rank, "an included-usage route is preferred over it");
});

test("an xAI route pi holds OAuth for is an assumed subscription, allowed but never preferred", () => {
	const a = assess(grok, ledger());
	assert.equal(a.basis, "subscription");
	assert.equal(a.verification, "unverified");
	assert.equal(a.eligibility, "allowed");
	assert.ok(a.uncertainty.some((u) => /entitlement check|does not prove/.test(u)), a.uncertainty.join(" | "));
});

test("a pay-per-token route nobody named is excluded rather than silently billed", () => {
	// The shipped allowPayPerToken names the gateways the default tiers use. A ChatGPT credential
	// relabelled `on-demand` is not one of them, so it cannot be reached without saying so.
	const relabelled = mergeConfig(cfg, { models: { ...cfg.models, "openai-codex/*": { billing: "on-demand" } } });
	const a = assess(codex, ledger(), relabelled);
	assert.equal(a.eligibility, "excluded");
	assert.match(a.reason, /not in billing\.allowPayPerToken/);

	const named = mergeConfig(relabelled, { billing: { ...relabelled.billing, allowPayPerToken: ["openai-codex/*"] } });
	assert.equal(assess(codex, ledger(), named).eligibility, "allowed");
});

// ---- model-scoped limits ---------------------------------------------------

test("an exhausted model-scoped window excludes that model and leaves the provider usable", () => {
	const l = ledger();
	l.observeResponse(
		"claude-bridge",
		200,
		{
			...HEALTHY_ANTHROPIC,
			"anthropic-ratelimit-unified-7d_oi-utilization": "1",
			"anthropic-ratelimit-unified-7d_oi-status": "rejected",
		},
		cfg,
	);
	const fableVerdict = assess(fable, l);
	assert.equal(fableVerdict.eligibility, "excluded");
	assert.match(fableVerdict.reason, /model-scoped quota exhausted/);
	assert.match(fableVerdict.reason, /claude-bridge stays usable for other models/);

	const opusVerdict = assess(opus, l);
	assert.equal(opusVerdict.eligibility, "preferred");
	assert.equal(opusVerdict.basis, "subscription");
});

test("a Codex per-model family limit is model-scoped too", () => {
	const scoped = mergeConfig(cfg, { scopes: { ...cfg.scopes, "openai-codex:bengalfox:primary": ["openai-codex/gpt-6-astra"] } });
	const l = ledger();
	l.observeResponse(
		"openai-codex",
		200,
		{ "x-codex-primary-used-percent": "10", "x-codex-bengalfox-primary-used-percent": "100", "x-codex-plan-type": "plus" },
		scoped,
	);
	assert.deepEqual(l.assess("openai-codex", undefined, scoped).exhaustedAccount, [], "the account limit still has room");
	const a = assess(codex, l, scoped);
	assert.equal(a.eligibility, "excluded");
	assert.match(a.reason, /model-scoped quota exhausted \(bengalfox:primary/);
});

// ---- account-wide exhaustion off the subscription path ---------------------

test("a spent prepaid key is excluded rather than reported eligible", () => {
	const l = ledger();
	l.applyEntitlement("openrouter", parseEntitlement("openrouter-key", { data: { limit: 10, limit_remaining: 0 } }));
	const a = assess(router, l);
	assert.equal(a.basis, "pay-per-token");
	assert.equal(a.eligibility, "excluded");
	assert.match(a.reason, /cannot pay for this route \(no credits\)/);
});

test("a prepaid balance is spendable to its last cent, not to the plan utilization ceiling", () => {
	const l = ledger();
	l.applyEntitlement("openrouter", parseEntitlement("openrouter-key", { data: { limit: 10, limit_remaining: 1.4 } }));
	const a = assess(router, l);
	assert.equal(a.basis, "pay-per-token");
	assert.equal(a.eligibility, "allowed");
});

test("a spent prepaid balance excludes every route the config labels billed", () => {
	const l = ledger();
	l.applyEntitlement(
		"openrouter",
		parseEntitlement("openrouter-key", { data: { limit: 10, limit_remaining: 0, free_model_daily_requests: { used: 5, limit: 50 } } }),
	);
	for (const m of [router, routerFree]) {
		const a = assess(m, l);
		assert.equal(a.eligibility, "excluded", modelKey(m));
		assert.match(a.reason, /cannot pay for this route \(no credits\)/);
	}
});

test("a gateway with nothing left to spend is excluded on its credit evidence", () => {
	const l = ledger();
	l.applyEntitlement("vercel-ai-gateway", parseEntitlement("vercel-credits", { balance: 0 }));
	const a = assess(gateway, l);
	assert.equal(a.eligibility, "excluded");
	assert.match(a.reason, /cannot pay for this route \(no credits\)/);
});

test("an exhausted account window excludes a zero-cost route too", () => {
	const local = model("ds4", "deepseek-v4-flash");
	const l = ledger();
	l.applyEntitlement("ds4", { windows: { daily: { status: "rejected" } } });
	const a = assessBilling({ model: local, cfg, registry: fakeRegistry([local]), ledger: l });
	assert.equal(a.basis, "free");
	assert.equal(a.eligibility, "excluded");
	assert.match(a.reason, /account quota exhausted \(daily rejected\)/);
});

test("OpenRouter's free-model allowance governs its free variants, not the paid routes", () => {
	const l = ledger();
	l.applyEntitlement(
		"openrouter",
		parseEntitlement("openrouter-key", { data: { limit: null, free_model_daily_requests: { used: 50, limit: 50 } } }),
	);
	const paid = assess(router, l);
	assert.equal(paid.eligibility, "allowed");
	assert.equal(paid.basis, "pay-per-token");
	const free = assess(routerFree, l);
	assert.equal(free.eligibility, "excluded");
	assert.match(free.reason, /model-scoped quota exhausted \(free_daily/);
});

// ---- selection ordering ----------------------------------------------------

test("a verified subscription route wins over a cheaper billed route", () => {
	const l = ledger();
	l.observeResponse("claude-bridge", 200, HEALTHY_ANTHROPIC, cfg);
	const d = chooseModel({
		tier: "standard",
		confidence: 0.9,
		current: undefined,
		registry: fakeRegistry(ALL, ["claude-bridge"]),
		cfg,
		ledger: l,
		contextTokens: 50_000,
	});
	assert.equal(d.model?.id, "claude-opus-5");
	assert.equal(d.billing?.verification, "verified");
	assert.match(d.reason, /subscription \(verified\) preferred/);
	const alternative = d.candidates.find((c) => c.key === "openrouter/z-ai/glm-5.3")!;
	assert.ok(alternative.costUsd > 0, "the billed alternative really is cheaper in dollars");
	assert.equal(alternative.assessment?.basis, "pay-per-token");
});

test("an explanation keeps the routes ruled out in the tiers that were skipped over", () => {
	// Nothing in the light tier is reachable, so routing escalates past it.
	const denied = mergeConfig(cfg, { billing: { ...cfg.billing, allowPayPerToken: [] } });
	const d = chooseModel({
		tier: "light",
		confidence: 0.9,
		current: undefined,
		registry: fakeRegistry(ALL, ["claude-bridge"]),
		cfg: denied,
		ledger: ledger(),
		contextTokens: 0,
	});
	assert.equal(d.tier, "standard");
	const skipped = d.candidates.find((c) => c.key === "openrouter/z-ai/glm-5.3");
	assert.match(skipped?.skipped ?? "", /not in billing\.allowPayPerToken/, "the light-tier route that was ruled out is still explained");
	assert.ok(d.candidates.some((c) => c.key === "claude-bridge/claude-opus-5" && !c.skipped));
});

test("routing explanations carry the uncertainty when the subscription is unverified", () => {
	const d = chooseModel({
		tier: "standard",
		confidence: 0.9,
		current: undefined,
		registry: fakeRegistry(ALL, ["claude-bridge"]),
		cfg,
		ledger: ledger(),
		contextTokens: 10_000,
	});
	assert.equal(d.model?.id, "claude-opus-5");
	assert.equal(d.billing?.verification, "unverified");
	assert.match(d.reason, /subscription \(unverified\)/);
	assert.match(d.reason, /caveat: .*not from an entitlement check/);
	assert.ok((d.billing?.uncertainty.length ?? 0) > 0);
});

test("with every route billing-ineligible the decision names the current model as ineligible", () => {
	const noneAllowed = mergeConfig(cfg, {
		tiers: { light: ["anthropic/claude-opus-5"], standard: ["anthropic/claude-opus-5"], heavy: ["anthropic/claude-opus-5"] },
		billing: { ...cfg.billing, allowPayPerToken: [] },
	});
	const d = chooseModel({
		tier: "standard",
		confidence: 0.9,
		current: claudeApi,
		registry: fakeRegistry(ALL),
		cfg: noneAllowed,
		ledger: ledger(),
		contextTokens: 0,
	});
	assert.equal(d.switched, false);
	assert.match(d.reason, /no configured model is billing-eligible/);
	assert.match(d.ineligibleCurrent ?? "", /not in billing\.allowPayPerToken/);
});

test("a verified subscription outranks a cheaper billed route, with no way to switch that off", () => {
	const l = ledger();
	l.observeResponse("claude-bridge", 200, HEALTHY_ANTHROPIC, cfg);
	const both = mergeConfig(cfg, { tiers: { ...cfg.tiers, standard: ["openrouter/z-ai/glm-5.3", "claude-bridge/claude-opus-5"] } });
	const d = chooseModel({
		tier: "standard",
		confidence: 0.9,
		current: undefined,
		registry: fakeRegistry(ALL, ["claude-bridge"]),
		cfg: both,
		ledger: l,
		contextTokens: 10_000,
	});
	assert.equal(d.model?.provider, "claude-bridge");
	assert.equal(d.billing?.eligibility, "preferred");
	const billed = d.candidates.find((c) => c.key === "openrouter/z-ai/glm-5.3")!;
	assert.ok(billed.costUsd > 0, "the billed route really was the cheaper-looking one on price alone");
});

test("extra billed usage is priced as money, so a cheaper billed route can win on cost", () => {
	const l = ledger();
	l.observeResponse("openai-codex", 200, CODEX_EXHAUSTED_WITH_CREDITS, cfg);
	const costOnly = mergeConfig(cfg, { tiers: { ...cfg.tiers, standard: ["openai-codex/gpt-6-astra", "openrouter/z-ai/glm-5.3"] } });
	const d = chooseModel({
		tier: "standard",
		confidence: 0.9,
		current: undefined,
		registry: fakeRegistry(ALL, ["claude-bridge", "openai-codex", "xai"]),
		cfg: costOnly,
		ledger: l,
		contextTokens: 50_000,
	});
	const extra = d.candidates.find((c) => c.key === "openai-codex/gpt-6-astra")!;
	assert.equal(extra.assessment?.basis, "extra-credits");
	assert.ok(extra.costUsd > 0, "credit spend is estimated as real money");
	assert.ok(extra.switchPenaltyUsd > 0, "re-reading context on credits costs money too");
	assert.equal(d.model?.provider, "openai-codex", "once the plan is spent, its own credits are the preferred overflow");
	assert.match(d.reason, /extra-credits/, "and the explanation says the turn moved onto paid usage");
});

test("a free label the catalog price contradicts is still costed as money", () => {
	const mislabelled = mergeConfig(cfg, {
		models: { ...cfg.models, "openrouter/*": { billing: "free" } },
		tiers: { ...cfg.tiers, light: ["openrouter/z-ai/glm-5.3"] },
	});
	const d = chooseModel({
		tier: "light",
		confidence: 0.9,
		current: undefined,
		registry: fakeRegistry(ALL),
		cfg: mislabelled,
		ledger: ledger(),
		contextTokens: 50_000,
	});
	const c = d.candidates.find((x) => x.key === "openrouter/z-ai/glm-5.3")!;
	assert.equal(c.assessment?.basis, "pay-per-token", "the label is contradicted, so the pay-per-token rule decides");
	assert.ok(c.costUsd > 0, "a route at a non-zero list price is not free");
	assert.ok(c.assessment?.uncertainty.some((u) => /list-price estimate/.test(u)), c.assessment?.uncertainty.join(" | "));
	assert.ok(c.assessment?.uncertainty.some((u) => /catalog price is not zero/.test(u)));
});

test("a configured billed label decides, whatever the catalog price says", () => {
	// A catalog zero also means "price not published": pi ships `openrouter/auto` at cost 0 and it bills.
	const auto = model("openrouter", "auto");
	const a = assessBilling({ model: auto, cfg, registry: fakeRegistry([auto]), ledger: ledger() });
	assert.equal(a.basis, "pay-per-token");
	assert.equal(a.eligibility, "allowed");

	// And the same route is held to the gates a billed route is held to.
	const l = ledger();
	l.applyEntitlement("openrouter", parseEntitlement("openrouter-key", { data: { limit: 10, limit_remaining: 0 } }));
	assert.equal(assessBilling({ model: auto, cfg, registry: fakeRegistry([auto]), ledger: l }).eligibility, "excluded");
});

test("a zero catalog price decides only where no label claims the route", () => {
	const local = model("some-local-runtime", "tiny");
	const a = assessBilling({ model: local, cfg, registry: fakeRegistry([local]), ledger: ledger() });
	assert.equal(a.basis, "free");
	assert.equal(a.eligibility, "preferred");
	assert.ok(a.evidence.some((e) => /catalog list price is zero/.test(e)), a.evidence.join(" | "));
});

test("a fresh credit fact does not verify a quota window that is hours old", () => {
	const l = ledger();
	l.observeResponse("openai-codex", 200, { "x-codex-primary-used-percent": "50", "x-codex-plan-type": "plus" }, cfg);
	const later = Date.now() + 10 * 60 * 60_000;
	l.applyEntitlement("openai-codex", { credits: { hasCredits: true } }, later);

	const a = assess(codex, l, cfg, later);
	assert.equal(a.verification, "stale", "the verdict rests on the windows, not on whatever evidence is newest");
	assert.notEqual(a.eligibility, "preferred");
	assert.ok(a.uncertainty.some((u) => /older than 30m/.test(u)), a.uncertainty.join(" | "));
});

test("a spent subscription overflows onto its own credits before any other billed route", () => {
	const l = ledger();
	l.observeResponse("openai-codex", 200, CODEX_EXHAUSTED_WITH_CREDITS, cfg);
	const both = mergeConfig(cfg, {
		tiers: { ...cfg.tiers, standard: ["openrouter/z-ai/glm-5.3", "openai-codex/gpt-6-astra", "anthropic/claude-opus-5"] },
	});
	const d = chooseModel({
		tier: "standard",
		confidence: 0.9,
		current: undefined,
		registry: fakeRegistry(ALL, ["claude-bridge", "openai-codex", "xai"]),
		cfg: both,
		ledger: l,
		contextTokens: 10_000,
	});
	assert.equal(d.model?.provider, "openai-codex");
	assert.equal(d.billing?.basis, "extra-credits");
	const ranks = Object.fromEntries(d.candidates.map((c) => [c.key, c.assessment?.rank]));
	assert.ok(ranks["openai-codex/gpt-6-astra"]! < ranks["openrouter/z-ai/glm-5.3"]!);
	assert.ok(ranks["openai-codex/gpt-6-astra"]! < ranks["anthropic/claude-opus-5"]!, "paid Anthropic is the last resort, not the ban it used to be");
});

test("one filled per-family meter does not condemn the whole subscription", () => {
	// docs/research/plan-quotas.md: `additional_rate_limits` meters one model family, while the
	// account's own `rate_limit` still has room. Family ids are discovered at runtime.
	const l = ledger();
	l.applyEntitlement(
		"openai-codex",
		parseEntitlement("codex-wham-usage", {
			plan_type: "plus",
			rate_limit: { primary_window: { used_percent: 20 }, secondary_window: { used_percent: 10 } },
			additional_rate_limits: [{ limit_name: "GPT-5.3-Codex-Spark", rate_limit: { limit_reached: true, primary_window: { used_percent: 100 } } }],
			credits: { has_credits: true, balance: "12" },
		}),
	);
	const a = assess(codex, l);
	assert.equal(a.basis, "subscription", "the plan is not spent, so the turn must not move onto credits");
	assert.notEqual(a.eligibility, "excluded");
	assert.equal(l.assess("openai-codex", "openai-codex/gpt-6-astra", cfg).exhaustedAccount.length, 0);
});
