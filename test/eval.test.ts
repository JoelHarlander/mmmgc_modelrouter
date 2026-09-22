/**
 * Behavioural tests for the eval harness itself.
 *
 * The harness is a measuring instrument, so these tests check the instrument:
 * that it is deterministic, that it never reaches the network, that it books cost
 * and cache the way the router's own code would, and that the parts it mirrors
 * from src/ (the fan-out candidate policy, the judge question, the stakes
 * override) still match the files they were copied from.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { modelKey } from "../src/config.ts";
import { pickParallelModels } from "../src/parallel.ts";
import { JUDGE_CRITERION, JUDGE_QUESTION, NoisyJudge, pickCandidates } from "../eval/candidates.ts";
import { STAKES_OVERRIDE_THRESHOLD, applyStakesOverride } from "../eval/classifier.ts";
import { loadFleet } from "../eval/fleet.ts";
import { runEval } from "../eval/harness.ts";
import { computeMetrics, PLAN_POINT_USD } from "../eval/metrics.ts";
import { compareMetrics, readRun, type RunRecord, writeRun } from "../eval/results.ts";
import { CACHE_GROWTH_TOKENS_PER_CALL, CALLS_PER_TURN, simulateFanoutUsage, simulateTurnUsage } from "../eval/simulate.ts";
import { buildFleet } from "../eval/fleet.ts";
import { cheapestCapableTier, checkTierPricing, validatePack } from "../eval/validate.ts";
import { runJudgeSweep, type SweepCell } from "../eval/sweep.ts";
import type { Fleet, TaskPack } from "../eval/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLEET = join(ROOT, "eval", "tasks", "fleet.json");
const PACK = join(ROOT, "eval", "tasks", "swe-router-v1.json");

function pack(): TaskPack {
	return JSON.parse(readFileSync(PACK, "utf8")) as TaskPack;
}

function tmpLedger(): string {
	return join(mkdtempSync(join(tmpdir(), "router-eval-test-")), "usage.json");
}

type RunOpts = Partial<Omit<Parameters<typeof runEval>[0], "pack" | "loaded">> & { unauthed?: string[] };

async function run(options: RunOpts = {}) {
	const { unauthed, ...rest } = options;
	const loaded = loadFleet(FLEET, { unauthed });
	return runEval({ pack: pack(), loaded, classifier: "scripted", ledgerFile: tmpLedger(), ...rest });
}

test("the offline run is deterministic: same inputs, byte-identical turn records", async () => {
	const a = await run();
	const b = await run();
	assert.deepEqual(a.turns, b.turns);
	assert.ok(a.turns.length > 20, "the pack should exercise more than 20 turns");
});

test("candidate mode is deterministic for a given seed and moves with the seed", async () => {
	const a = await run({ candidateN: 3, seed: "s1" });
	const b = await run({ candidateN: 3, seed: "s1" });
	assert.deepEqual(a.turns, b.turns);
	const noisier = await run({ candidateN: 3, seed: "s1", judge: new NoisyJudge(60, "s1") });
	const picks = (r: Awaited<ReturnType<typeof run>>) => r.turns.map((t) => t.candidate?.judgePick ?? "-").join(",");
	assert.notEqual(picks(a), picks(noisier), "a much noisier judge must change some picks");
});

test("the router never chooses an ineligible model, and the fleet is offline-only", async () => {
	const outcome = await run();
	const metrics = computeMetrics(outcome.turns, outcome.stateChars);
	assert.equal(metrics.ineligibleChoices, 0);
	for (const turn of outcome.turns) {
		assert.ok(turn.model.startsWith("faux-"), `${turn.model} is not a faux fleet model`);
	}
	// The registry refuses to complete: nothing in the offline path may call a provider.
	assert.throws(() => (outcome.config, loadFleet(FLEET).registry.complete(null as never, null as never)), /never called/);
});

test("an unauthed model is skipped and the tier falls through to the next candidate", async () => {
	const outcome = await run({ unauthed: ["faux-plan-codex/gpt-6-astra"] });
	const metrics = computeMetrics(outcome.turns, outcome.stateChars);
	assert.equal(metrics.ineligibleChoices, 0);
	assert.ok(!outcome.turns.some((t) => t.model === "faux-plan-codex/gpt-6-astra"));
	assert.ok(outcome.turns.some((t) => t.model === "faux-or/glm-5.3"), "standard tier should fall through to the on-demand model");
});

test("a 429 in one task keeps the router off that provider for the rest of the run", async () => {
	const outcome = await run();
	const fixture = pack().tasks.find((t) => t.turns.some((turn) => turn.providerEvent?.status === 429));
	assert.ok(fixture, "the pack must exercise a plan 429");
	const cutoff = outcome.turns.findIndex((t) => t.taskId === fixture.id);
	assert.ok(cutoff >= 0);
	const after = outcome.turns.slice(cutoff + 1);
	assert.ok(after.length > 0, "the 429 must land before the end of the pack");
	assert.ok(
		!after.some((t) => t.model.startsWith("faux-plan-codex/")),
		"a cooled-down plan provider must not be chosen again while the cooldown holds",
	);
});

test("a manual /model pin is respected for switching.manualPinTurns and costs no classifier call", async () => {
	const outcome = await run();
	const pinnedTask = pack().tasks.find((t) => t.turns.some((turn) => turn.manualPin));
	assert.ok(pinnedTask);
	const pinKey = pinnedTask.turns.find((t) => t.manualPin)!.manualPin!;
	const pinned = outcome.turns.filter((t) => t.taskId === pinnedTask.id && t.pinned);
	assert.ok(pinned.length >= 1);
	for (const turn of pinned) {
		assert.equal(turn.model, pinKey);
		assert.equal(turn.classifierCostUsd, 0, "src/index.ts returns before the Jev call on a pinned turn");
		assert.equal(turn.classifierSource, "pinned");
	}
});

test("cache accounting: a switch and a thinking-level change both go cold, a repeat does not", async () => {
	const outcome = await run();
	for (const turn of outcome.turns) {
		if (turn.coldCause === "model-switch") assert.notEqual(turn.model, turn.previousModel);
		if (turn.coldCause === "thinking-change") assert.equal(turn.model, turn.previousModel);
		if (!turn.cold) {
			assert.equal(turn.model, turn.previousModel);
			assert.equal(turn.coldWriteTokens, 0);
		} else {
			assert.equal(turn.coldWriteTokens, turn.contextTokens);
			assert.ok(turn.listEquivalentUsd > turn.warmListEquivalentUsd, "a cold turn must cost more than the same turn warm");
		}
	}
	const metrics = computeMetrics(outcome.turns, outcome.stateChars);
	assert.ok(metrics.coldPremiumUsd > 0);
	assert.equal(metrics.coldByCause["first-turn"], outcome.tasks.length, "every task session starts cold");
});

test("plan routes bill the ledger nothing but are still counted at list price", async () => {
	const outcome = await run();
	const metrics = computeMetrics(outcome.turns, outcome.stateChars);
	const planTurns = outcome.turns.filter((t) => t.model.startsWith("faux-plan-"));
	assert.ok(planTurns.length > 0);
	for (const turn of planTurns) {
		assert.equal(turn.ledgerCostUsd, 0, "a subscription route bills the ledger $0");
		assert.ok(turn.listEquivalentUsd > 0, "...but still consumes the plan");
	}
	assert.ok(metrics.planHiddenUsd > 0);
	assert.equal(
		Math.round((metrics.listEquivalentUsd - metrics.ledgerCostUsd) * 1e4),
		Math.round(metrics.planHiddenUsd * 1e4),
	);
});

test("the classifier fallback is recorded when the fixture models a Jev outage", async () => {
	const outcome = await run();
	const metrics = computeMetrics(outcome.turns, outcome.stateChars);
	const outages = pack().tasks.flatMap((t) => t.turns.filter((turn) => turn.jev?.fail));
	assert.equal(metrics.heuristicFallbacks, outages.length);
	for (const turn of outcome.turns.filter((t) => t.classifierSource === "heuristic")) {
		assert.equal(turn.classifierCostUsd, 0, "a failed classifier call must not be billed");
	}
});

test("the heuristic classifier routes the whole pack without help, and scores worse than scripted Jev", async () => {
	const scripted = computeMetrics(...unpack(await run()));
	const heuristic = computeMetrics(...unpack(await run({ classifier: "heuristic" })));
	assert.equal(heuristic.ineligibleChoices, 0);
	assert.ok(heuristic.tierAccuracy < scripted.tierAccuracy, "the zero-cost fallback should classify worse than Jev");
	assert.equal(heuristic.classifierCostUsd, 0);
});

test("the oracle classifier is the routing ceiling: perfect tiers, no worse outcome", async () => {
	const scripted = computeMetrics(...unpack(await run()));
	const oracle = computeMetrics(...unpack(await run({ classifier: "oracle" })));
	assert.equal(oracle.tierAccuracy, 1);
	assert.equal(oracle.underRouteRate, 0);
	assert.equal(oracle.overRouteRate, 0);
	assert.ok(oracle.turnSuccessRate >= scripted.turnSuccessRate);
});

test("candidate metrics bracket correctly: baseline <= judge <= oracle, and lift is priced", async () => {
	const outcome = await run({ candidateN: 3 });
	const m = computeMetrics(outcome.turns, outcome.stateChars).candidate;
	assert.ok(m);
	assert.ok(m.judgeSuccessRate <= m.oracleSuccessRate + 1e-9, "the judge cannot beat the best candidate");
	assert.ok(m.judgeRecall >= 0 && m.judgeRecall <= 1);
	assert.equal(Math.round((m.judgeSuccessRate - m.baselineSuccessRate) * 1e4) / 1e4, m.judgeLift);
	assert.ok(m.fanoutListEquivalentUsd > 0, "a fan-out is never free");
	if (m.judgeLift > 0) assert.ok(Number.isFinite(m.listUsdPerExtraSolve));
});

test("a fan-out candidate neither reads nor writes the session cache", () => {
	// src/parallel.ts passes cacheRetention: "none" and a fresh sessionId.
	const { usage } = simulateFanoutUsage(
		{ key: "x/y", name: "y", tier: "light", billing: "on-demand", oauth: false, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, skill: 1 },
		100_000,
		1500,
	);
	assert.equal(usage.cacheRead, 0);
	assert.equal(usage.cacheWrite, 0);
	assert.equal(usage.input, 100_000);
	const src = readFileSync(join(ROOT, "src", "parallel.ts"), "utf8");
	assert.match(src, /cacheRetention:\s*"none"/, "src/parallel.ts no longer opts out of the cache; the fan-out cost model must be revisited");
});

test("a routed turn's usage follows the measured traffic profile", () => {
	const model = {
		key: "x/y",
		name: "y",
		tier: "heavy" as const,
		billing: "on-demand" as const,
		oauth: false,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		skill: 80,
	};
	const warm = simulateTurnUsage({ model, contextTokens: 100_000, cold: false });
	const cold = simulateTurnUsage({ model, contextTokens: 100_000, cold: true });
	assert.equal(warm.coldWriteTokens, 0);
	assert.equal(cold.coldWriteTokens, 100_000);
	assert.ok(cold.listEquivalentUsd > warm.listEquivalentUsd);
	// The cold turn's first call writes the whole prefix instead of reading it and
	// appending the turn's new tokens, so the premium is P*(write-read) - growth*write.
	const expected = (100_000 * (6.25 - 0.5) - CACHE_GROWTH_TOKENS_PER_CALL * 6.25) / 1_000_000;
	assert.ok(
		Math.abs(cold.listEquivalentUsd - warm.listEquivalentUsd - expected) < 1e-9,
		`cold premium ${cold.listEquivalentUsd - warm.listEquivalentUsd} != ${expected}`,
	);
	assert.equal(warm.usage.cacheRead, 100_000 * CALLS_PER_TURN + 650 * (0 + 1 + 2 + 3 + 4));
});

test("the harness's candidate policy matches src/parallel.ts#pickParallelModels", () => {
	const loaded = loadFleet(FLEET);
	for (const startKey of [...loaded.byKey.keys(), undefined]) {
		const current = startKey ? loaded.models.find((m) => modelKey(m) === startKey) : undefined;
		const ctx = { model: current, modelRegistry: loaded.registry } as unknown as ExtensionCommandContext;
		for (const n of [2, 3, 4, 6]) {
			const shipped = pickParallelModels(ctx, loaded.config, n).map(modelKey);
			const harness = pickCandidates({ current, cfg: loaded.config, n, byKey: loaded.byKey, unauthed: loaded.unauthed }).map((m) => m.key);
			assert.deepEqual(harness, shipped, `candidate policy drifted for n=${n}, current=${startKey ?? "none"}`);
		}
	}
});

test("the harness's judge question is still the one src/parallel.ts sends", () => {
	const src = readFileSync(join(ROOT, "src", "parallel.ts"), "utf8");
	assert.ok(src.includes(JUDGE_QUESTION), "src/parallel.ts's judge question changed; update eval/candidates.ts JUDGE_QUESTION");
	assert.equal(JUDGE_CRITERION("A"), "Response A in `responses`");
	assert.ok(src.includes("`Response ${r.label} in \\`responses\\``"), "src/parallel.ts's judge criteria changed; update JUDGE_CRITERION");
});

test("the harness's stakes override is still the one src/index.ts applies", () => {
	const src = readFileSync(join(ROOT, "src", "index.ts"), "utf8");
	const match = src.match(/stakes >= ([\d.]+) && tier === "light"\) tier = "standard"/);
	assert.ok(match, "src/index.ts's stakes override changed shape; update eval/classifier.ts");
	assert.equal(Number(match[1]), STAKES_OVERRIDE_THRESHOLD);
	assert.equal(applyStakesOverride("light", STAKES_OVERRIDE_THRESHOLD), "standard");
	assert.equal(applyStakesOverride("light", STAKES_OVERRIDE_THRESHOLD - 0.01), "light");
	assert.equal(applyStakesOverride("heavy", 3), "heavy");
});

test("results round-trip and the comparison knows which direction is better", async () => {
	const outcome = await run();
	const metrics = computeMetrics(outcome.turns, outcome.stateChars);
	const root = mkdtempSync(join(tmpdir(), "router-eval-results-"));
	const record: RunRecord = {
		version: 1,
		runId: "2026-01-01T00-00-00-test-abc1234",
		at: "2026-01-01T00:00:00.000Z",
		profile: "test",
		pack: "swe-router-v1",
		fleet: "eval/tasks/fleet.json",
		classifier: "scripted",
		candidateN: 0,
		judge: "none",
		seed: "s",
		startModel: outcome.startModel,
		live: false,
		metrics,
		turns: outcome.turns,
	};
	const written = writeRun(root, record);
	const back = readRun(written.latestPath);
	assert.ok(back);
	assert.deepEqual(back.metrics, metrics);

	const better = { ...metrics, taskResolveRate: metrics.taskResolveRate + 0.1, listEquivalentUsd: metrics.listEquivalentUsd - 1 };
	const deltas = compareMetrics(metrics, better);
	assert.equal(deltas.find((d) => d.key === "taskResolveRate")?.direction, "better");
	assert.equal(deltas.find((d) => d.key === "listEquivalentUsd")?.direction, "better");
	assert.equal(deltas.find((d) => d.key === "tierAccuracy")?.direction, "same");

	const worse = compareMetrics(metrics, { ...metrics, underRouteRate: metrics.underRouteRate + 0.1 });
	assert.equal(worse.find((d) => d.key === "underRouteRate")?.direction, "worse");
});

test("every metric rate stays inside its range", async () => {
	const outcome = await run({ candidateN: 2 });
	const m = computeMetrics(outcome.turns, outcome.stateChars);
	const rates: [string, number][] = [
		["taskResolveRate", m.taskResolveRate],
		["turnSuccessRate", m.turnSuccessRate],
		["tierAccuracy", m.tierAccuracy],
		["underRouteRate", m.underRouteRate],
		["overRouteRate", m.overRouteRate],
		["switchesPerTurn", m.switchesPerTurn],
		["candidate.judgeRecall", m.candidate!.judgeRecall],
	];
	for (const [name, value] of rates) assert.ok(value >= 0 && value <= 1, `${name} = ${value} is outside 0..1`);
	assert.equal(
		Math.round((m.tierAccuracy + m.underRouteRate + m.overRouteRate) * 1e4) / 1e4,
		1,
		"every turn is exactly one of: right tier, under-routed, over-routed",
	);
	assert.ok(m.avgStateChars > 0 && m.avgStateChars < outcome.config.jev.maxStateChars, "the classifier state must fit its budget");
});

test("the judge sweep degrades with noise and is reproducible", async () => {
	const loaded = loadFleet(FLEET);
	const opts = { pack: pack(), loaded, classifier: "scripted" as const, candidateNs: [3], seeds: ["s1", "s2", "s3"] };
	const cells = await runJudgeSweep({ ...opts, noises: [0, 20, 80] });
	assert.equal(cells.length, 3);
	assert.deepEqual(await runJudgeSweep({ ...opts, noises: [0, 20, 80] }), cells);

	const [perfect, middling, awful] = cells as [SweepCell, SweepCell, SweepCell];
	assert.equal(perfect.liftSpread, 0, "a judge with no error cannot vary by seed");
	assert.equal(perfect.judgeRecall, 1);
	assert.ok(perfect.judgeLift > middling.judgeLift, "more noise must not help");
	assert.ok(middling.judgeLift > awful.judgeLift);
	for (const cell of cells) assert.ok(cell.judgeSuccessRate <= cell.oracleSuccessRate + 1e-9);
});

test("a judge that systematically prefers the flashy answer makes the fan-out worse than not running it", async () => {
	const loaded = loadFleet(FLEET);
	const cells = await runJudgeSweep({
		pack: pack(),
		loaded,
		classifier: "scripted",
		candidateNs: [3],
		noises: [10],
		biases: [0, 40],
		seeds: ["s1", "s2", "s3"],
	});
	const [unbiased, biased] = cells as [SweepCell, SweepCell];
	assert.ok(unbiased.judgeLift > 0, "the unbiased judge should still help");
	assert.ok(biased.judgeLift < 0, "a strong flagship bias should cost more turns than it wins");
	assert.ok(biased.judgeRegressions > unbiased.judgeRegressions);
});

test("the shipped pack's ground truth is consistent with the shipped fleet", () => {
	const problems = validatePack(pack(), loadFleet(FLEET));
	const errors = problems.filter((p) => p.level === "error");
	assert.deepEqual(errors, [], `the pack must stay consistent:\n${errors.map((e) => `${e.where}: ${e.message}`).join("\n")}`);
});

test("the validator catches the ground-truth defects round 1 shipped", () => {
	const loaded = loadFleet(FLEET);
	const broken = pack();
	// A turn labelled light whose requiredSkill only a heavy model reaches.
	broken.tasks[0]!.turns[0]!.goldTier = "light";
	broken.tasks[0]!.turns[0]!.requiredSkill = 95;
	// Stakes outside the 0..2 the three criteria in src/state.ts can produce.
	broken.tasks[1]!.turns[0]!.jev = { ...broken.tasks[1]!.turns[0]!.jev!, stakes: 2.5 };
	broken.tasks[2]!.turns[0]!.manualPin = "anthropic/claude-opus-5";
	const problems = validatePack(broken, loaded);
	assert.ok(problems.some((p) => p.level === "warning" && /can never be solved/.test(p.message)));
	assert.ok(problems.some((p) => p.level === "error" && /jev.stakes 2.5 is outside/.test(p.message)));
	assert.ok(problems.some((p) => p.level === "error" && /manualPin .* is not in the fleet/.test(p.message)));

	broken.tasks[0]!.turns[0]!.requiredSkill = 80;
	assert.ok(
		validatePack(broken, loaded).some((p) => p.level === "error" && /goldTier says "light" but requiredSkill 80/.test(p.message)),
	);
});

test("goldTier is derived from the fleet, not read from the fixture", async () => {
	const loaded = loadFleet(FLEET);
	const turn = pack().tasks.find((t) => t.id === "django__django-11039")!.turns[0]!;
	assert.equal(cheapestCapableTier(loaded, "bugfix", turn.requiredSkill ?? 60), "standard");

	// Give the light tier a model that can do standard work and the same turn becomes light.
	const raw = JSON.parse(readFileSync(FLEET, "utf8")) as Fleet;
	raw.models.find((m) => m.key === "faux-or/glm-5.3-flash")!.skill = 95;
	const stronger = buildFleet(raw);
	assert.equal(cheapestCapableTier(stronger, "bugfix", 60), "light");

	const outcome = await runEval({ pack: pack(), loaded: stronger, classifier: "scripted", ledgerFile: tmpLedger() });
	const moved = outcome.turns.find((t) => t.taskId === "django__django-11039" && t.turn === 1)!;
	assert.equal(moved.goldTier, "light", "a stronger light tier must move the gold label, not just the score");
});

test("the tier price inversion in the shipped defaults is reported, not hidden", () => {
	const problems = checkTierPricing(loadFleet(FLEET));
	assert.equal(problems.length, 1);
	assert.equal(problems[0]!.level, "warning", "an inversion must not block a run");
	assert.match(problems[0]!.message, /tier price inversion/);
	assert.match(problems[0]!.message, /heavy/);
});

test("plan spend is also reported in weekly plan points", async () => {
	const outcome = await run();
	const m = computeMetrics(outcome.turns, outcome.stateChars);
	assert.ok(m.planPointsUsed > 0);
	assert.equal(Math.round((m.planHiddenUsd / PLAN_POINT_USD) * 1e3) / 1e3, m.planPointsUsed);
});

function unpack(outcome: Awaited<ReturnType<typeof run>>): [typeof outcome.turns, number[]] {
	return [outcome.turns, outcome.stateChars];
}
