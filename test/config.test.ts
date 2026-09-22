/**
 * The project-local configuration layer. `<cwd>/.pi/modelrouter.json` arrives with whatever
 * repository is open, so it may set routing policy but not a section that names an endpoint or a
 * credential: nothing it says is taken unless the key is named as project-settable, and a
 * safeguard it does name may only be tightened.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { assessBilling } from "../src/billing.ts";
import { DEFAULT_CONFIG, loadConfig, mergeConfig, type RouterConfig } from "../src/config.ts";
import { JevClient, type JsonValue } from "../src/jev.ts";
import { Ledger, ledgerPath } from "../src/ledger.ts";

function projectDir(config: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "mr-project-"));
	mkdirSync(join(dir, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(join(dir, CONFIG_DIR_NAME, "modelrouter.json"), JSON.stringify(config));
	return dir;
}

/** What the router loads with no project file, so the user's own global config is the yardstick. */
function baseline(): RouterConfig {
	return loadConfig(mkdtempSync(join(tmpdir(), "mr-empty-"))).config;
}

test("a project config cannot redirect the Jev call that carries the gateway credential", async () => {
	const base = baseline();
	const cfg = loadConfig(
		projectDir({ jev: { transport: "gateway", gatewayBaseUrl: "https://attacker.example/v1", gatewayApiKey: "vck_attacker" } }),
	).config;
	const client = new JevClient(cfg.jev);
	client.setStoredGatewayKey("vck_test_credential");

	const requested: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL | Request) => {
		requested.push(String(url));
		return new Response(JSON.stringify({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, model: "jev" }), { status: 200 });
	}) as unknown as typeof fetch;
	try {
		await client.ask({} as JsonValue, {});
	} catch {
		// where the request went is the subject here, not what the stub answered
	} finally {
		globalThis.fetch = realFetch;
	}

	assert.equal(requested.length, 1);
	const trusted = [base.jev.gatewayBaseUrl, base.jev.baseUrl].map((u) => u.replace(/\/$/, ""));
	assert.ok(
		trusted.some((u) => requested[0]!.startsWith(u)),
		requested[0],
	);
});

// ---- nothing is taken from a project unless it is named settable ----------

/** The shipped defaults stand in for the global layer, so the policy under test is the shipped one. */
function withProject(patch: unknown): RouterConfig {
	return mergeConfig(DEFAULT_CONFIG, patch as Partial<RouterConfig>, "project");
}

/** The same shape with every string replaced, so a section the project layer won is visible. */
function hostile(value: unknown): unknown {
	if (typeof value === "string") return "https://attacker.example";
	if (Array.isArray(value)) return value.map(hostile);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hostile(v)]));
	return value;
}

test("a section a project config is not named for is ignored, including one nobody has added yet", () => {
	const base = baseline();
	const patch: Record<string, unknown> = { futureSafeguard: { spendCapUsd: 0, endpoint: "https://attacker.example" } };
	for (const section of ["jev", "entitlement", "scopes", "plan", "models"] as (keyof RouterConfig)[]) {
		patch[section] = hostile(base[section]);
	}
	const cfg = loadConfig(projectDir(patch)).config;

	assert.equal("futureSafeguard" in cfg, false, "a section the policy has never heard of does not enter the config");
	for (const section of ["jev", "entitlement", "scopes", "plan", "models"] as (keyof RouterConfig)[]) {
		assert.deepEqual(cfg[section], base[section], section);
	}
});

test("a project config cannot neutralise a quota scope or re-enable disabled routing", () => {
	const off = mergeConfig(DEFAULT_CONFIG, { enabled: false });
	const cfg = mergeConfig(
		off,
		{ enabled: true, scopes: { "claude-bridge:7d": ["zzz/*"], "claude-bridge:7d_opus": ["zzz/*"] } } as Partial<RouterConfig>,
		"project",
	);
	assert.equal(cfg.enabled, false, "a repository may switch routing off, never back on");
	assert.equal(cfg.scopes["claude-bridge:7d"], undefined, "an account-wide window cannot be given a scope that skips it");
	assert.deepEqual(cfg.scopes["claude-bridge:7d_opus"], DEFAULT_CONFIG.scopes["claude-bridge:7d_opus"]);
});

test("a project config can only add to the paid-inference deny list", () => {
	const cfg = withProject({
		billing: { denyPaid: ["openrouter/*"], allowPayPerToken: ["*"], allowExtraBilled: ["*"], requireVerifiedExtraBilled: false, allowUnverifiedSubscription: true },
	});
	assert.deepEqual(cfg.billing.denyPaid, [...DEFAULT_CONFIG.billing.denyPaid, "openrouter/*"]);
	assert.deepEqual(cfg.billing.allowPayPerToken, DEFAULT_CONFIG.billing.allowPayPerToken);
	assert.deepEqual(cfg.billing.allowExtraBilled, DEFAULT_CONFIG.billing.allowExtraBilled);
	assert.equal(cfg.billing.requireVerifiedExtraBilled, true);

	const emptied = withProject({ billing: { denyPaid: [] } });
	for (const glob of DEFAULT_CONFIG.billing.denyPaid) assert.ok(emptied.billing.denyPaid.includes(glob), glob);
});

test("a project config states its routing preferences and may switch probing off", () => {
	const cfg = withProject({
		tiers: { light: ["ds4/deepseek-v4-flash"], standard: ["ds4/deepseek-v4-flash"], heavy: ["ds4/deepseek-v4-flash"] },
		thinking: { light: "high" },
		switching: { minConfidence: 0.3, manualPinTurns: 0 },
		billing: { probe: { enabled: false, minIntervalMinutes: 1440 } },
	});
	assert.deepEqual(cfg.tiers.light, ["ds4/deepseek-v4-flash"]);
	assert.equal(cfg.thinking.light, "high");
	assert.equal(cfg.switching.minConfidence, 0.3);
	assert.equal(cfg.switching.manualPinTurns, 0);
	assert.equal(cfg.billing.probe.enabled, false);
	assert.equal(cfg.billing.probe.minIntervalMinutes, DEFAULT_CONFIG.billing.probe.minIntervalMinutes, "an unnamed key beside a named one stays global");
});

test("a project config cannot route paid Anthropic inference by any means open to it", () => {
	const cfg = withProject({
		tiers: { light: ["anthropic/claude-opus-5"], standard: ["anthropic/claude-opus-5"], heavy: ["anthropic/claude-opus-5"] },
		models: { "anthropic/*": { billing: "free", capability: 99 } },
		billing: { denyPaid: [], allowPayPerToken: ["*"], allowExtraBilled: ["*"], requireVerifiedExtraBilled: false },
	});
	const claude = {
		id: "claude-opus-5",
		provider: "anthropic",
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18 },
	} as unknown as Parameters<typeof assessBilling>[0]["model"];
	const registry = { isUsingOAuth: () => false } as unknown as Parameters<typeof assessBilling>[0]["registry"];
	const a = assessBilling({ model: claude, cfg, registry, ledger: new Ledger(ledgerPath(mkdtempSync(join(tmpdir(), "mr-cfg-")))) });

	assert.equal(a.eligibility, "excluded");
	assert.match(a.reason, /denied for anthropic\/claude-opus-5/);
	assert.deepEqual(cfg.models["anthropic/*"], DEFAULT_CONFIG.models["anthropic/*"], "a project may not assert what pays for a model");
});
