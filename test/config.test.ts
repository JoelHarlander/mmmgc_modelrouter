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
import { DEFAULT_CONFIG, loadConfig, PROJECT_OVERRIDABLE, type RouterConfig } from "../src/config.ts";
import { JevClient, type JsonValue } from "../src/jev.ts";

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
