/**
 * The session model policy: the user keeps the model they chose, the preference list is
 * the order a spent subscription falls through, and each series name resolves to the best
 * model pi can use in that series.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, mergeConfig, type RouterConfig } from "../src/config.ts";
import { Ledger } from "../src/ledger.ts";
import { planTurn, resolveEntry, sessionModel, versionCompare } from "../src/preference.ts";

function model(provider: string, id: string, cost: Partial<Model<Api>["cost"]> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://x",
		reasoning: true,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 0, ...cost },
		contextWindow: 200000,
		maxTokens: 8192,
	} as Model<Api>;
}

const fable5 = model("claude-bridge", "claude-fable-5");
const fable51 = model("claude-bridge", "claude-fable-5-1");
const fableApi = model("anthropic", "claude-fable-5-1");
const grok46 = model("xai", "grok-4.6");
const grok47 = model("xai", "grok-4.7");
const opus5 = model("claude-bridge", "claude-opus-5");
const opus55 = model("claude-bridge", "claude-opus-5-5");
const astra = model("openai-codex", "gpt-6-astra");
const fauxA = model("faux", "a", { input: 10, output: 50 });
const fauxB = model("faux", "b", { input: 0.1, output: 0.4 });
const CATALOG = [fable5, fable51, fableApi, grok46, grok47, opus5, opus55, astra, fauxA, fauxB];

function registry(unauthed: string[] = []): ModelRegistry {
	return {
		find: (p: string, id: string) => CATALOG.find((m) => m.provider === p && m.id === id),
		hasConfiguredAuth: (m: Model<Api>) => !unauthed.includes(m.provider),
		isUsingOAuth: (m: Model<Api>) => ["claude-bridge", "xai", "openai-codex", "anthropic"].includes(m.provider),
		getAvailable: () => CATALOG.filter((m) => !unauthed.includes(m.provider)),
	} as unknown as ModelRegistry;
}

function ledger() {
	return new Ledger(join(mkdtempSync(join(tmpdir(), "mr-pref-")), "usage.json"));
}

const cfg: RouterConfig = mergeConfig(DEFAULT_CONFIG, {
	billing: { ...DEFAULT_CONFIG.billing, allowPayPerToken: ["faux/*"], probe: { ...DEFAULT_CONFIG.billing.probe, enabled: false } },
});

function args(extra: { ledger?: Ledger; models?: Model<Api>[]; preference?: string[]; unauthed?: string[]; now?: number } = {}) {
	return {
		cfg: extra.preference ? mergeConfig(cfg, { preference: extra.preference }) : cfg,
		registry: registry(extra.unauthed),
		ledger: extra.ledger ?? ledger(),
		models: extra.models ?? CATALOG,
		now: extra.now,
	};
}

test("a series resolves to the newest model on its subscription provider", () => {
	assert.equal(resolveEntry("fable", args())?.key, "claude-bridge/claude-fable-5-1");
	assert.equal(resolveEntry("grok", args())?.key, "xai/grok-4.7");
	assert.equal(resolveEntry("opus", args())?.key, "claude-bridge/claude-opus-5-5");
	assert.equal(resolveEntry("astra", args())?.key, "openai-codex/gpt-6-astra");
	assert.ok(versionCompare("claude-fable-5-1", "claude-fable-5") > 0);
	assert.ok(versionCompare("grok-4.7", "grok-4.6") > 0);
	assert.ok(versionCompare("claude-opus-5-5", "claude-opus-5") > 0);
});

test("a newer model on another provider does not outrank the series' subscription provider", () => {
	const onlyOlderBridge = CATALOG.filter((m) => m !== fable51);
	assert.equal(resolveEntry("fable", args({ models: onlyOlderBridge }))?.key, "claude-bridge/claude-fable-5");
});

test("with no subscription provider in the catalog, the series uses the best model that is there", () => {
	const gateway = model("faux-gw", "claude-fable-5-1", { input: 0, output: 0 });
	const picked = resolveEntry("fable", args({ models: [gateway, fauxA] }));
	assert.equal(picked?.key, "faux-gw/claude-fable-5-1");
});

test("a new session starts on the highest preference whose window is not spent", () => {
	assert.equal(sessionModel(args())?.key, "claude-bridge/claude-fable-5-1");

	const l = ledger();
	const now = Date.now();
	l.observeResponse("claude-bridge", 0, {}, cfg, now, { rateLimitType: "seven_day_overage_included", resetsAt: Math.floor(now / 1000) + 3600 });
	assert.equal(sessionModel(args({ ledger: l, now }))?.key, "xai/grok-4.7");
});

test("the model stays put across effort changes, and moves only when its subscription window is spent", () => {
	const base = args();
	const stay = planTurn({ ...base, tier: "light", confidence: 0.2, current: fable51, contextTokens: 1000 });
	assert.equal(stay.switched, false);
	assert.equal(stay.model, fable51);
	assert.match(stay.reason, /light effort on claude-bridge\/claude-fable-5-1/);

	const l = ledger();
	const now = Date.now();
	l.observeResponse("claude-bridge", 0, {}, cfg, now, { rateLimitType: "seven_day_overage_included", resetsAt: Math.floor(now / 1000) + 3600 });
	const leave = planTurn({ ...args({ ledger: l, now }), tier: "heavy", confidence: 0.9, current: fable51 });
	assert.equal(leave.switched, true);
	assert.equal(leave.model?.id, "grok-4.7");
	assert.match(leave.reason, /subscription spent/);
	assert.match(leave.reason, /claude-fable-5-1 -> xai\/grok-4\.7/);
});

test("a credential refusal is not a spent subscription window, so the model stays", () => {
	const l = ledger();
	const now = Date.now();
	l.observeResponse("claude-bridge", 429, { "retry-after": "120" }, cfg, now);
	const stayed = planTurn({ ...args({ ledger: l, now }), tier: "standard", confidence: 0.9, current: fable51 });
	assert.equal(stayed.switched, false);
	assert.equal(stayed.model, fable51);
});

test("a spent model-scoped window falls to the next series, not a pay-per-token twin", () => {
	const l = ledger();
	const now = Date.now();
	l.observeResponse("xai", 0, {}, cfg, now, {
		code: "subscription:free-usage-exhausted",
		error: "You've used all the included free usage for model grok-4.7 for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 10/10.",
		resetsAt: Math.floor(now / 1000) + 3600,
	});
	// grok-4.6 is the same series and still has quota, so the grok entry resolves to it.
	const sibling = planTurn({ ...args({ ledger: l, now }), tier: "standard", confidence: 0.8, current: grok47 });
	assert.equal(sibling.switched, true);
	assert.equal(sibling.model, grok46);

	l.observeResponse("xai", 0, {}, cfg, now, {
		code: "subscription:free-usage-exhausted",
		error: "You've used all the included free usage for model grok-4.6 for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 10/10.",
		resetsAt: Math.floor(now / 1000) + 3600,
	});
	const nextSeries = planTurn({ ...args({ ledger: l, now }), tier: "standard", confidence: 0.8, current: grok47 });
	assert.equal(nextSeries.model, opus55);
});

test("a concrete preference list is used as written, and a model the billing gate excludes is skipped", () => {
	const preference = ["faux/b", "faux/a"];
	assert.equal(sessionModel(args({ preference }))?.key, "faux/b");
	const blocked = mergeConfig(cfg, { preference, billing: { ...cfg.billing, allowPayPerToken: ["faux/a"] } });
	const picked = sessionModel({ ...args(), cfg: blocked });
	assert.equal(picked?.key, "faux/a");
});

test("an older config with no preference list still loads, and a /model pin count is still accepted", () => {
	const dir = mkdtempSync(join(tmpdir(), "mr-old-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		writeFileSync(join(dir, "modelrouter.json"), JSON.stringify({ switching: { manualPinTurns: 9 }, tiers: { light: ["faux/a"] } }));
		const loaded = loadConfig(mkdtempSync(join(tmpdir(), "mr-old-cwd-")));
		assert.deepEqual(loaded.errors, []);
		assert.deepEqual(loaded.config.preference, ["fable", "grok", "opus", "astra"]);
		assert.equal(loaded.config.switching.manualPinTurns, 9);
		assert.deepEqual(loaded.config.tiers.light, ["faux/a"]);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});
