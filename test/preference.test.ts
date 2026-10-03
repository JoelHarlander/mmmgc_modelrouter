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
import { planTurn, resolveBackup, resolveEntry, sessionModel, versionCompare } from "../src/preference.ts";

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
const sonnet5 = model("claude-bridge", "claude-sonnet-5");
const sonnet55 = model("claude-bridge", "claude-sonnet-5-5");
const sol = model("openai-codex", "gpt-6-sol");
const sol61 = model("openai-codex", "gpt-6.1-sol");
const solPro = model("openrouter", "openai/gpt-6.1-sol-pro");
const solBatch = model("openrouter", "openai/gpt-6.1-sol:batch");
const solar = model("openrouter", "upstage/solar-pro-3");
const luna = model("openai-codex", "gpt-6-luna");
const glm52 = model("openrouter", "z-ai/glm-5.2", { input: 0.5, output: 1.8 });
const glm53 = model("openrouter", "z-ai/glm-5.3", { input: 0.6, output: 2 });
const glm53flash = model("openrouter", "z-ai/glm-5.3-flash", { input: 0.1, output: 0.4 });
const glm54batch = model("openrouter", "z-ai/glm-5.4:batch", { input: 0.3, output: 1 });
const CATALOG = [fable5, fable51, fableApi, grok46, grok47, opus5, opus55, sonnet5, sonnet55, astra, sol, sol61, solPro, solBatch, solar, luna, glm52, glm53, glm53flash, glm54batch, fauxA, fauxB];

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

test("a dated snapshot never outranks a real minor version in the same series", () => {
	assert.ok(versionCompare("claude-opus-4-1", "claude-opus-4-20250514") > 0);
	assert.ok(versionCompare("grok-4.7", "grok-4-0709") > 0);
	assert.ok(versionCompare("claude-opus-5-5", "claude-opus-5-20260101") > 0);
	const dated = model("claude-bridge", "claude-opus-5-20260101");
	assert.equal(resolveEntry("opus", args({ models: [dated, opus55] }))?.key, "claude-bridge/claude-opus-5-5");
});

test("a rate-limit or gateway-budget refusal does not switch the model", () => {
	const l = ledger();
	const now = Date.now();
	l.observeResponse("claude-bridge", 0, {}, cfg, now, JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_exceeded" } }));
	l.observeResponse(
		"claude-bridge",
		0,
		{},
		cfg,
		now,
		JSON.stringify({ error: { message: "Key limit exceeded", type: "quota_for_entity_exceeded", metadata: { limit_source: "openrouter_key_limit" } } }),
	);
	const stayed = planTurn({ ...args({ ledger: l, now }), tier: "standard", confidence: 0.9, current: fable51 });
	assert.equal(stayed.switched, false);
	assert.equal(stayed.model, fable51);
});

/** Drives the extension's own session_start handler against a fake pi that records setModel. */
async function startSession(reason: "startup" | "new" | "resume", current: Model<Api>) {
	const dir = mkdtempSync(join(tmpdir(), "mr-start-"));
	writeFileSync(join(dir, "modelrouter.json"), JSON.stringify({ billing: { probe: { enabled: false } } }));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const { default: modelRouter } = await import("../src/index.ts");
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
		const set: Model<Api>[] = [];
		const pi = new Proxy(
			{
				on: (name: string, h: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, h),
				setModel: async (m: Model<Api>) => (set.push(m), true),
			},
			{ get: (target, key) => (target as Record<string | symbol, unknown>)[key] ?? (() => {}) },
		);
		modelRouter(pi as never);
		const reg = registry();
		await handlers.get("session_start")!(
			{ type: "session_start", reason },
			{
				cwd: mkdtempSync(join(tmpdir(), "mr-start-cwd-")),
				hasUI: false,
				model: current,
				scopedModels: [],
				modelRegistry: { ...reg, getApiKeyForProvider: async () => undefined },
			},
		);
		return set.map((m) => `${m.provider}/${m.id}`);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
}

test("a new session opens on the highest preference even when pi started on another model; a resume keeps it", async () => {
	// Pi does not tell an extension whether the model came from --model or from its saved default,
	// so the preference list wins on startup and new; resuming keeps the session's own model.
	assert.deepEqual(await startSession("startup", grok47), ["claude-bridge/claude-fable-5-1"]);
	assert.deepEqual(await startSession("new", grok47), ["claude-bridge/claude-fable-5-1"]);
	assert.deepEqual(await startSession("resume", grok47), []);
	assert.deepEqual(await startSession("startup", fable51), []);
});

// ---- usage gates and the pay-per-token backup --------------------------------------------

const GATED = mergeConfig(cfg, {
	preference: ["opus", "sonnet"],
	gates: [{ series: "opus", at: 0.5, then: "sonnet" }],
	billing: { ...cfg.billing, allowPayPerToken: ["openrouter/*"] },
});

function gatedArgs(extra: { ledger?: Ledger; now?: number; cfg?: RouterConfig; unauthed?: string[] } = {}) {
	return { cfg: extra.cfg ?? GATED, registry: registry(extra.unauthed), ledger: extra.ledger ?? ledger(), models: CATALOG, now: extra.now };
}

/** Opus's own weekly bucket at `used` (0..1), reset an hour out. */
function opusUsed(l: Ledger, used: number, now: number) {
	l.observeResponse(
		"claude-bridge",
		200,
		{ "anthropic-ratelimit-unified-7d_opus-utilization": String(used), "anthropic-ratelimit-unified-7d_opus-reset": String(Math.floor(now / 1000) + 3600) },
		cfg,
		now,
		undefined,
		"claude-opus-5-5",
	);
}

test("a gate keeps the model below its threshold and moves to the next series at it", () => {
	const l = ledger();
	const now = Date.now();
	opusUsed(l, 0.49, now);
	assert.equal(sessionModel(gatedArgs({ ledger: l, now }))?.key, "claude-bridge/claude-opus-5-5");
	assert.equal(planTurn({ ...gatedArgs({ ledger: l, now }), tier: "heavy", confidence: 0.9, current: opus55 }).switched, false);

	opusUsed(l, 0.5, now);
	assert.equal(sessionModel(gatedArgs({ ledger: l, now }))?.key, "claude-bridge/claude-sonnet-5-5", "sonnet resolves to the latest");
	const moved = planTurn({ ...gatedArgs({ ledger: l, now }), tier: "heavy", confidence: 0.9, current: opus55 });
	assert.equal(moved.switched, true);
	assert.equal(moved.model, sonnet55);
	assert.match(moved.reason, /opus gate: 50% used >= 50%; claude-bridge\/claude-opus-5-5 -> claude-bridge\/claude-sonnet-5-5/);
});

test("a gate window that has reset says nothing", () => {
	const l = ledger();
	const now = Date.now();
	opusUsed(l, 0.9, now);
	assert.equal(sessionModel(gatedArgs({ ledger: l, now: now + 2 * 3600_000 }))?.key, "claude-bridge/claude-opus-5-5");
});

test("a gate is soft: when nothing past it is usable, the gated subscription still beats paying", () => {
	const l = ledger();
	const now = Date.now();
	opusUsed(l, 0.8, now);
	const noSonnet = mergeConfig(GATED, { gates: [{ series: "opus", at: 0.5 }], preference: ["opus"], backup: "openrouter/z-ai/glm-*" });
	assert.equal(sessionModel(gatedArgs({ ledger: l, now, cfg: noSonnet }))?.key, "claude-bridge/claude-opus-5-5");
	const stay = planTurn({ ...gatedArgs({ ledger: l, now, cfg: noSonnet }), tier: "standard", confidence: 0.9, current: opus55 });
	assert.equal(stay.switched, false, "no alternative, so the gated model is kept rather than paying");
});

test("when everything is past its gate, the least-used entry is taken, not merely the first", () => {
	const l = ledger();
	const now = Date.now();
	opusUsed(l, 0.8, now);
	l.observeResponse(
		"claude-bridge",
		200,
		{ "anthropic-ratelimit-unified-7d_sonnet-utilization": "0.6", "anthropic-ratelimit-unified-7d_sonnet-reset": String(Math.floor(now / 1000) + 3600) },
		cfg,
		now,
		undefined,
		"claude-sonnet-5-5",
	);
	const both = mergeConfig(GATED, { preference: ["opus", "sonnet"], gates: [{ series: "opus", at: 0.5 }, { series: "sonnet", at: 0.5 }] });
	const session = sessionModel(gatedArgs({ ledger: l, now, cfg: both }));
	assert.equal(session?.key, "claude-bridge/claude-sonnet-5-5", "sonnet is at 60%, opus at 80%");
	assert.match(session!.reason, /least-used/);
	const turn = planTurn({ ...gatedArgs({ ledger: l, now, cfg: both }), tier: "heavy", confidence: 0.9, current: opus55 });
	assert.equal(turn.model, sonnet55, "a gated current model moves to the least-used alternative");
	assert.match(turn.reason, /sonnet.* has used less \(60%\)/);

	// Strict improvement only: on sonnet (60%) with opus at 80%, nothing is better, so it stays rather than trading back.
	const stay = planTurn({ ...gatedArgs({ ledger: l, now, cfg: both }), tier: "heavy", confidence: 0.9, current: sonnet55 });
	assert.equal(stay.switched, false);
});

test("astra gates to another series the same way, and a gate may name one concrete model", () => {
	const l = ledger();
	const now = Date.now();
	l.observeResponse("openai-codex", 200, { "x-codex-primary-used-percent": "60", "x-codex-primary-reset-after-seconds": "3600" }, cfg, now, undefined, "gpt-6-astra");
	const astraGate = mergeConfig(GATED, { preference: ["astra"], gates: [{ series: "astra", at: 0.5, then: "sol" }] });
	assert.equal(sessionModel(gatedArgs({ ledger: l, now, cfg: astraGate }))?.key, "openai-codex/gpt-6.1-sol", "sol resolves to the newest sol on the Codex subscription");

	const pinned = mergeConfig(GATED, { preference: ["astra"], gates: [{ series: "astra", at: 0.5, then: "openai-codex/gpt-6-sol" }] });
	assert.equal(sessionModel(gatedArgs({ ledger: l, now, cfg: pinned }))?.key, "openai-codex/gpt-6-sol");
});

test("series names match whole tokens and prefer plain ids: sol is not solar, and :batch is not a newer model", () => {
	const a = gatedArgs();
	assert.equal(resolveEntry("sol", a)?.key, "openai-codex/gpt-6.1-sol");
	const noCodex = { ...a, models: CATALOG.filter((m) => m.provider !== "openai-codex") };
	assert.equal(resolveEntry("sol", noCodex)?.key, "openrouter/openai/gpt-6.1-sol-pro", "no Codex: the plain ids that match, never solar");
	assert.ok(!["openrouter/upstage/solar-pro-3"].includes(resolveEntry("sol", noCodex)!.key));
	const onlyVariant = { ...a, models: [solBatch, solar, fauxA] };
	assert.equal(resolveEntry("sol", onlyVariant)?.key, "openrouter/openai/gpt-6.1-sol:batch", "a variant is used when it is all there is");
	// Any other name is a token match, so a series the code has never heard of still works.
	assert.equal(resolveEntry("luna", a)?.key, "openai-codex/gpt-6-luna");
	assert.equal(resolveEntry("glm", a)?.key, "openrouter/z-ai/glm-5.3");
	assert.equal(resolveEntry("ol", a), undefined, "a fragment of a token is not a series");
});

test("a concrete preference entry has no series to upgrade within: it is exactly that model", () => {
	const only = mergeConfig(GATED, { preference: ["claude-bridge/claude-opus-5"], gates: [] });
	assert.equal(sessionModel(gatedArgs({ cfg: only }))?.key, "claude-bridge/claude-opus-5", "opus-5-5 exists but is not chosen");
});

test("gates loop-protect and malformed gates are dropped", () => {
	const loop = mergeConfig(GATED, {
		preference: ["opus", "sonnet"],
		gates: [
			{ series: "opus", at: 0.1, then: "sonnet" },
			{ series: "sonnet", at: 0.1, then: "opus" },
		],
	});
	const l = ledger();
	const now = Date.now();
	opusUsed(l, 0.9, now);
	assert.ok(sessionModel(gatedArgs({ ledger: l, now, cfg: loop })), "a cycle still lands on something usable");

	const dropped = mergeConfig(DEFAULT_CONFIG, { gates: [{ series: "", at: 0.5 }, { series: "opus", at: 0 }, { series: "opus", at: 2 }, { series: "opus", at: 0.5, then: "sonnet" }, 7] as never });
	assert.deepEqual(dropped.gates, [{ series: "opus", at: 0.5, then: "sonnet" }]);
	const projectTry = mergeConfig(DEFAULT_CONFIG, { gates: [{ series: "opus", at: 0.5 }], backup: "openrouter/x" } as never, "project");
	assert.deepEqual([projectTry.gates, projectTry.backup], [[], ""], "a repository cannot set gates or the backup");
});

test("the backup is the newest matching pay-per-token model, used only when no preference entry is", () => {
	const backupCfg = mergeConfig(GATED, { preference: ["opus"], gates: [], backup: "openrouter/z-ai/glm-*" });
	assert.equal(sessionModel(gatedArgs({ cfg: backupCfg }))?.key, "claude-bridge/claude-opus-5-5", "subscriptions first");
	assert.equal(resolveBackup(gatedArgs({ cfg: backupCfg }))?.key, "openrouter/z-ai/glm-5.3", "newest version, plain id over -flash; the newer :batch route is not a model");
	const asked = mergeConfig(backupCfg, { backup: "openrouter/z-ai/glm-*:batch" });
	assert.equal(resolveBackup(gatedArgs({ cfg: asked }))?.key, "openrouter/z-ai/glm-5.4:batch", "unless the glob asks for it");

	const l = ledger();
	const now = Date.now();
	l.observeResponse("claude-bridge", 0, {}, backupCfg, now, { rateLimitType: "seven_day_opus", resetsAt: Math.floor(now / 1000) + 3600 });
	const session = sessionModel(gatedArgs({ ledger: l, now, cfg: backupCfg }));
	assert.equal(session?.key, "openrouter/z-ai/glm-5.3");
	assert.match(session!.reason, /backup/);
	const spent = planTurn({ ...gatedArgs({ ledger: l, now, cfg: backupCfg }), tier: "standard", confidence: 0.9, current: opus55 });
	assert.equal(spent.model?.id, "z-ai/glm-5.3");
	assert.match(spent.reason, /\(backup\)/);

	// The subscription reopens: the session leaves the pay-per-token model on the next turn.
	const back = planTurn({ ...gatedArgs({ cfg: backupCfg }), tier: "standard", confidence: 0.9, current: glm53 });
	assert.equal(back.switched, true);
	assert.equal(back.model, opus55);
	assert.match(back.reason, /backup openrouter\/z-ai\/glm-5\.3 is only for when nothing else is usable/);
});

test("the backup follows the config: any provider, a concrete model, or none", () => {
	const l = ledger();
	const now = Date.now();
	l.observeResponse("claude-bridge", 0, {}, cfg, now, { rateLimitType: "seven_day_opus", resetsAt: Math.floor(now / 1000) + 3600 });
	const base = { preference: ["opus"], gates: [] };
	assert.equal(sessionModel(gatedArgs({ ledger: l, now, cfg: mergeConfig(GATED, { ...base, backup: "openrouter/z-ai/glm-5.2" }) }))?.key, "openrouter/z-ai/glm-5.2");
	assert.equal(sessionModel(gatedArgs({ ledger: l, now, cfg: mergeConfig(GATED, { ...base, backup: "" }) })), undefined);
	// A backup the billing gate excludes is never used.
	const blocked = mergeConfig(GATED, { ...base, backup: "openrouter/z-ai/glm-*", billing: { ...GATED.billing, allowPayPerToken: [] } });
	assert.equal(sessionModel(gatedArgs({ ledger: l, now, cfg: blocked })), undefined);
});
