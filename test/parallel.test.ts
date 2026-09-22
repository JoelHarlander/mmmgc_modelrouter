/**
 * The parallel commands share routing's gate: `/duo`, `/trio` and `/par` cannot reach a model
 * that automatic routing would refuse, and they are off entirely while routing is disabled.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, mergeConfig, type RouterConfig } from "../src/config.ts";
import type { JevClient } from "../src/jev.ts";
import { Ledger, ledgerPath } from "../src/ledger.ts";
import { pickParallelModels, runParallel } from "../src/parallel.ts";

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

const opus = model("claude-bridge", "claude-opus-5", { input: 15, output: 75 });
const fable = model("claude-bridge", "claude-fable-5-1", { input: 15, output: 75 });
const grok = model("xai", "grok-4.7", { input: 3, output: 15 });
const glm = model("openrouter", "z-ai/glm-5.3", { input: 0.5, output: 2 });
const ALL = [opus, fable, grok, glm];

function ledger(): Ledger {
	return new Ledger(ledgerPath(mkdtempSync(join(tmpdir(), "mr-par-"))));
}

interface Notice {
	text: string;
	level: string;
}

function fakeCtx(current: Model<Api> | undefined, notices: Notice[] = []): ExtensionCommandContext {
	const registry = {
		find: (p: string, id: string) => ALL.find((m) => m.provider === p && m.id === id),
		hasConfiguredAuth: () => true,
		isUsingOAuth: (m: Model<Api>) => m.provider !== "openrouter",
	} as unknown as ModelRegistry;
	return {
		model: current,
		modelRegistry: registry,
		ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
	} as unknown as ExtensionCommandContext;
}

const cfg: RouterConfig = mergeConfig(DEFAULT_CONFIG, {
	tiers: {
		light: ["openrouter/z-ai/glm-5.3"],
		standard: ["claude-bridge/claude-opus-5", "xai/grok-4.7"],
		heavy: ["claude-bridge/claude-fable-5-1", "claude-bridge/claude-opus-5"],
	},
	// xAI is labelled per-token here and left out of allowPayPerToken, so the spend policy - not
	// authentication - is what keeps the fan-out off it.
	models: { ...DEFAULT_CONFIG.models, "xai/*": { billing: "on-demand" } },
	billing: {
		...DEFAULT_CONFIG.billing,
		allowPayPerToken: ["openrouter/*"],
		probe: { ...DEFAULT_CONFIG.billing.probe, enabled: false },
	},
});

test("a billing-ineligible model is not fanned out to, and the reason is reported", () => {
	const { models, rejected } = pickParallelModels({ ctx: fakeCtx(opus), cfg, n: 4, ledger: ledger() });
	const keys = models.map((m) => `${m.provider}/${m.id}`);
	assert.ok(!keys.includes("xai/grok-4.7"), `xai must not be reachable: ${keys.join(", ")}`);
	assert.match(rejected.find((r) => r.key === "xai/grok-4.7")?.reason ?? "", /not in billing\.allowPayPerToken/);
});

test("a model excluded by a model-scoped quota drops out of the fan-out", () => {
	const l = ledger();
	l.observeResponse(
		"claude-bridge",
		200,
		{
			"anthropic-ratelimit-unified-5h-utilization": "0.1",
			"anthropic-ratelimit-unified-7d_oi-utilization": "1",
			"anthropic-ratelimit-unified-7d_oi-status": "rejected",
		},
		cfg,
	);
	const { models, rejected } = pickParallelModels({ ctx: fakeCtx(opus), cfg, n: 4, ledger: l });
	const keys = models.map((m) => `${m.provider}/${m.id}`);
	assert.ok(keys.includes("claude-bridge/claude-opus-5"), "the provider stays usable");
	assert.ok(!keys.includes("claude-bridge/claude-fable-5-1"), "the scoped-out model does not");
	assert.match(rejected.find((r) => r.key === "claude-bridge/claude-fable-5-1")?.reason ?? "", /model-scoped quota exhausted/);
});

test("an explicit parallel.models list is filtered by the same gate", () => {
	const pinned = mergeConfig(cfg, { parallel: { ...cfg.parallel, models: ["claude-bridge/claude-opus-5", "xai/grok-4.7"] } });
	const { models, rejected } = pickParallelModels({ ctx: fakeCtx(opus), cfg: pinned, n: 4, ledger: ledger() });
	assert.deepEqual(models.map((m) => m.provider), ["claude-bridge"]);
	assert.equal(rejected.length, 1);
});

test("the fan-out is refused while automatic routing is disabled", async () => {
	const notices: Notice[] = [];
	const entry = await runParallel({
		pi: {} as unknown as ExtensionAPI,
		ctx: fakeCtx(opus, notices),
		prompt: "hello",
		n: 2,
		cfg,
		ledger: ledger(),
		jev: {} as unknown as JevClient,
		routerEnabled: false,
	});
	assert.equal(entry, undefined);
	assert.equal(notices.length, 1);
	assert.match(notices[0]!.text, /off while the router is disabled/);
	assert.equal(notices[0]!.level, "error");
});


test("the fan-out slots go to the best-ranked routes, not the first ones listed", () => {
	// Both openrouter routes bill per token; the claude-bridge plan route is included usage.
	const wide = mergeConfig(cfg, {
		tiers: { light: ["openrouter/z-ai/glm-5.3"], standard: ["openrouter/z-ai/glm-5.3"], heavy: ["claude-bridge/claude-opus-5"] },
		billing: { ...cfg.billing, allowPayPerToken: ["openrouter/*"] },
	});
	const { models } = pickParallelModels({ ctx: fakeCtx(glm), cfg: wide, n: 1, ledger: ledger() });
	assert.deepEqual(
		models.map((m) => `${m.provider}/${m.id}`),
		["claude-bridge/claude-opus-5"],
		"a billed route does not take the slot while an included-usage route is eligible",
	);
});

test("an explicitly configured parallel.models list keeps its order and membership", () => {
	// The caller named what to compare; the rank orders slots nobody named, not this list.
	const pinned = mergeConfig(cfg, {
		models: { ...cfg.models, "xai/*": { billing: "on-demand" } },
		billing: { ...cfg.billing, allowPayPerToken: ["openrouter/*"] },
		parallel: { ...cfg.parallel, models: ["openrouter/z-ai/glm-5.3", "claude-bridge/claude-opus-5", "claude-bridge/claude-fable-5-1"] },
	});
	const { models, notes } = pickParallelModels({ ctx: fakeCtx(opus), cfg: pinned, n: 2, ledger: ledger() });
	assert.deepEqual(
		models.map((m) => `${m.provider}/${m.id}`),
		["openrouter/z-ai/glm-5.3", "claude-bridge/claude-opus-5"],
		"the billed route the caller asked to compare is not dropped for a better-ranked one",
	);
	// Honoured, but not quietly: the run says what it is spending that it need not have.
	assert.equal(notes.length, 1, notes.join(" | "));
	assert.match(notes[0]!, /openrouter\/z-ai\/glm-5.3 bills pay-per-token/);
	assert.match(notes[0]!, /claude-bridge\/claude-fable-5-1 .* was eligible and went unused/);
});

test("the fan-out discloses the unused preferred route to the user, not just to the caller", async () => {
	const pinned = mergeConfig(cfg, {
		models: { ...cfg.models, "xai/*": { billing: "on-demand" } },
		billing: { ...cfg.billing, allowPayPerToken: ["openrouter/*"] },
		parallel: { ...cfg.parallel, models: ["openrouter/z-ai/glm-5.3", "claude-bridge/claude-opus-5", "claude-bridge/claude-fable-5-1"] },
	});
	const notices: Notice[] = [];
	await runParallel({
		pi: {} as unknown as ExtensionAPI,
		ctx: fakeCtx(opus, notices),
		prompt: "hello",
		n: 2,
		cfg: pinned,
		ledger: ledger(),
		jev: {} as unknown as JevClient,
		routerEnabled: true,
	}).catch(() => undefined);
	const disclosure = notices.find((notice) => /went unused/.test(notice.text));
	assert.ok(disclosure, notices.map((notice) => notice.text).join(" | "));
	assert.equal(disclosure.level, "warning");
});

test("a fan-out with nothing better passed over says nothing", () => {
	const pinned = mergeConfig(cfg, {
		parallel: { ...cfg.parallel, models: ["claude-bridge/claude-opus-5", "claude-bridge/claude-fable-5-1"] },
	});
	const { notes } = pickParallelModels({ ctx: fakeCtx(opus), cfg: pinned, n: 2, ledger: ledger() });
	assert.deepEqual(notes, []);
});
