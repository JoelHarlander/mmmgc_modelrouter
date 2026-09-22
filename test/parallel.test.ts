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
	billing: { ...DEFAULT_CONFIG.billing, probe: { ...DEFAULT_CONFIG.billing.probe, enabled: false } },
});

test("a billing-ineligible model is not fanned out to, and the reason is reported", () => {
	const { models, rejected } = pickParallelModels({ ctx: fakeCtx(opus), cfg, n: 4, ledger: ledger() });
	const keys = models.map((m) => `${m.provider}/${m.id}`);
	assert.ok(!keys.includes("xai/grok-4.7"), `xai must not be reachable: ${keys.join(", ")}`);
	assert.match(rejected.find((r) => r.key === "xai/grok-4.7")?.reason ?? "", /paid fallback denied/);
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

test("parallel.requireRoutingEnabled false keeps the old behaviour available", async () => {
	const optOut = mergeConfig(cfg, { parallel: { ...cfg.parallel, requireRoutingEnabled: false } });
	const notices: Notice[] = [];
	// Only one model is eligible here, so the run stops at the eligibility check rather than the
	// routing-disabled check: that is what proves the disabled gate was not the thing that fired.
	const pinned = mergeConfig(optOut, { parallel: { ...optOut.parallel, models: ["claude-bridge/claude-opus-5", "xai/grok-4.7"] } });
	const entry = await runParallel({
		pi: {} as unknown as ExtensionAPI,
		ctx: fakeCtx(opus, notices),
		prompt: "hello",
		n: 2,
		cfg: pinned,
		ledger: ledger(),
		jev: {} as unknown as JevClient,
		routerEnabled: false,
	});
	assert.equal(entry, undefined);
	assert.match(notices[0]!.text, /Need at least 2 billing-eligible models/);
	assert.match(notices[0]!.text, /paid fallback denied/);
});
