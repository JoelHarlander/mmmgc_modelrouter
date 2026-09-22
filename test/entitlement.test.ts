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

/** A machine where each provider id resolves to a credential of its own. */
function registryWithTokens(tokens: Record<string, string>): ModelRegistry {
	return { getApiKeyForProvider: async (p: string) => tokens[p] } as unknown as ModelRegistry;
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
	// The family window is keyed by the model the meter names, so a scope match needs no config.
	assert.equal(facts.windows!["gpt-5.3-codex-spark:primary"]!.utilization, 0.8);
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
	const state = l.peekProvider("anthropic")!; // the credential `claude-bridge` routes on
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
	assert.match(l.peekProvider("anthropic")!.probeError ?? "", /HTTP 401/);
	assert.deepEqual(l.peekProvider("anthropic")!.windows, {});
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
	// Nothing resolved, so nothing is shared either: the routed id probes for itself and says so.
	assert.match(l.peekProvider("claude-bridge")!.probeError ?? "", /no claude-bridge credential/);
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
	const recorded = l.peekProvider("anthropic")!.probeError!;
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

test("a poll that states nothing about a window leaves what the headers recorded alone", () => {
	// docs/research/plan-quotas.md: /wham/usage can answer with the window present but its fields
	// null. That is no news about the window, not proof that the plan has room again.
	const l = ledger();
	l.observeResponse("openai-codex", 200, { "x-codex-primary-used-percent": "100", "x-codex-plan-type": "plus" }, cfg);
	l.applyEntitlement(
		"openai-codex",
		parseEntitlement("codex-wham-usage", { rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: null, reset_at: null } } }),
	);
	assert.equal(l.peekProvider("openai-codex")!.windows.primary!.utilization, 1, "the exhausted window survives the empty poll");
	assert.equal(l.assess("openai-codex", "openai-codex/gpt-6-astra", cfg).exhaustedAccount.length, 1);
});

test("a stated limit_reached is recorded even when no window carries a utilization", () => {
	const facts = parseEntitlement("codex-wham-usage", { rate_limit: { limit_reached: true, primary_window: { reset_after_seconds: 600 } } });
	assert.equal(facts.windows!.primary!.status, "rejected");
});

test("provider ids that share one credential are probed once, not once each", async () => {
	// `claude-bridge` declares `authProvider: "anthropic"` and pi hands out the same credential
	// for both: one account, one authenticated GET.
	const both = mergeConfig(DEFAULT_CONFIG, {
		tiers: {
			light: ["claude-bridge/claude-opus-5"],
			standard: ["anthropic/claude-opus-5"],
			heavy: ["claude-bridge/claude-opus-5", "anthropic/claude-opus-5"],
		},
	});
	const requested: string[] = [];
	const fetchImpl = (async (url: string | URL) => {
		requested.push(String(url));
		return new Response(JSON.stringify({ rate_limits: { five_hour: { utilization: 10 } } }), { status: 200 });
	}) as unknown as typeof fetch;

	const l = ledger();
	await refreshEntitlements({ cfg: both, registry: registryWithToken("oauth"), ledger: l, fetchImpl });
	assert.equal(requested.length, 1, requested.join(", "));
	assert.equal(l.peekProvider("anthropic")?.windows["5h"]?.utilization, 0.1, "recorded against the credential");
	assert.equal(l.peekProvider("claude-bridge"), undefined, "not duplicated under the routed id");

	await refreshEntitlements({ cfg: both, registry: registryWithToken("oauth"), ledger: l, fetchImpl });
	assert.equal(requested.length, 1, "and the interval is per credential too");
});

test("provider ids pi resolves to different credentials are two accounts, not one", async () => {
	// The config declares the bridge routes on `anthropic`'s credential, but pi hands out a
	// different one for each id. Believing the declaration would let a subscription exclude a route
	// billed on a credential it never pays for, so each keeps its own probe and its own windows.
	const both = mergeConfig(DEFAULT_CONFIG, {
		tiers: {
			light: ["claude-bridge/claude-opus-5"],
			standard: ["anthropic/claude-opus-5"],
			heavy: ["claude-bridge/claude-opus-5", "anthropic/claude-opus-5"],
		},
	});
	const requested: string[] = [];
	const fetchImpl = (async (url: string | URL) => {
		requested.push(String(url));
		return new Response(JSON.stringify({ rate_limits: { five_hour: { utilization: 10 } } }), { status: 200 });
	}) as unknown as typeof fetch;

	const l = ledger();
	await refreshEntitlements({ cfg: both, registry: registryWithTokens({ anthropic: "key-a", "claude-bridge": "oauth-b" }), ledger: l, fetchImpl });

	assert.equal(requested.length, 2, "one probe each");
	assert.equal(l.accountOf("claude-bridge"), "claude-bridge", "the declaration alone shares nothing");
	assert.equal(l.peekProvider("claude-bridge")?.windows["5h"]?.utilization, 0.1);
	assert.equal(l.peekProvider("anthropic")?.windows["5h"]?.utilization, 0.1);

	// An identity pi cannot resolve at all is never assumed either.
	const unresolved = ledger();
	await refreshEntitlements({ cfg: both, registry: registryWithTokens({ anthropic: "key-a" }), ledger: unresolved, fetchImpl });
	assert.equal(unresolved.accountOf("claude-bridge"), "claude-bridge");
	assert.match(unresolved.peekProvider("claude-bridge")?.probeError ?? "", /no claude-bridge credential/);
});

/** Tiers naming both ids, so the declared pair is the one under test. */
const sharedTiers = {
	light: ["claude-bridge/claude-opus-5"],
	standard: ["anthropic/claude-opus-5"],
	heavy: ["claude-bridge/claude-opus-5", "anthropic/claude-opus-5"],
};

function usageResponse(): typeof fetch {
	return (async () => new Response(JSON.stringify({ rate_limits: { five_hour: { utilization: 10 } } }), { status: 200 })) as unknown as typeof fetch;
}

test("credential identity is resolved on the probe's own interval, and never with probing off", async () => {
	// Resolving a credential can cost pi an OAuth refresh on the turn's critical path, so it is not
	// per-turn work - and a project that tightened probing off has asked for no credential work.
	const both = mergeConfig(DEFAULT_CONFIG, { tiers: sharedTiers });
	let lookups = 0;
	const registry = {
		getApiKeyForProvider: async () => {
			lookups++;
			return "oauth";
		},
	} as unknown as ModelRegistry;
	const fetchImpl = usageResponse();
	const now = Date.now();

	const l = ledger();
	await refreshEntitlements({ cfg: both, registry, ledger: l, fetchImpl, now });
	const first = lookups;
	assert.ok(first > 0, "resolved once to begin with");

	await refreshEntitlements({ cfg: both, registry, ledger: l, fetchImpl, now: now + 60_000 });
	assert.equal(lookups, first, "the next turn asks the credential store nothing");

	await refreshEntitlements({ cfg: both, registry, ledger: l, fetchImpl, now: now + 31 * 60_000 });
	assert.ok(lookups > first, "and it is resolved again when the probe is due");

	const off = mergeConfig(both, { billing: { ...both.billing, probe: { ...both.billing.probe, enabled: false } } });
	const before = lookups;
	await refreshEntitlements({ cfg: off, registry, ledger: ledger(), fetchImpl, now });
	assert.equal(lookups, before, "probing off means no credential resolution either");
});

test("a lookup that resolves nothing leaves a proven link standing", async () => {
	// Splitting a proven account on a transient failure strands every window already filed under
	// it: the quota comes back as two halves that never meet again.
	const both = mergeConfig(DEFAULT_CONFIG, { tiers: sharedTiers });
	const fetchImpl = usageResponse();
	const now = Date.now();
	const l = ledger();

	await refreshEntitlements({ cfg: both, registry: registryWithToken("oauth"), ledger: l, fetchImpl, now });
	assert.equal(l.accountOf("claude-bridge"), "anthropic", "one credential, one account");

	await refreshEntitlements({ cfg: both, registry: registryWithToken(undefined), ledger: l, fetchImpl, now: now + 31 * 60_000 });
	assert.equal(l.accountOf("claude-bridge"), "anthropic", "an unanswered lookup is not evidence of a second account");

	const apart = registryWithTokens({ anthropic: "key-a", "claude-bridge": "oauth-b" });
	await refreshEntitlements({ cfg: both, registry: apart, ledger: l, fetchImpl, now: now + 62 * 60_000 });
	assert.equal(l.accountOf("claude-bridge"), "claude-bridge", "two different credentials are");
});
