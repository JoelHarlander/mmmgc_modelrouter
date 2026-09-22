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

function fakeRegistry(models: Model<Api>[], oauth: string[] = [], unauthed: string[] = []): ModelRegistry {
	return {
		find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
		hasConfiguredAuth: (m: Model<Api>) => !unauthed.includes(m.provider),
		isUsingOAuth: (m: Model<Api>) => oauth.includes(m.provider),
	} as unknown as ModelRegistry;
}

/** The meters a ledger holds for Codex, without the inert refusal markers a 2xx leaves behind. */
function quotaWindowIds(l: Ledger): string[] {
	return Object.keys(l.peekProvider("openai-codex")!.windows)
		.filter((id) => id !== "rate-limited" && id !== "budget-exhausted")
		.sort();
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
		standard: ["claude-bridge/claude-opus-5", "openai-codex/gpt-6-astra", "openrouter/z-ai/glm-5.3"],
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
	assert.match(a.reason, /only spent on verified credits/);
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
	assert.match(a.reason, /only spent on verified credits/);
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
	// A scope entry still governs a window when one names it, by the id the evidence carries.
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

test("a stale no-credits fact stops excluding a route instead of stranding it forever", () => {
	// The gateway reported an empty balance, the user topped it up, and the next probe failed.
	const l = ledger();
	l.applyEntitlement("vercel-ai-gateway", parseEntitlement("vercel-credits", { balance: 0 }));
	const fresh = assess(gateway, l);
	assert.equal(fresh.eligibility, "excluded");

	const later = Date.now() + 90 * 60_000;
	const stale = assess(gateway, l, cfg, later);
	assert.equal(stale.eligibility, "allowed", "evidence nobody has refreshed cannot keep a route unusable");
	assert.ok(stale.uncertainty.some((u) => /no credits.*older than 30m/.test(u)), stale.uncertainty.join(" | "));
});

test("an exhausted family meter excludes its own model and leaves the credential usable", () => {
	// The wire shape per docs/research/plan-quotas.md: the per-family prefix is an opaque metered
	// limit id, and the model it meters arrives in `x-codex-<id>-limit-name`.
	const l = ledger();
	l.observeResponse(
		"openai-codex",
		200,
		{
			"x-codex-primary-used-percent": "20",
			"x-codex-bengalfox-primary-used-percent": "100",
			"x-codex-bengalfox-limit-name": "gpt-6-astra",
			"x-codex-active-limit": "bengalfox",
		},
		cfg,
	);
	const a = assess(codex, l);
	assert.equal(a.eligibility, "excluded");
	assert.match(a.reason, /model-scoped quota exhausted \(gpt-6-astra:primary/);
	assert.match(a.reason, /openai-codex stays usable for other models/);

	const sibling = model("openai-codex", "gpt-6-mini", { input: 1, output: 4 });
	assert.notEqual(assessBilling({ model: sibling, cfg, registry: fakeRegistry([...ALL, sibling], ["openai-codex"]), ledger: l }).eligibility, "excluded");
});

test("the poll path and the header path name a family window the same way", () => {
	const polled = ledger();
	polled.applyEntitlement(
		"openai-codex",
		parseEntitlement("codex-wham-usage", {
			rate_limit: { primary_window: { used_percent: 20 } },
			additional_rate_limits: [{ limit_name: "GPT-6-Astra", rate_limit: { primary_window: { used_percent: 100 } } }],
		}),
	);
	const fromPoll = assess(codex, polled);
	assert.equal(fromPoll.eligibility, "excluded");
	assert.match(fromPoll.reason, /gpt-6-astra:primary/);

	// The same meter seen through the headers keys the same window, so a later poll refreshes it.
	const headed = ledger();
	headed.observeResponse(
		"openai-codex",
		200,
		{ "x-codex-primary-used-percent": "20", "x-codex-bengalfox-primary-used-percent": "100", "x-codex-bengalfox-limit-name": "GPT-6-Astra" },
		cfg,
	);
	assert.deepEqual(quotaWindowIds(headed), quotaWindowIds(polled));

	headed.applyEntitlement(
		"openai-codex",
		parseEntitlement("codex-wham-usage", {
			rate_limit: { primary_window: { used_percent: 20 } },
			additional_rate_limits: [{ limit_name: "GPT-6-Astra", rate_limit: { primary_window: { used_percent: 5 } } }],
		}),
	);
	assert.notEqual(assess(codex, headed).eligibility, "excluded", "a poll that says the family has room clears the header's meter");
});

test("a scoped exclusion does not claim the provider is usable when the account is spent too", () => {
	const l = ledger();
	l.observeResponse(
		"claude-bridge",
		200,
		{
			"anthropic-ratelimit-unified-5h-utilization": "1",
			"anthropic-ratelimit-unified-5h-status": "rejected",
			"anthropic-ratelimit-unified-7d_opus-utilization": "1",
			"anthropic-ratelimit-unified-7d_opus-status": "rejected",
		},
		cfg,
	);
	const a = assess(opus, l);
	assert.equal(a.eligibility, "excluded");
	assert.match(a.reason, /model-scoped quota exhausted \(7d_opus rejected\)/);
	assert.match(a.reason, /spent account-wide too \(5h rejected\)/);
	assert.ok(!/stays usable/.test(a.reason), a.reason);
});

test("a family meter keyed by a dotted limit name still excludes exactly its own model", () => {
	// docs/research/plan-quotas.md: `x-codex-<limitId>-limit-name` carries the model id verbatim,
	// dots and all (`gpt-5.2-codex-sonic`), and the meter governs that model alone.
	const sonic = model("openai-codex", "gpt-5.2-codex-sonic", { input: 1.25, output: 10 });
	const l = ledger();
	l.observeResponse(
		"openai-codex",
		200,
		{
			"x-codex-primary-used-percent": "20",
			"x-codex-bengalfox-primary-used-percent": "100",
			"x-codex-bengalfox-limit-name": "gpt-5.2-codex-sonic",
		},
		cfg,
	);
	const registry = fakeRegistry([...ALL, sonic], ["claude-bridge", "openai-codex", "xai"]);
	const spent = assessBilling({ model: sonic, cfg, registry, ledger: l });
	assert.equal(spent.eligibility, "excluded");
	assert.match(spent.reason, /model-scoped quota exhausted \(gpt-5.2-codex-sonic:primary/);
	assert.match(spent.reason, /openai-codex stays usable for other models/);

	assert.notEqual(assessBilling({ model: codex, cfg, registry, ledger: l }).eligibility, "excluded", "its sibling keeps the same credential");
	assert.deepEqual(l.assess("openai-codex", "openai-codex/gpt-6-astra", cfg).exhaustedAccount, []);
});

/** The documented Fable-only refusal: its weekly bucket is spent while 5h and 7d are allowed. */
const FABLE_ONLY_REJECTED = {
	"anthropic-ratelimit-unified-5h-utilization": "0.12",
	"anthropic-ratelimit-unified-5h-status": "allowed",
	"anthropic-ratelimit-unified-7d-utilization": "0.51",
	"anthropic-ratelimit-unified-7d-status": "allowed",
	"anthropic-ratelimit-unified-7d_oi-status": "rejected",
	"anthropic-ratelimit-unified-7d_oi-reset": String(Math.floor((Date.now() + 5 * 24 * 60 * 60_000) / 1000)),
};

test("a Fable-only rejection seen on a 200 excludes Fable and leaves Opus usable", () => {
	// docs/research/plan-quotas.md §1: an overage- or Fable-only rejection with 5h/7d allowed is
	// model-scoped - route to another model on the same credential rather than cooling it down.
	const l = ledger();
	l.observeResponse("claude-bridge", 200, FABLE_ONLY_REJECTED, cfg);

	assert.deepEqual(l.assess("claude-bridge", "claude-bridge/claude-opus-5", cfg).refused, [], "the credential itself was not refused");
	assert.equal(assess(opus, l).eligibility, "preferred");
	assert.equal(assess(fable, l).eligibility, "excluded");
});

test("the same rejection arriving as a 429 with retry-after still only excludes Fable", () => {
	// The quota-exhaustion 429 carries retry-after set to the weekly reset. Honouring that for the
	// whole credential would take Opus down for days on an account whose own windows are healthy.
	const l = ledger();
	l.observeResponse("claude-bridge", 429, { ...FABLE_ONLY_REJECTED, "retry-after": String(5 * 24 * 60 * 60) }, cfg);

	assert.deepEqual(l.assess("claude-bridge", "claude-bridge/claude-opus-5", cfg).refused, [], "a scoped refusal never cools the credential");
	assert.equal(assess(opus, l).eligibility, "preferred");
	const fableVerdict = assess(fable, l);
	assert.equal(fableVerdict.eligibility, "excluded");
	assert.match(fableVerdict.reason, /model-scoped quota exhausted \(7d_oi rejected\)/);
});

test("a per-family Codex refusal leaves the rest of the credential usable", () => {
	// The header path reports a filled family meter as utilization, never as a status, so the
	// account-wide question has to be asked of what is spent, not of what says "rejected".
	const l = ledger();
	l.observeResponse(
		"openai-codex",
		429,
		{
			"x-codex-primary-used-percent": "20",
			"x-codex-bengalfox-primary-used-percent": "100",
			"x-codex-bengalfox-limit-name": "gpt-6-astra",
			"retry-after": "13873",
		},
		cfg,
	);
	const sibling = model("openai-codex", "gpt-6-mini", { input: 1, output: 4 });
	const registry = fakeRegistry([...ALL, sibling], ["claude-bridge", "openai-codex", "xai"]);

	assert.deepEqual(l.assess("openai-codex", "openai-codex/gpt-6-mini", cfg).exhaustedAccount, []);
	assert.deepEqual(l.assess("openai-codex", "openai-codex/gpt-6-mini", cfg).refused, [], "a family meter answered for the refusal");
	assert.notEqual(assessBilling({ model: sibling, cfg, registry, ledger: l }).eligibility, "excluded");
	assert.equal(assessBilling({ model: codex, cfg, registry, ledger: l }).eligibility, "excluded", "only the family that filled its meter is out");
});

test("a scoped window spent days ago does not suppress a later unrelated refusal", () => {
	// The refusal has to be attributed from the response that carried it: a Fable bucket stored
	// last week says nothing about a refusal arriving today.
	const l = ledger();
	l.observeResponse("claude-bridge", 200, FABLE_ONLY_REJECTED, cfg);
	l.observeResponse("claude-bridge", 429, { "retry-after": "600" }, cfg, Date.now() + 60_000);

	const cooled = l.assess("claude-bridge", "claude-bridge/claude-opus-5", cfg, Date.now() + 60_000);
	assert.match(cooled.refused.map((w) => w.reason).join(","), /rate limited \(429\)/, "the credential's own refusal still cools it");
	assert.equal(assess(opus, l, cfg, Date.now() + 60_000).eligibility, "excluded");
});

test("an account-wide rejection keeps every route on the credential out", () => {
	const l = ledger();
	l.observeResponse(
		"claude-bridge",
		429,
		{
			"anthropic-ratelimit-unified-5h-utilization": "1",
			"anthropic-ratelimit-unified-5h-status": "rejected",
			"anthropic-ratelimit-unified-7d-utilization": "0.9",
			"anthropic-ratelimit-unified-7d-status": "allowed",
			"retry-after": "600",
		},
		cfg,
	);
	for (const m of [opus, fable]) {
		const a = assess(m, l);
		assert.equal(a.eligibility, "excluded", modelKey(m));
		assert.match(a.reason, /5h rejected|not in billing\.allowExtraBilled/);
	}
});

test("a bare entitlement-gate 429 is not quota pressure and does not cool the credential", () => {
	// docs/research/plan-quotas.md §1: a headerless 429 is the entitlement gate, about the shape of
	// the request rather than the account. Recording it as exhaustion would back a healthy
	// subscription off itself for half an hour on evidence the provider never gave - and would then
	// keep routing away from the credential that alone could clear it.
	const l = ledger();
	const t0 = Date.now();
	l.observeResponse("claude-bridge", 200, { "anthropic-ratelimit-unified-5h-utilization": "0.2" }, cfg, t0);
	assert.equal(assess(opus, l, cfg, t0).eligibility, "preferred");

	l.observeResponse("claude-bridge", 429, {}, cfg, t0 + 1_000);

	assert.deepEqual(l.assess("claude-bridge", "claude-bridge/claude-opus-5", cfg, t0 + 1_000).refused, [], "nothing to cool down for");
	const refusal = l.peekProvider("claude-bridge")?.windows["rate-limited"];
	assert.ok(refusal === undefined || refusal.resetAt! <= t0 + 1_000, "and nothing live that a later success would have to clear");
	assert.equal(assess(opus, l, cfg, t0 + 1_000).eligibility, "preferred", "the windows the provider did report are still healthy");
});

test("a 429 that bounds itself with retry-after does cool the credential, briefly", () => {
	// A provider that says when to come back has said something about the account, so honour it -
	// for exactly that long, and let an earlier success clear it.
	const l = ledger();
	const t0 = Date.now();
	l.observeResponse("claude-bridge", 200, { "anthropic-ratelimit-unified-5h-utilization": "0.2" }, cfg, t0);
	l.observeResponse("claude-bridge", 429, { "retry-after": "600" }, cfg, t0 + 1_000);

	assert.equal(assess(opus, l, cfg, t0 + 1_000).eligibility, "excluded");
	assert.match(assess(opus, l, cfg, t0 + 1_000).reason, /rate limited \(429\)/);
	const later = t0 + 611_000;
	assert.deepEqual(l.assess("claude-bridge", "claude-bridge/claude-opus-5", cfg, later).refused, [], "and it lifts when retry-after has passed");

	l.observeResponse("claude-bridge", 200, {}, cfg, t0 + 2_000);
	assert.deepEqual(l.assess("claude-bridge", "claude-bridge/claude-opus-5", cfg, t0 + 2_000).refused, [], "a success clears it early");
	assert.equal(assess(opus, l, cfg, t0 + 2_000).eligibility, "preferred");
});

test("a cleared refusal stays cleared through a save and merge cycle", () => {
	// The clear has to be a state the per-window merge can settle, or the next save brings the
	// refusal back and strands a credential that has demonstrably answered.
	const dir = mkdtempSync(join(tmpdir(), "mr-refusal-"));
	const t0 = Date.now();
	const l = new Ledger(ledgerPath(dir));
	l.observeResponse("claude-bridge", 200, { "anthropic-ratelimit-unified-5h-utilization": "0.2" }, cfg, t0);
	l.observeResponse("claude-bridge", 429, { "retry-after": "600" }, cfg, t0 + 1_000);
	l.save();
	assert.equal(assess(opus, l, cfg, t0 + 1_000).eligibility, "excluded");

	l.observeResponse("claude-bridge", 200, {}, cfg, t0 + 2_000);
	l.save();

	const now = t0 + 3_000;
	assert.equal(assess(opus, l, cfg, now).eligibility, "preferred", "the session that cleared it keeps it cleared");
	const reopened = new Ledger(ledgerPath(dir));
	assert.equal(assess(opus, reopened, cfg, now).eligibility, "preferred", "and so does a session that reads the file");
});

test("quota seen through one provider id is quota for every id on that credential", () => {
	// pi resolved the same credential for `claude-bridge` and `anthropic`, so a refusal seen
	// through one is a fact about the account: routing must not escalate onto the sibling id and
	// burn another turn.
	const l = ledger();
	l.linkAccount("claude-bridge", "anthropic");
	l.observeResponse("claude-bridge", 429, { "retry-after": "600" }, cfg);

	const sibling = assessBilling({ model: claudeApi, cfg, registry: fakeRegistry(ALL, ["claude-bridge", "anthropic"]), ledger: l });
	assert.equal(sibling.eligibility, "excluded", "anthropic/* is the same subscription that just refused");
	assert.match(sibling.reason, /rate limited \(429\)/);
});

test("a spent meter no configured route answers to is disclosed rather than ignored", () => {
	// docs/research/plan-quotas.md records `premium` as a real x-codex-active-limit value: a
	// metered-limit id that is not a model name, so nothing can place the meter it belongs to.
	const l = ledger();
	l.observeResponse(
		"openai-codex",
		200,
		{
			"x-codex-primary-used-percent": "20",
			"x-codex-premium-primary-used-percent": "100",
			"x-codex-active-limit": "premium",
			"x-codex-plan-type": "plus",
		},
		cfg,
	);
	const a = assess(codex, l);
	assert.notEqual(a.eligibility, "excluded", "an unplaceable meter must not deny a working subscription route");
	assert.notEqual(a.eligibility, "preferred");
	assert.notEqual(a.verification, "verified", "nor let the verdict claim evidence it does not have");
	assert.ok(
		a.uncertainty.some((u) => /spent meter no configured route answers to \(premium:primary/.test(u)),
		a.uncertainty.join(" | "),
	);
	// Ordering has to say what the other two fields say, or routing treats it as verified anyway.
	const l2 = ledger();
	l2.observeResponse("openai-codex", 200, { "x-codex-primary-used-percent": "20", "x-codex-plan-type": "plus" }, cfg);
	assert.ok(a.rank > assess(codex, l2).rank, "an unplaceable meter costs the route its verified rank");

	const local = model("ds4", "deepseek-v4-flash");
	const lFree = ledger();
	lFree.observeResponse("ds4", 200, { "x-codex-primary-used-percent": "20", "x-codex-premium-primary-used-percent": "100" }, cfg);
	const free = assessBilling({ model: local, cfg, registry: fakeRegistry([local]), ledger: lFree });
	assert.equal(free.rank, assessBilling({ model: local, cfg, registry: fakeRegistry([local]), ledger: ledger() }).rank, "but a quota meter cannot demote a zero-cost route");
});

test("a refusal the response placed nowhere is not an exhausted subscription credits may cover", () => {
	// `openai-codex/*` is in billing.allowExtraBilled with credits to spend, so reading a refusal
	// as spent subscription quota would move the turn onto paid credits and send it straight back
	// to the provider that is refusing.
	const l = ledger();
	l.applyEntitlement("openai-codex", { credits: { hasCredits: true, balance: "12" } });
	l.observeResponse("openai-codex", 429, { "retry-after": "600" }, cfg);

	const a = assess(codex, l);
	assert.equal(a.eligibility, "excluded");
	assert.match(a.reason, /rate limited \(429\)/);
	assert.notEqual(a.basis, "extra-credits", "a refusal is not permission to spend credits");
});

test("a 429 whose only spent meter is one nothing can place still cools the credential", () => {
	// docs/research/plan-quotas.md records `codex_other` as a real normalized limit id that is not
	// a model name: a meter the router cannot place cannot be what the provider refused for.
	const l = ledger();
	l.observeResponse("openai-codex", 429, { "x-codex-codex_other-primary-used-percent": "100" }, cfg);

	const a = assess(codex, l);
	assert.equal(a.eligibility, "excluded");
	assert.match(a.reason, /rate limited \(429\)/, "the refusal is the credential's own");
	assert.ok(a.uncertainty.some((u) => /spent meter no configured route answers to/.test(u)), "and the meter is still disclosed");

	const q = l.assess("openai-codex", "openai-codex/gpt-6-astra", cfg);
	assert.match(q.unattributed.map((w) => w.id).join(","), /codex_other:primary/);
});

test("a subscription refusal on the bridge does not exclude a separately authenticated Anthropic route", () => {
	// `claude-bridge` declares it routes on `anthropic`'s credential, but a declaration is not
	// proof, and nothing proved these two are one account. A spent subscription must not take the
	// paid overflow down with it - that is the moment the overflow exists for.
	const spent = {
		"anthropic-ratelimit-unified-7d-utilization": "1",
		"anthropic-ratelimit-unified-7d-status": "rejected",
	};
	const l = ledger();
	l.observeResponse("claude-bridge", 200, spent, cfg);

	assert.equal(assess(opus, l).eligibility, "excluded", "the subscription itself is spent");
	const paid = assess(claudeApi, l);
	assert.equal(paid.basis, "pay-per-token");
	assert.equal(paid.eligibility, "allowed", "the API key bills a credential the subscription says nothing about");
	assert.ok(paid.rank > assess(codex, l).rank, "still ranked behind included usage, but reachable");

	// And that is the fallback, not the only answer: the same evidence excludes it once pi has
	// resolved one credential for both ids.
	const proven = ledger();
	proven.linkAccount("claude-bridge", "anthropic");
	proven.observeResponse("claude-bridge", 200, spent, cfg);
	assert.equal(assess(claudeApi, proven).eligibility, "excluded", "one proven account is one quota");
});

test("an overage-only refusal is the credential's own, not something the extra-billed pool explains", () => {
	// docs/research/plan-quotas.md §1: the overage bucket is the extra-billed pool, so a rejection
	// there refuses credits and nothing else. It cannot be what refused a call on included usage,
	// and reading it that way leaves the router looping on a route the provider just turned away.
	const l = ledger();
	const t0 = Date.now();
	l.observeResponse(
		"claude-bridge",
		429,
		{
			"anthropic-ratelimit-unified-5h-utilization": "0.2",
			"anthropic-ratelimit-unified-5h-status": "allowed",
			"anthropic-ratelimit-unified-7d-utilization": "0.4",
			"anthropic-ratelimit-unified-7d-status": "allowed",
			"anthropic-ratelimit-unified-overage-status": "rejected",
			"retry-after": "600",
		},
		cfg,
		t0,
	);

	const q = l.assess("claude-bridge", "claude-bridge/claude-opus-5", cfg, t0);
	assert.match(q.refused.map((w) => w.reason).join(","), /rate limited \(429\)/, "the refusal is recorded, not swallowed");
	assert.deepEqual(q.exhaustedAccount, [], "and the included windows are not called spent");
	assert.equal(assess(opus, l, cfg, t0).eligibility, "excluded");
	assert.equal(assess(opus, l, cfg, t0 + 611_000).eligibility, "preferred", "included usage is untouched once the refusal lifts");
});

test("verified credits are preferred over a plan nothing has verified", () => {
	// The ChatGPT plan is spent but its credits are confirmed, while `xai/*` is a plan only because
	// pi holds OAuth for it - and the intent records xAI per-request billing as unproven. Evidence
	// has to outrank an assumption, or the turn overflows onto the guess instead of the credits.
	const l = ledger();
	l.applyEntitlement(
		"openai-codex",
		parseEntitlement("codex-wham-usage", { rate_limit: { primary_window: { used_percent: 100 } }, credits: { has_credits: true, balance: "9" } }),
	);

	const credits = assess(codex, l);
	const assumed = assess(grok, l);
	assert.equal(credits.basis, "extra-credits");
	assert.equal(credits.verification, "verified");
	assert.equal(assumed.basis, "subscription");
	assert.notEqual(assumed.verification, "verified");
	assert.notEqual(assumed.eligibility, "excluded", "still reachable, just not first");
	assert.ok(credits.rank < assumed.rank, "verified credits outrank an assumed plan");
});
