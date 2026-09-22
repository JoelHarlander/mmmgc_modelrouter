import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, globMatch, mergeConfig, type RouterConfig } from "../src/config.ts";
import { choiceConfidence, JevClient } from "../src/jev.ts";
import { Ledger } from "../src/ledger.ts";
import { chooseModel, heuristicTier } from "../src/router.ts";

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

const cfg: RouterConfig = mergeConfig(DEFAULT_CONFIG, {
	tiers: {
		light: ["cheap/flash", "local/free"],
		standard: ["plan/mid", "cheap/big"],
		heavy: ["plan/top", "cheap/top"],
	},
	models: { "plan/*": { billing: "plan" }, "cheap/*": { billing: "on-demand" }, "local/*": { billing: "free" } },
	// Pay-per-token routes are reachable only where they are named, so this fixture names its own.
	billing: { ...DEFAULT_CONFIG.billing, allowPayPerToken: ["cheap/*"], probe: { ...DEFAULT_CONFIG.billing.probe, enabled: false } },
});

const models = [
	model("cheap", "flash", { input: 0.075, output: 0.25, cacheRead: 0.015 }),
	model("local", "free"),
	model("plan", "mid", { input: 10, output: 50 }),
	model("cheap", "big", { input: 2, output: 10, cacheRead: 0.2 }),
	model("plan", "top", { input: 10, output: 50 }),
	model("cheap", "top", { input: 10, output: 50, cacheRead: 1 }),
];

function ledger() {
	return new Ledger(join(mkdtempSync(join(tmpdir(), "mr-")), "usage.json"));
}

test("light tier picks the free local model over a cheap paid one", () => {
	const d = chooseModel({ tier: "light", confidence: 0.9, current: models[4], registry: fakeRegistry(models), cfg, ledger: ledger(), contextTokens: 50_000 });
	assert.equal(d.model?.id, "free");
	assert.equal(d.switched, true);
});

test("plan model beats on-demand in the same tier at zero marginal cost", () => {
	const d = chooseModel({ tier: "standard", confidence: 0.9, current: undefined, registry: fakeRegistry(models), cfg, ledger: ledger(), contextTokens: 10_000 });
	assert.equal(d.model?.id, "mid");
	assert.equal(d.model?.provider, "plan");
});

test("exhausted plan provider is skipped and the tier falls back to on-demand", () => {
	const l = ledger();
	l.observeResponse("plan", 200, { "anthropic-ratelimit-unified-5h-utilization": "0.97", "anthropic-ratelimit-unified-5h-status": "allowed_warning" }, cfg);
	const d = chooseModel({ tier: "standard", confidence: 0.9, current: undefined, registry: fakeRegistry(models), cfg, ledger: l, contextTokens: 10_000 });
	assert.equal(d.model?.id, "big");
	assert.match(d.candidates.find((c) => c.key === "plan/mid")?.skipped ?? "", /5h 97% used/);
});

test("429 puts the provider in cooldown using retry-after", () => {
	const l = ledger();
	l.observeResponse("plan", 429, { "retry-after": "120" }, cfg);
	const d = chooseModel({ tier: "standard", confidence: 0.9, current: undefined, registry: fakeRegistry(models), cfg, ledger: l, contextTokens: 0 });
	assert.match(d.candidates.find((c) => c.key === "plan/mid")?.skipped ?? "", /rate limited \(429\)/);
	assert.deepEqual(l.assess("plan", "plan/mid", cfg, Date.now() + 121_000).exhaustedAccount, [], "and it lifts when retry-after has passed");
});

test("codex used-percent headers map to 0..1 utilization per window", () => {
	const l = ledger();
	l.observeResponse("openai-codex", 200, { "x-codex-primary-used-percent": "42", "x-codex-secondary-used-percent": "88", "x-codex-primary-reset-after-seconds": "600" }, cfg);
	const state = l.peekProvider("openai-codex")!;
	assert.equal(state.windows.primary?.utilization, 0.42);
	assert.equal(state.windows.secondary?.utilization, 0.88);
	assert.ok(l.assess("openai-codex", "openai-codex/gpt-6-astra", cfg).exhaustedAccount.some((w) => w.id === "secondary"));
	assert.equal(l.assess("openai-codex", "openai-codex/gpt-6-astra", cfg).accountUtilization, 0.88);
});

test("low confidence keeps the current model", () => {
	const d = chooseModel({ tier: "light", confidence: 0.2, current: models[4], registry: fakeRegistry(models), cfg, ledger: ledger(), contextTokens: 0 });
	assert.equal(d.model?.id, "top");
	assert.equal(d.switched, false);
});

test("cache switch penalty keeps a warm on-demand model when the alternative is not cheaper", () => {
	const warmCfg = mergeConfig(cfg, { tiers: { ...cfg.tiers, standard: ["cheap/big", "cheap/top"] } });
	// current is cheap/top with 200k warm context; cheap/big would need a full re-read.
	const d = chooseModel({ tier: "standard", confidence: 0.9, current: models[5], registry: fakeRegistry(models), cfg: warmCfg, ledger: ledger(), contextTokens: 200_000 });
	const big = d.candidates.find((c) => c.key === "cheap/big")!;
	const top = d.candidates.find((c) => c.key === "cheap/top")!;
	assert.ok(big.switchPenaltyUsd > 0);
	assert.equal(top.switchPenaltyUsd, 0);
	// Warm top: 200k * $1 cacheRead = $0.20 + output; cold big: 200k * $2 = $0.40 + penalty. Stay put.
	assert.equal(d.model?.id, "top");
});

test("tier with no usable model escalates to the next heavier tier", () => {
	const reg = fakeRegistry(models, [], ["cheap", "local"]);
	const d = chooseModel({ tier: "light", confidence: 0.9, current: undefined, registry: reg, cfg, ledger: ledger(), contextTokens: 0 });
	assert.equal(d.tier, "standard");
	assert.equal(d.model?.id, "mid");
});

test("jev transport resolution: direct key first, then gateway key from pi auth", () => {
	const base = { ...DEFAULT_CONFIG.jev, apiKeyEnv: "MR_TEST_TS_KEY", gatewayApiKeyEnv: "MR_TEST_GW_KEY" };
	delete process.env.MR_TEST_TS_KEY;
	delete process.env.MR_TEST_GW_KEY;
	const none = new JevClient(base);
	assert.equal(none.transport(), undefined);
	assert.equal(none.available(), false);

	const stored = new JevClient(base);
	stored.setStoredGatewayKey("vck_stored");
	assert.equal(stored.transport(), "gateway");
	assert.equal(stored.gatewayKey(), "vck_stored");

	const both = new JevClient({ ...base, apiKey: "ts_direct", gatewayApiKey: "vck_cfg" });
	assert.equal(both.transport(), "typesafe");
	assert.equal(new JevClient({ ...base, transport: "gateway", apiKey: "ts_direct", gatewayApiKey: "vck_cfg" }).transport(), "gateway");
	assert.equal(new JevClient({ ...base, transport: "typesafe", gatewayApiKey: "vck_cfg" }).transport(), undefined);
	assert.match(both.describe(), /api\.typesafe\.ai/);
	assert.match(stored.describe(), /Vercel AI Gateway/);
});

test("glob and heuristics", () => {
	assert.ok(globMatch("openrouter/*", "openrouter/z-ai/glm-5.3"));
	assert.ok(!globMatch("openrouter/*", "anthropic/claude-opus-5"));
	assert.equal(heuristicTier("ls").tier, "light");
	assert.equal(heuristicTier("why does this deadlock under load?").tier, "heavy");
	assert.equal(choiceConfidence({ a: 0.9, b: 0.06, c: 0.04 }).toFixed(2), "0.85");
});

test("a low-confidence turn keeps the current model only once billing has cleared it", () => {
	const d = chooseModel({ tier: "light", confidence: 0.2, current: models[2], registry: fakeRegistry(models), cfg, ledger: ledger(), contextTokens: 0 });
	assert.equal(d.model?.id, "mid", "an eligible model is still kept below the confidence floor");
	assert.equal(d.switched, false);
	assert.equal(d.billing?.basis, "subscription", "and its basis travels with the decision");
	assert.ok(d.candidates.some((c) => c.key === "plan/mid"));
});

test("a low-confidence turn routes away from a current model the billing gate refuses", () => {
	const denied = mergeConfig(cfg, { billing: { ...cfg.billing, allowPayPerToken: [] } });
	const d = chooseModel({ tier: "light", confidence: 0.2, current: models[3], registry: fakeRegistry(models), cfg: denied, ledger: ledger(), contextTokens: 0 });
	assert.notEqual(d.model?.provider, "cheap", "an ineligible route is not kept for want of confidence");
	assert.equal(d.switched, true);
	assert.notEqual(d.billing?.eligibility, "excluded");
});

test("a low-confidence turn with nothing eligible names the current model as ineligible", () => {
	const denied = mergeConfig(cfg, { billing: { ...cfg.billing, allowPayPerToken: [] } });
	const d = chooseModel({
		tier: "light",
		confidence: 0.2,
		current: models[3],
		registry: fakeRegistry(models, [], ["plan", "local"]),
		cfg: denied,
		ledger: ledger(),
		contextTokens: 0,
	});
	assert.equal(d.model?.id, "big", "there is nowhere else to go, so the session stays put");
	assert.match(d.ineligibleCurrent ?? "", /not in billing\.allowPayPerToken/, "but it is never kept silently");
});

test("the model the router refused to keep is still named in the explanation", () => {
	// A manual /model pick can leave the session on a model no tier lists; leaving it must be explained.
	const legacy = model("cheap", "legacy", { input: 10, output: 50 });
	const denied = mergeConfig(cfg, { billing: { ...cfg.billing, allowPayPerToken: [] } });
	const d = chooseModel({
		tier: "light",
		confidence: 0.2,
		current: legacy,
		registry: fakeRegistry([...models, legacy]),
		cfg: denied,
		ledger: ledger(),
		contextTokens: 0,
	});
	assert.equal(d.switched, true);
	const held = d.candidates.find((c) => c.key === "cheap/legacy");
	assert.match(held?.skipped ?? "", /not in billing\.allowPayPerToken/);
});
