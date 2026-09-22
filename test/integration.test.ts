/**
 * Does the harness predict what pi actually does?
 *
 * Everything in `eval/` drives `chooseModel` directly, which is what makes it fast and
 * deterministic — and means it never proves the decision reaches pi. `npm run smoke`
 * proves that for one turn; this proves the harness *agrees* with it.
 *
 * For each prompt, pi is run for real with the faux provider from
 * `test/faux-provider.ext.ts` and the shipped extension, and the model that actually
 * answered is compared against the model the harness predicts for the same prompt, the
 * same starting model and the same configuration. No tokens are spent: the faux provider
 * is zero-cost, and `test/smoke/.pi/modelrouter.json` points Jev at a credential that is
 * never present, so both sides route through `src/router.ts#heuristicTier` offline.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildFleet } from "../eval/fleet.ts";
import { runEval } from "../eval/harness.ts";
import type { Fleet, TaskPack } from "../eval/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE = join(ROOT, "test", "smoke");

/** The faux provider's two models, mirrored as an eval fleet with the project config's tiers. */
const FAUX_FLEET: Fleet = {
	version: 1,
	note: "Mirrors test/faux-provider.ext.ts and test/smoke/.pi/modelrouter.json.",
	models: [
		{
			key: "faux/b",
			name: "Faux B (light)",
			tier: "light",
			billing: "on-demand",
			oauth: false,
			cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 },
			skill: 60,
			capability: 40,
		},
		{
			key: "faux/a",
			name: "Faux A (heavy)",
			tier: "heavy",
			billing: "on-demand",
			oauth: false,
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 10 },
			skill: 90,
			capability: 90,
		},
	],
	tiers: { light: ["faux/b"], standard: ["faux/b"], heavy: ["faux/a"] },
};

type SmokeConfig = { switching: { minConfidence: number; cacheSwitchPenalty: boolean; manualPinTurns: number; expectedOutputTokens: number } };

function projectConfig(): SmokeConfig {
	return JSON.parse(readFileSync(join(SMOKE, ".pi", "modelrouter.json"), "utf8")) as SmokeConfig;
}

/**
 * Run pi for real and report which model answered, or undefined when pi is unavailable.
 * Both streams are read: the faux extension logs the provider/model to stderr, and the
 * assistant text on stdout names the model that produced it.
 */
function askPi(prompt: string): string | undefined {
	const result = spawnSync(
		"pi",
		[
			"-p",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-session",
			"--approve",
			"-e",
			join("..", "faux-provider.ext.ts"),
			"-e",
			join("..", "..", "src", "index.ts"),
			"--provider",
			"faux",
			"--model",
			"a",
			prompt,
		],
		{ cwd: SMOKE, encoding: "utf8", timeout: 120_000 },
	);
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	const logged = /came from faux\/([ab])/.exec(output)?.[1];
	const answered = /answered by ([ab])\b/.exec(output)?.[1];
	if (logged && answered) assert.equal(logged, answered, "pi's own log and the reply disagree about which model answered");
	const id = logged ?? answered;
	return id ? `faux/${id}` : undefined;
}

/** What the harness says the router will do, for the same prompt and the same config. */
async function askHarness(prompt: string): Promise<string> {
	// The same switching block pi is given, so neither side can drift from the other.
	const loaded = buildFleet(FAUX_FLEET, { configPatch: { switching: projectConfig().switching } });
	const pack: TaskPack = {
		version: 1,
		id: "integration",
		description: "one turn, to compare against a real pi run",
		tasks: [{ id: "t", repo: "-", category: "bugfix", requiredSkill: 50, startContextTokens: 2000, contextGrowthPerTurn: 0, turns: [{ prompt }] }],
	};
	// `heuristic` because the smoke config gives Jev a credential that is never present,
	// so this is the branch pi takes too.
	const outcome = await runEval({ pack, loaded, classifier: "heuristic", startModel: "faux/a" });
	return outcome.turns[0]!.model;
}

const PROMPTS = [
	"ls",
	"why does this deadlock under load?",
	"implement the described helper in two files following the existing pattern",
	"rename this variable",
	"investigate the root cause of the flaky test",
];

test("the harness predicts the model real pi routes to", async (t) => {
	if (askPi("ls") === undefined) {
		t.skip("pi is not runnable here; the harness's prediction cannot be cross-checked");
		return;
	}
	for (const prompt of PROMPTS) {
		const actual = askPi(prompt);
		const predicted = await askHarness(prompt);
		assert.ok(actual, `pi produced no assistant message for "${prompt}"`);
		assert.equal(predicted, actual, `harness predicted ${predicted} but pi routed "${prompt}" to ${actual}`);
	}
});

test("the smoke config pins everything the prediction depends on", () => {
	// If a setting the routing depends on is left to the machine's global config, this
	// cross-check silently becomes a test of whoever's laptop it runs on.
	const cfg = JSON.parse(readFileSync(join(SMOKE, ".pi", "modelrouter.json"), "utf8")) as Record<string, unknown>;
	for (const key of ["enabled", "jev", "tiers", "models", "switching", "thinking"]) {
		assert.ok(key in cfg, `test/smoke/.pi/modelrouter.json no longer pins "${key}"`);
	}
	const jev = cfg.jev as { transport: string; apiKeyEnv: string };
	assert.equal(jev.transport, "typesafe", "the transport must be one whose credential can be guaranteed absent");
	assert.equal(process.env[jev.apiKeyEnv], undefined, `${jev.apiKeyEnv} is set, so the smoke run would reach the network`);
	assert.deepEqual(Object.keys(cfg.tiers as object).sort(), ["heavy", "light", "standard"]);
	// The fleet mirrored in this file must match the tiers pi is given.
	assert.deepEqual(FAUX_FLEET.tiers, cfg.tiers);
});
