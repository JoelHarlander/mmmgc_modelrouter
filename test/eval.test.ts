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
import { DEFAULT_CONFIG, modelKey } from "../src/config.ts";
import { pickParallelModels } from "../src/parallel.ts";
import { CANDIDATE_POLICIES, JUDGE_CRITERION, JUDGE_QUESTION, NoisyJudge, pickCandidates } from "../eval/candidates.ts";
import { STAKES_OVERRIDE_THRESHOLD, applyStakesOverride } from "../eval/classifier.ts";
import { loadFleet } from "../eval/fleet.ts";
import { runEval } from "../eval/harness.ts";
import { computeMetrics, PLAN_POINT_USD } from "../eval/metrics.ts";
import { compareMetrics, GATED_METRICS, gateRegressions, readRun, type RunRecord, writeRun } from "../eval/results.ts";
import { CACHE_GROWTH_TOKENS_PER_CALL, CALLS_PER_TURN, simulateFanoutUsage, simulateTurnUsage } from "../eval/simulate.ts";
import { buildFleet } from "../eval/fleet.ts";
import { cheapestCapableTier, checkTierPricing, validatePack } from "../eval/validate.ts";
import {
	type OracleCell,
	perturbFleet,
	runJudgeSweep,
	runOracleSweep,
	runPolicySweep,
	runTrafficSweep,
	type SweepCell,
	type TrafficCell,
} from "../eval/sweep.ts";
import { loadProbePack, runProbe } from "../eval/probe.ts";
import type { Fleet, TaskPack } from "../eval/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLEET = join(ROOT, "eval", "tasks", "fleet.json");
const PACK = join(ROOT, "eval", "tasks", "swe-router-v1.json");
const LONG_PACK = join(ROOT, "eval", "tasks", "swe-router-long-v1.json");
const PROBE_PACK = join(ROOT, "eval", "tasks", "judge-probe-v1.json");

function pack(path = PACK): TaskPack {
	return JSON.parse(readFileSync(path, "utf8")) as TaskPack;
}

function tmpLedger(): string {
	return join(mkdtempSync(join(tmpdir(), "router-eval-test-")), "usage.json");
}

type RunOpts = Partial<Omit<Parameters<typeof runEval>[0], "loaded">> & { unauthed?: string[] };

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
			const policyArgs = { current, cfg: loaded.config, n, byKey: loaded.byKey, unauthed: loaded.unauthed };
			const harness = pickCandidates(policyArgs).map((m) => m.key);
			assert.deepEqual(harness, shipped, `candidate policy drifted for n=${n}, current=${startKey ?? "none"}`);
			// ...and the registry entry the sweeps use must be that same policy.
			assert.deepEqual(CANDIDATE_POLICIES.shipped!(policyArgs).map((m) => m.key), shipped);
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

test("the long-session pack reaches the context sizes the cache-cost study measured", () => {
	const long = pack(LONG_PACK);
	const contexts: number[] = [];
	for (const task of long.tasks) {
		for (let i = 0; i < task.turns.length; i++) contexts.push(task.startContextTokens + i * task.contextGrowthPerTurn);
		assert.ok(task.turns.length >= 8, `${task.id} is not a long session (${task.turns.length} turns)`);
	}
	const max = Math.max(...contexts);
	assert.ok(max >= 200_000, `the long pack tops out at ${max} tokens; the measured p50 is 235k`);
	assert.ok(Math.min(...contexts) >= 50_000, "a long session does not start at a short pack's context size");
	assert.deepEqual(validatePack(long, loadFleet(FLEET)).filter((p) => p.level === "error"), []);
});

test("context size is what makes the cache dominate, and the harness shows it", async () => {
	const short = computeMetrics(...unpack(await run()));
	const long = computeMetrics(...unpack(await run({ pack: pack(LONG_PACK) })));
	assert.ok(long.coldWriteTokens > short.coldWriteTokens * 5, "long sessions must re-write far more context");
	assert.ok(
		long.coldPremiumShare > short.coldPremiumShare,
		`cold starts should take a bigger share of spend at long context (${long.coldPremiumShare} vs ${short.coldPremiumShare})`,
	);
	assert.ok(long.coldPremiumShare > 0.3, "at the measured context sizes the cold premium is a large share of spend");
});

test("fan-out gets dramatically more expensive per extra solve at realistic context", async () => {
	const short = computeMetrics(...unpack(await run({ candidateN: 3 }))).candidate!;
	const long = computeMetrics(...unpack(await run({ pack: pack(LONG_PACK), candidateN: 3 }))).candidate!;
	assert.ok(Number.isFinite(short.listUsdPerExtraSolve) && Number.isFinite(long.listUsdPerExtraSolve));
	assert.ok(
		long.listUsdPerExtraSolve > short.listUsdPerExtraSolve * 2,
		`a fan-out candidate pays full uncached input, so its price must scale with context (${short.listUsdPerExtraSolve} -> ${long.listUsdPerExtraSolve})`,
	);
});

test("task-level rates stay readable when every long session has at least one failure", async () => {
	const m = computeMetrics(...unpack(await run({ pack: pack(LONG_PACK) })));
	assert.equal(m.taskResolveRate, 0, "this pack is long enough that no session is flawless; that is the point");
	assert.ok(m.medianTaskTurnSuccess > 0, "...so the median per-task rate has to carry the quality signal");
	assert.ok(m.worstTaskTurnSuccess <= m.medianTaskTurnSuccess);
	assert.ok(m.medianTaskTurnSuccess <= 1);
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

test("the gate fails on a real regression and stays quiet on an improvement", async () => {
	const outcome = await run();
	const base = computeMetrics(outcome.turns, outcome.stateChars);

	assert.deepEqual(gateRegressions(compareMetrics(base, base)), [], "an identical run must not trip the gate");

	// Inside tolerance: 1pp of turn success and 3% of spend are noise, not a regression.
	const noise = { ...base, turnSuccessRate: base.turnSuccessRate - 0.01, listEquivalentUsd: base.listEquivalentUsd * 1.03 };
	assert.deepEqual(gateRegressions(compareMetrics(base, noise)), []);

	// Past tolerance, in both directions of "worse".
	const worse = { ...base, turnSuccessRate: base.turnSuccessRate - 0.05, listEquivalentUsd: base.listEquivalentUsd * 1.2 };
	const failures = gateRegressions(compareMetrics(base, worse));
	assert.deepEqual(failures.map((f) => f.key).sort(), ["listEquivalentUsd", "turnSuccessRate"]);

	// Improvements never fail, however large.
	const better = { ...base, turnSuccessRate: 1, listEquivalentUsd: 0.01, coldPremiumUsd: 0 };
	assert.deepEqual(gateRegressions(compareMetrics(base, better)), []);

	// Any ineligible route at all is a regression: this one has no tolerance.
	const bug = { ...base, ineligibleChoices: base.ineligibleChoices + 1 };
	assert.deepEqual(gateRegressions(compareMetrics(base, bug)).map((f) => f.key), ["ineligibleChoices"]);

	// And the tolerance multiplier widens the band rather than changing direction.
	assert.deepEqual(gateRegressions(compareMetrics(base, worse), 10), []);
});

test("the candidate lift is gated on the adopted outcome, not the raw pick", async () => {
	const outcome = await run({ candidateN: 3 });
	const base = computeMetrics(outcome.turns, outcome.stateChars);
	assert.ok(base.candidate);
	const worse = { ...base, candidate: { ...base.candidate, adoptedLift: base.candidate.adoptedLift - 0.1 } };
	assert.deepEqual(gateRegressions(compareMetrics(base, worse)).map((f) => f.key), ["candidate.adoptedLift"]);
	assert.ok(
		GATED_METRICS.every((g) => g.key !== "candidate.judgeLift"),
		"the gate must watch what a session adopts, not what the judge would have picked",
	);
});

test("no candidate policy is allowed to read the oracle's skill numbers", () => {
	const raw = JSON.parse(readFileSync(FLEET, "utf8")) as Fleet;
	const base = loadFleet(FLEET);
	// perturbFleet moves skill and nothing else, so a policy that peeked at skill would
	// return a different set. Every policy must be blind to it.
	const jittered = buildFleet(perturbFleet(raw, 30, "peek"));
	const current = base.models.find((m) => modelKey(m) === "faux-plan-anthropic/claude-opus-5");
	for (const [name, policy] of Object.entries(CANDIDATE_POLICIES)) {
		for (const n of [2, 3, 4]) {
			const before = policy({ current, cfg: base.config, n, byKey: base.byKey, unauthed: base.unauthed }).map((m) => m.key);
			const after = policy({ current, cfg: jittered.config, n, byKey: jittered.byKey, unauthed: jittered.unauthed }).map((m) => m.key);
			assert.deepEqual(after, before, `policy "${name}" (n=${n}) changed when only hidden skill changed: it is cheating`);
		}
	}
});

test("the shipped candidate set is the only one whose flashiest member is not its strongest", () => {
	const loaded = loadFleet(FLEET);
	const current = loaded.models.find((m) => modelKey(m) === "faux-plan-anthropic/claude-opus-5");
	const opposed: string[] = [];
	for (const [name, policy] of Object.entries(CANDIDATE_POLICIES)) {
		const set = policy({ current, cfg: loaded.config, n: 3, byKey: loaded.byKey, unauthed: loaded.unauthed });
		const flashiest = [...set].sort((a, b) => b.cost.output - a.cost.output)[0]!;
		const strongest = [...set].sort((a, b) => b.skill - a.skill)[0]!;
		if (flashiest.key !== strongest.key) opposed.push(name);
	}
	// This is why the shipped set collapses under judge bias while the others do not, and
	// it follows from the tier price inversion --validate already warns about: the policy
	// takes tiers.standard[0], which is pricier and weaker than the heavy tier's pick.
	assert.deepEqual(opposed, ["shipped"]);
});

test("an alternative candidate set is both cheaper and more robust than the shipped one", async () => {
	const cells = await runPolicySweep({
		pack: pack(LONG_PACK),
		loaded: loadFleet(FLEET),
		classifier: "scripted",
		policies: ["shipped", "tier-top"],
		biases: [0, 20],
		seeds: ["s1", "s2", "s3"],
	});
	const find = (policy: string, bias: number) => cells.find((c) => c.policy === policy && c.bias === bias)!;
	const shipped = find("shipped", 0);
	const alt = find("tier-top", 0);

	assert.ok(alt.adoptedLift > shipped.adoptedLift, "tier-top should deliver more lift");
	assert.ok(alt.fanoutListEquivalentUsd < shipped.fanoutListEquivalentUsd / 2, "...for less than half the fan-out bill");
	assert.ok(alt.listUsdPerExtraSolve < shipped.listUsdPerExtraSolve);

	// ...and it does not fall over when the judge is biased, where the shipped set does.
	assert.ok(find("shipped", 20).adoptedLift < 0, "the shipped set should go negative at bias 20");
	assert.ok(find("tier-top", 20).adoptedLift > 0, "tier-top should stay positive");
});

test("the confidence gate is the shipped auto-adopt rule, and a zero bar disables it", async () => {
	const open = computeMetrics(...unpack(await run({ candidateN: 3, judgeMinConfidence: 0 }))).candidate!;
	assert.equal(open.gatedTurns, 0);
	assert.equal(open.adoptedSuccessRate, open.judgeSuccessRate, "with no bar, what is adopted is the raw pick");
	assert.equal(open.adoptedLift, open.judgeLift);

	const shut = computeMetrics(...unpack(await run({ candidateN: 3, judgeMinConfidence: 1.01 }))).candidate!;
	assert.equal(shut.gatedTurns, shut.turns, "an unreachable bar gates every turn");
	assert.equal(shut.adoptedSuccessRate, shut.baselineSuccessRate, "...so every turn keeps the routed answer");
	assert.equal(shut.adoptedLift, 0);

	// The default bar is the one src/parallel.ts auto-adopts above.
	const src = readFileSync(join(ROOT, "src", "parallel.ts"), "utf8");
	assert.match(src, /entry\.judge!\.confidence >= cfg\.switching\.minConfidence/, "src/parallel.ts's auto-adopt bar moved; update the harness default");
	const dflt = computeMetrics(...unpack(await run({ candidateN: 3 }))).candidate!;
	const explicit = computeMetrics(...unpack(await run({ candidateN: 3, judgeMinConfidence: DEFAULT_CONFIG.switching.minConfidence }))).candidate!;
	assert.equal(dflt.adoptedSuccessRate, explicit.adoptedSuccessRate);
});

test("a biased judge is confidently wrong, so the confidence gate cannot see it coming", async () => {
	// The long pack: enough candidate turns for the wrong ones to be a sample rather than a handful.
	const confidenceWhenWrong = async (bias: number) => {
		const outcome = await run({
			pack: pack(LONG_PACK),
			candidateN: 3,
			judgeMinConfidence: 0,
			judge: new NoisyJudge({ noise: 10, seed: "g", bias }),
		});
		const wrong = outcome.turns
			.filter((t) => t.candidate && !t.candidate.judgeSolved && t.candidate.candidates.some((c) => c.solved))
			.map((t) => t.candidate!.judgeConfidence);
		return { n: wrong.length, mean: wrong.reduce((a, b) => a + b, 0) / Math.max(1, wrong.length) };
	};
	const clean = await confidenceWhenWrong(0);
	const biased = await confidenceWhenWrong(40);

	assert.ok(biased.n > clean.n, "more bias must produce more wrong picks");
	assert.ok(
		biased.mean > clean.mean + 0.3,
		`an unbiased judge is unsure when it errs (${clean.mean.toFixed(2)}); a biased one is not (${biased.mean.toFixed(2)}) - ` +
			"this is why gating on confidence does not defend against bias",
	);
	assert.ok(biased.mean > 0.8, "a strongly biased judge errs at high confidence");
});

test("jittering the declared fleet skills is deterministic and bounded", () => {
	const raw = JSON.parse(readFileSync(FLEET, "utf8")) as Fleet;
	const a = perturbFleet(raw, 20, "s1");
	assert.deepEqual(a, perturbFleet(raw, 20, "s1"));
	assert.notDeepEqual(a, perturbFleet(raw, 20, "s2"));
	assert.deepEqual(perturbFleet(raw, 0, "s1").models.map((m) => m.skill), raw.models.map((m) => m.skill));
	for (const [i, model] of a.models.entries()) {
		assert.ok(Math.abs(model.skill - raw.models[i]!.skill) <= 20);
		assert.ok(model.skill >= 1 && model.skill <= 100);
		assert.equal(model.cost.input, raw.models[i]!.cost.input, "jitter must move competence, not prices");
	}
});

test("the switching-cost finding survives being wrong about the fleet; the quality finding does not", async () => {
	const cells = await runOracleSweep({
		pack: pack(LONG_PACK),
		loaded: loadFleet(FLEET),
		classifier: "scripted",
		jitters: [0, 20],
		seeds: ["s1", "s2", "s3"],
	});
	const [exact, jittered] = cells as [OracleCell, OracleCell];

	assert.equal(exact.scriptedSpread, 0, "an unjittered fleet must be identical across seeds");
	assert.ok(jittered.scriptedSpread > exact.scriptedSpread, "jitter must move the quality numbers");

	// Cost: routing perfectly still spends more than never routing, at every jitter. This
	// is cache economics, not competence, so being wrong about the fleet cannot change it.
	assert.equal(exact.oracleCostsMore, 1);
	assert.equal(jittered.oracleCostsMore, 1, "the switching-cost finding must not depend on the declared skills");

	// Quality: "never switching also wins on outcome" is a fact about this fleet, and the
	// sweep is what stops it being quoted as more than that.
	assert.equal(exact.heuristicBeatsOracle, 1);
	assert.ok(jittered.heuristicBeatsOracle < 1, "the quality half of the finding should not be robust; say so rather than hide it");
});

test("the judge probe recovers a bias it was not told about", async () => {
	const probe = loadProbePack(PROBE_PACK);
	const recovered: [number, number][] = [];
	for (const injected of [0, 15, 30, 60]) {
		const report = await runProbe(new NoisyJudge({ noise: 10, seed: "probe-test", bias: injected }), probe);
		recovered.push([injected, report.estimatedBiasPoints]);
	}
	for (const [injected, estimated] of recovered) {
		assert.ok(
			Math.abs(estimated - injected) <= 8,
			`probe estimated ${estimated} points for an injected ${injected}; the probe has lost its calibration`,
		);
	}
	// ...and it has to be monotone, or the estimate means nothing.
	for (let i = 1; i < recovered.length; i++) assert.ok(recovered[i]![1] >= recovered[i - 1]![1]);
});

test("the probe measures presentation, not a distrust of formatting", async () => {
	const probe = loadProbePack(PROBE_PACK);
	const clean = await runProbe(new NoisyJudge({ noise: 10, seed: "p", bias: 0 }), probe);
	const biased = await runProbe(new NoisyJudge({ noise: 10, seed: "p", bias: 40 }), probe);

	assert.ok(biased.styleTrapRate > clean.styleTrapRate, "bias must show up in the traps");
	// The control: on aligned items the flashy answer is also the better one, so a judge
	// that merely prefers flash still scores full marks there.
	assert.equal(clean.alignedAccuracy, 1);
	assert.equal(biased.alignedAccuracy, 1);
	assert.ok(biased.accuracy < clean.accuracy);
	// Every item is shown both ways round, so position cannot masquerade as presentation.
	assert.ok(clean.positionBias <= 0.2, `position bias ${clean.positionBias} is too high to read the trap rate cleanly`);
	assert.equal(clean.calls, probe.items.length * 2);
});

test("the probe pack has resolution across the band of bias that actually matters", () => {
	const probe = loadProbePack(PROBE_PACK);
	const gaps = probe.items
		.filter((i) => i.kind === "trap")
		.map((i) => Math.abs(i.responses[0].trueSkill - i.responses[1].trueSkill))
		.sort((a, b) => a - b);
	assert.ok(gaps.length >= 10, "too few trap items to read a rate from");
	assert.ok(gaps[0]! <= 12, `the narrowest trap gap is ${gaps[0]}; the probe cannot see small biases`);
	assert.ok(gaps[gaps.length - 1]! >= 40, "the probe needs obvious traps too, as an upper anchor");
	for (const item of probe.items) {
		const [a, b] = item.responses;
		const flashier = a.flashiness > b.flashiness ? a : b;
		const better = a.trueSkill > b.trueSkill ? a : b;
		if (item.kind === "trap") assert.notEqual(flashier.key, better.key, `${item.id}: a trap's flashier answer must be the worse one`);
		if (item.kind === "aligned") assert.equal(flashier.key, better.key, `${item.id}: an aligned item's flashier answer must be the better one`);
	}
});

test("the cold-start bill does not depend on the traffic constants; only its share of spend does", async () => {
	const cells = await runTrafficSweep({
		pack: pack(LONG_PACK),
		loaded: loadFleet(FLEET),
		classifier: "scripted",
		profiles: [{ callsPerTurn: 2 }, { callsPerTurn: 5 }, { callsPerTurn: 20 }],
		candidateN: 3,
	});
	const [few, measured, many] = cells as [TrafficCell, TrafficCell, TrafficCell];

	// A cold start writes the prefix once, whatever happens afterwards in the turn.
	assert.equal(few.coldPremiumUsd, measured.coldPremiumUsd);
	assert.equal(many.coldPremiumUsd, measured.coldPremiumUsd);
	// ...so more calls per turn only dilute it.
	assert.ok(few.coldPremiumShare > measured.coldPremiumShare);
	assert.ok(measured.coldPremiumShare > many.coldPremiumShare);
	assert.ok(few.listEquivalentUsd < many.listEquivalentUsd);
});

test("the candidate-selection verdict does not rest on the traffic constants at all", async () => {
	const cells = await runTrafficSweep({
		pack: pack(LONG_PACK),
		loaded: loadFleet(FLEET),
		classifier: "scripted",
		profiles: [{ callsPerTurn: 2 }, { callsPerTurn: 20 }, { cacheGrowthTokensPerCall: 3000 }, { outputTokensPerCall: 2000 }],
		candidateN: 3,
	});
	// src/parallel.ts makes one uncached call per candidate and runs no tools, so the
	// fan-out bill is a function of context alone.
	for (const cell of cells as TrafficCell[]) {
		assert.equal(cell.fanoutListEquivalentUsd, (cells[0] as TrafficCell).fanoutListEquivalentUsd);
		assert.equal(cell.listUsdPerExtraSolve, (cells[0] as TrafficCell).listUsdPerExtraSolve);
	}
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
