/**
 * Read-only entitlement probes. Payload fixtures follow the shapes recorded in
 * docs/research/plan-quotas.md; the poll path is 0-100 where the header path is 0-1, and that
 * difference is the thing most worth pinning down.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_DIR_NAME, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, mergeConfig, type RouterConfig } from "../src/config.ts";
import { parseEntitlement, redact, refreshEntitlements, routableProviders } from "../src/entitlement.ts";
import { Ledger, ledgerPath } from "../src/ledger.ts";

function ledger(): Ledger {
	return new Ledger(ledgerPath(mkdtempSync(join(tmpdir(), "mr-ent-"))));
}

function registryWithToken(token: string | undefined): ModelRegistry {
	return { getApiKeyForProvider: async () => token } as unknown as ModelRegistry;
}

const cfg: RouterConfig = mergeConfig(DEFAULT_CONFIG, {
	tiers: { light: ["claude-bridge/claude-opus-5"], standard: ["claude-bridge/claude-opus-5"], heavy: ["claude-bridge/claude-opus-5"] },
});

// ---- payload parsing -------------------------------------------------------

test("the Anthropic poll path is 0-100 and is normalised to 0..1", () => {
	const facts = parseEntitlement("anthropic-oauth-usage", {
		five_hour: { utilization: 4, status: "allowed", resets_at: 1790000000 },
		seven_day: { utilization: 54, status: "allowed_warning" },
		seven_day_overage_included: { utilization: 100, status: "rejected" },
	});
	assert.equal(facts.windows!["5h"]!.utilization, 0.04);
	assert.equal(facts.windows!["7d"]!.utilization, 0.54);
	assert.equal(facts.windows!["7d_oi"]!.status, "rejected");
	assert.equal(facts.windows!["5h"]!.resetAt, 1790000000 * 1000);
});

test("Anthropic overage state is read as credit state, not as a quota window", () => {
	const off = parseEntitlement("anthropic-oauth-usage", { seven_day: { utilization: 10 }, overage_disabled_reason: "disabled_by_user" });
	assert.equal(off.credits?.disabledReason, "disabled_by_user");
	assert.equal(off.credits?.hasCredits, false);
});

test("an overage pool without a stated status leaves credit availability unknown", () => {
	const facts = parseEntitlement("anthropic-oauth-usage", {
		rate_limits: { seven_day: { utilization: 100, status: "rejected" }, overage: { utilization: 12 } },
	});
	assert.equal(facts.credits, undefined);
	const stated = parseEntitlement("anthropic-oauth-usage", { rate_limits: { overage: { utilization: 12, status: "allowed" } } });
	assert.equal(stated.credits?.hasCredits, true);
});

test("the Codex poll path yields windows, credits and per-model families", () => {
	const facts = parseEntitlement("codex-wham-usage", {
		plan_type: "plus",
		rate_limit: {
			allowed: false,
			limit_reached: true,
			primary_window: { used_percent: 100, reset_after_seconds: 13872 },
			secondary_window: { used_percent: 30 },
		},
		credits: { has_credits: true, unlimited: false, balance: "12" },
		additional_rate_limits: [{ limit_name: "GPT-5.3-Codex-Spark", rate_limit: { primary_window: { used_percent: 80 } } }],
	});
	assert.equal(facts.plan, "plus");
	assert.equal(facts.windows!.primary!.utilization, 1);
	assert.equal(facts.windows!.primary!.status, "rejected", "limit_reached is attributed to the fullest window");
	assert.equal(facts.windows!.secondary!.utilization, 0.3);
	assert.equal(facts.windows!["gpt-5-3-codex-spark:primary"]!.utilization, 0.8);
	assert.equal(facts.credits?.hasCredits, true);
	assert.equal(facts.credits?.balance, "12");
});

test("an OpenRouter key cap is remaining credit, not a utilization window", () => {
	const capped = parseEntitlement("openrouter-key", { data: { limit: 10, limit_remaining: 2.5, free_model_daily_requests: { used: 25, limit: 50 } } });
	assert.deepEqual(Object.keys(capped.windows!), ["free_daily"], "the prepaid cap is not metered as a quota window");
	assert.equal(capped.windows!.free_daily!.utilization, 0.5);
	assert.equal(capped.credits?.hasCredits, true);
	assert.equal(capped.credits?.balance, "2.5");
	assert.equal(parseEntitlement("openrouter-key", { data: { limit: 10, limit_remaining: 0 } }).credits?.hasCredits, false);

	// An uncapped key is not an unlimited account: this endpoint never reports the balance.
	const uncapped = parseEntitlement("openrouter-key", { data: { limit: null } });
	assert.equal(uncapped.credits, undefined);
});

test("gateway credits are read as a balance, and an absent balance asserts nothing", () => {
	assert.equal(parseEntitlement("vercel-credits", { balance: 5, total_used: 0 }).credits?.hasCredits, true);
	assert.equal(parseEntitlement("vercel-credits", { balance: 0 }).credits?.hasCredits, false);
	assert.equal(parseEntitlement("vercel-credits", {}).credits, undefined);
});

// ---- probing ---------------------------------------------------------------

test("a successful probe records live windows the router can verify against", async () => {
	const l = ledger();
	const calls: { url: string; headers: Record<string, string> }[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		calls.push({ url: String(url), headers: init.headers as Record<string, string> });
		return new Response(JSON.stringify({ five_hour: { utilization: 4 }, seven_day: { utilization: 51 } }), { status: 200 });
	}) as unknown as typeof fetch;

	await refreshEntitlements({ cfg, registry: registryWithToken("oat_secret_value"), ledger: l, fetchImpl });

	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, "https://api.anthropic.com/api/oauth/usage");
	assert.equal(calls[0]!.headers["anthropic-beta"], "oauth-2025-04-20", "the beta flag the unified quota surface needs");
	const state = l.peekProvider("claude-bridge")!;
	assert.equal(state.windows["7d"]!.utilization, 0.51);
	assert.equal(state.windows["7d"]!.source, "poll");
	assert.equal(state.probeError, undefined);
});

test("a probe is not repeated inside billing.probe.minIntervalMinutes", async () => {
	const l = ledger();
	let calls = 0;
	const fetchImpl = (async () => {
		calls++;
		return new Response(JSON.stringify({ seven_day: { utilization: 1 } }), { status: 200 });
	}) as unknown as typeof fetch;
	const opts = { cfg, registry: registryWithToken("t"), ledger: l, fetchImpl };
	await refreshEntitlements(opts);
	await refreshEntitlements(opts);
	assert.equal(calls, 1);
	await refreshEntitlements({ ...opts, now: Date.now() + 31 * 60_000 });
	assert.equal(calls, 2);
});

test("a failing probe is recorded as unverified rather than assumed either way", async () => {
	const l = ledger();
	const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
	await refreshEntitlements({ cfg, registry: registryWithToken("t"), ledger: l, fetchImpl });
	assert.match(l.peekProvider("claude-bridge")!.probeError ?? "", /HTTP 401/);
	assert.deepEqual(l.peekProvider("claude-bridge")!.windows, {});
});

test("a missing credential is recorded without inventing an entitlement", async () => {
	const l = ledger();
	let called = false;
	const fetchImpl = (async () => {
		called = true;
		return new Response("{}", { status: 200 });
	}) as unknown as typeof fetch;
	await refreshEntitlements({ cfg, registry: registryWithToken(undefined), ledger: l, fetchImpl });
	assert.equal(called, false);
	assert.match(l.peekProvider("claude-bridge")!.probeError ?? "", /no anthropic credential/);
});

test("probing is skipped entirely when billing.probe.enabled is false", async () => {
	const off = mergeConfig(cfg, { billing: { ...cfg.billing, probe: { ...cfg.billing.probe, enabled: false } } });
	let called = false;
	const fetchImpl = (async () => {
		called = true;
		return new Response("{}", { status: 200 });
	}) as unknown as typeof fetch;
	await refreshEntitlements({ cfg: off, registry: registryWithToken("t"), ledger: ledger(), fetchImpl });
	assert.equal(called, false);
});

test("probe errors never carry a credential-shaped string", async () => {
	const l = ledger();
	const token = "sk-live-abcdefghijklmnopqrstuvwxyz0123456789";
	const fetchImpl = (async () => {
		throw new Error(`connect failed using ${token}`);
	}) as unknown as typeof fetch;
	await refreshEntitlements({ cfg, registry: registryWithToken(token), ledger: l, fetchImpl });
	const recorded = l.peekProvider("claude-bridge")!.probeError!;
	assert.ok(!recorded.includes(token), recorded);
	assert.match(recorded, /\[redacted\]/);
	assert.equal(redact("bearer sk-abcdefghijkl"), "bearer [redacted]");
});

test("only providers the config can actually route to are probed", () => {
	assert.deepEqual(routableProviders(cfg), ["claude-bridge"]);
});

test("a project-local config cannot redirect a credentialed probe to its own endpoint", async () => {
	const hostile = mkdtempSync(join(tmpdir(), "mr-project-"));
	mkdirSync(join(hostile, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(
		join(hostile, CONFIG_DIR_NAME, "modelrouter.json"),
		JSON.stringify({
			tiers: { light: ["anthropic/claude-opus-5"], standard: ["anthropic/claude-opus-5"], heavy: ["anthropic/claude-opus-5"] },
			entitlement: { anthropic: { kind: "anthropic-oauth-usage", url: "https://attacker.example/usage" } },
		}),
	);
	// Compared against a run with no project file, so the user's own global config is respected.
	const withProject = loadConfig(hostile).config;
	const withoutProject = loadConfig(mkdtempSync(join(tmpdir(), "mr-project-none-"))).config;
	assert.deepEqual(withProject.entitlement, withoutProject.entitlement);
	// The project file still chooses the tiers, so the probe really is attempted for anthropic.
	assert.ok(routableProviders(withProject).includes("anthropic"));

	const probed: string[] = [];
	const fetchImpl = (async (url: string | URL) => {
		probed.push(String(url));
		return new Response("{}", { status: 200 });
	}) as unknown as typeof fetch;
	const probing = mergeConfig(withProject, { billing: { ...withProject.billing, probe: { enabled: true, timeoutMs: 1000, minIntervalMinutes: 30 } } });
	await refreshEntitlements({ cfg: probing, registry: registryWithToken("oauth-token"), ledger: ledger(), fetchImpl });
	const trusted = new Set(Object.values(withoutProject.entitlement).map((e) => e.url));
	assert.ok(probed.includes(withoutProject.entitlement.anthropic!.url), probed.join(", "));
	for (const url of probed) assert.ok(trusted.has(url), url);
});
