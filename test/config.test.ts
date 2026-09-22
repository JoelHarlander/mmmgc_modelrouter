/**
 * The project-local configuration layer. `<cwd>/.pi/modelrouter.json` arrives with whatever
 * repository is open, so it may set routing policy but not a section that names an endpoint or a
 * credential: the merge is an allowlist, and every section outside it keeps the global value.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { assessBilling } from "../src/billing.ts";
import { DEFAULT_CONFIG, loadConfig, mergeConfig, PROJECT_OVERRIDABLE, type RouterConfig } from "../src/config.ts";
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

/** The same shape with every string replaced, so a section the project layer won is visible. */
function hostile(value: unknown): unknown {
	if (typeof value === "string") return "https://attacker.example";
	if (Array.isArray(value)) return value.map(hostile);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hostile(v)]));
	return value;
}

const sections = Object.keys(DEFAULT_CONFIG) as (keyof RouterConfig)[];

test("a project config may set the allowlisted sections and no others", () => {
	const base = baseline();
	const patch: Record<string, unknown> = { tiers: { light: ["faux/a"], standard: ["faux/a"], heavy: ["faux/a"] } };
	for (const section of sections) {
		if (!PROJECT_OVERRIDABLE.includes(section)) patch[section] = hostile(base[section]);
	}
	const cfg = loadConfig(projectDir(patch)).config;

	assert.deepEqual(cfg.tiers.light, ["faux/a"], "an allowlisted section still applies");
	for (const section of sections) {
		if (PROJECT_OVERRIDABLE.includes(section)) continue;
		assert.deepEqual(cfg[section], base[section], `${section} must not be settable from a project config`);
	}
});

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

// ---- safeguards may only move towards spending less ------------------------

/** The shipped defaults are the global layer here, so the policy under test is the shipped one. */
function withProject(patch: unknown): RouterConfig {
	return mergeConfig(DEFAULT_CONFIG, patch as Partial<RouterConfig>, "project");
}

test("a project config cannot empty, replace or widen the paid-inference deny list", () => {
	const cfg = withProject({ billing: { denyPaid: [], allowPayPerToken: ["*"], allowExtraBilled: ["*"] } });
	for (const glob of DEFAULT_CONFIG.billing.denyPaid) assert.ok(cfg.billing.denyPaid.includes(glob), glob);
	assert.deepEqual(cfg.billing.allowPayPerToken, [], "a broader allow list narrows to nothing rather than widening");
	assert.deepEqual(cfg.billing.allowExtraBilled, []);
});

test("a project config may tighten the same safeguards", () => {
	const cfg = withProject({
		billing: {
			denyPaid: ["openrouter/*"],
			allowPayPerToken: ["openrouter/z-ai/glm-5.3"],
			allowUnverifiedSubscription: false,
			evidenceMaxAgeMinutes: 5,
		},
		plan: { utilizationCeiling: 0.5, cooldownMinutesOn429: 120 },
	});
	assert.deepEqual(cfg.billing.denyPaid, [...DEFAULT_CONFIG.billing.denyPaid, "openrouter/*"]);
	assert.deepEqual(cfg.billing.allowPayPerToken, ["openrouter/z-ai/glm-5.3"]);
	assert.equal(cfg.billing.allowUnverifiedSubscription, false);
	assert.equal(cfg.billing.evidenceMaxAgeMinutes, 5);
	assert.equal(cfg.plan.utilizationCeiling, 0.5);
	assert.equal(cfg.plan.cooldownMinutesOn429, 120);
});

test("a project config cannot relax the safeguards it is allowed to tighten", () => {
	const strict = mergeConfig(DEFAULT_CONFIG, {
		billing: { ...DEFAULT_CONFIG.billing, allowUnverifiedSubscription: false, evidenceMaxAgeMinutes: 5 },
		plan: { utilizationCeiling: 0.5, cooldownMinutesOn429: 120 },
	});
	const cfg = mergeConfig(
		strict,
		{
			billing: { allowUnverifiedSubscription: true, requireVerifiedExtraBilled: false, preferVerifiedSubscription: false, evidenceMaxAgeMinutes: 600 },
			plan: { utilizationCeiling: 1, cooldownMinutesOn429: 0 },
			parallel: { requireRoutingEnabled: false },
		} as Partial<RouterConfig>,
		"project",
	);
	assert.equal(cfg.billing.allowUnverifiedSubscription, false);
	assert.equal(cfg.billing.requireVerifiedExtraBilled, true);
	assert.equal(cfg.billing.preferVerifiedSubscription, true);
	assert.equal(cfg.billing.evidenceMaxAgeMinutes, 5);
	assert.equal(cfg.plan.utilizationCeiling, 0.5);
	assert.equal(cfg.plan.cooldownMinutesOn429, 120);
	assert.equal(cfg.parallel.requireRoutingEnabled, true);
});

test("a safeguard key that declares no safe direction is global-only", () => {
	const cfg = withProject({ billing: { probe: { enabled: false, minIntervalMinutes: 1440, timeoutMs: 60_000 } } });
	assert.equal(cfg.billing.probe.enabled, false, "switching probing off is a project's to make");
	assert.equal(cfg.billing.probe.minIntervalMinutes, DEFAULT_CONFIG.billing.probe.minIntervalMinutes);
	assert.equal(cfg.billing.probe.timeoutMs, DEFAULT_CONFIG.billing.probe.timeoutMs);
});

test("a project config cannot route paid Anthropic inference by any of its allowed sections", () => {
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
	assert.equal(cfg.models["anthropic/*"]?.billing, DEFAULT_CONFIG.models["anthropic/*"]?.billing, "a project may not assert what pays for a model");
	assert.equal(cfg.models["anthropic/*"]?.capability, 99, "but it may still rank models");
});
