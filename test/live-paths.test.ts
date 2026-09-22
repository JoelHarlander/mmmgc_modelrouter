/**
 * The live paths, exercised against a local stand-in for TypeSafe's endpoint.
 *
 * `--classifier live`, the Jev judge and `--record` are opt-in and cost money, so they
 * had never been run by anything. `src/jev.ts` is the only file in `src/` that talks to
 * a network, and its 429 retry, error formatting and cost-extraction branches had no
 * coverage at all.
 *
 * Everything here runs against 127.0.0.1 with a fake credential: no real network, no
 * spend, and no dependence on a Jev key existing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { JevClient, JevError } from "../src/jev.ts";
import { routingQuestions } from "../src/state.ts";
import { JevJudge } from "../eval/candidates.ts";
import { loadFleet } from "../eval/fleet.ts";
import { runEval } from "../eval/harness.ts";
import { computeMetrics } from "../eval/metrics.ts";
import { recordAnswers } from "../eval/record.ts";
import { type FakeJevHandler, judgeAnswer, routingAnswer, startFakeJev } from "./fake-jev.ts";
import type { TaskPack } from "../eval/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLEET = join(ROOT, "eval", "tasks", "fleet.json");
const PACK = join(ROOT, "eval", "tasks", "swe-router-v1.json");

function pack(): TaskPack {
	return JSON.parse(readFileSync(PACK, "utf8")) as TaskPack;
}

async function withJev<T>(handler: FakeJevHandler, body: (client: JevClient, jev: Awaited<ReturnType<typeof startFakeJev>>) => Promise<T>): Promise<T> {
	const server = await startFakeJev(handler);
	const client = new JevClient({ ...DEFAULT_CONFIG.jev, transport: "typesafe", apiKey: "test-key", baseUrl: server.baseUrl });
	try {
		return await body(client, server);
	} finally {
		await server.close();
	}
}

test("a live classifier call sends the documented shape and reads the answer back", async () => {
	await withJev(
		() => ({ status: 200, body: routingAnswer("heavy", 0.82, { tools: 0.93, stakes: 1.7 }) }),
		async (client, server) => {
			const result = await client.ask({ request: "why does this deadlock?" }, routingQuestions());

			// Request: the endpoint, the credential, and the three questions src/state.ts asks.
			assert.equal(server.requests.length, 1);
			const sent = server.requests[0]!;
			assert.match(sent.path, /\/systemone$/);
			assert.equal(sent.authorization, "Bearer test-key");
			assert.equal(sent.body.model, DEFAULT_CONFIG.jev.model);
			assert.deepEqual(Object.keys(sent.body.questions).sort(), ["needs_tools", "stakes", "tier"]);
			assert.equal(sent.body.questions.tier!.type, "choice");

			// Response: parsed, timed, and priced at the TypeSafe list rate.
			assert.equal(result.transport, "typesafe");
			assert.equal((result.answers.tier as { choice: string }).choice, "heavy");
			assert.ok(result.ms >= 0);
			assert.ok(Math.abs(result.costUsd - 450 * (0.042 / 1_000_000)) < 1e-12, `unexpected cost ${result.costUsd}`);
		},
	);
});

test("a 429 with a short retry-after is retried once; a hard error surfaces the server's message", async () => {
	// Retry: first call 429s with a retry-after inside the timeout, second succeeds.
	await withJev(
		(_req, i) => (i === 0 ? { status: 429, body: {}, headers: { "retry-after": "0.05" } } : { status: 200, body: routingAnswer("light", 0.7) }),
		async (client, server) => {
			const result = await client.ask({ request: "ls" }, routingQuestions());
			assert.equal(server.requests.length, 2, "a retryable 429 should be retried exactly once");
			assert.equal((result.answers.tier as { choice: string }).choice, "light");
		},
	);

	// Edge case worth knowing about: `retry-after: 0` is a valid header meaning "retry
	// immediately", and src/jev.ts's guard is `retryAfter > 0`, so it is *not* retried.
	// Recorded rather than worked around; changing it belongs to src/.
	await withJev(
		(_req, i) => (i === 0 ? { status: 429, body: {}, headers: { "retry-after": "0" } } : { status: 200, body: routingAnswer("light", 0.7) }),
		async (client, server) => {
			await client.ask({ request: "ls" }, routingQuestions()).catch(() => undefined);
			assert.equal(server.requests.length, 1, "src/jev.ts changed how it treats retry-after: 0");
		},
	);

	// Hard error: the server's own message is surfaced rather than a generic status.
	await withJev(
		() => ({ status: 402, body: { error: { type: "customer_verification_required", message: "add a card" } } }),
		async (client) => {
			const err = await client.ask({ request: "x" }, routingQuestions()).then(
				() => undefined,
				(e: unknown) => e,
			);
			assert.ok(err instanceof JevError, "a non-ok response should raise JevError");
			assert.equal(err.status, 402);
			assert.match(err.message, /TypeSafe 402 customer_verification_required: add a card/);
		},
	);

	// A 429 whose retry-after exceeds the timeout is not retried.
	await withJev(
		() => ({ status: 429, body: {}, headers: { "retry-after": "3600" } }),
		async (client, server) => {
			await client.ask({ request: "x" }, routingQuestions()).catch(() => undefined);
			assert.equal(server.requests.length, 1, "a long retry-after should not be waited on");
		},
	);
});

test("the eval's live classifier drives a whole run through real HTTP", async () => {
	const answers: Record<string, ["light" | "standard" | "heavy", number]> = {};
	await withJev(
		(req, i) => {
			// Answer from the prompt the harness actually built, so the run is driven by
			// what src/state.ts serialised rather than by the fixture.
			const state = req.body.state as { request?: string };
			const heavy = /race|deadlock|smuggl|redesign|concurren/i.test(state.request ?? "");
			const tier = heavy ? ("heavy" as const) : ("standard" as const);
			answers[String(i)] = [tier, 0.77];
			return { status: 200, body: routingAnswer(tier, 0.77) };
		},
		async (client, server) => {
			const loaded = loadFleet(FLEET);
			const outcome = await runEval({ pack: pack(), loaded, classifier: "live", jev: client });
			const metrics = computeMetrics(outcome.turns, outcome.stateChars);

			const routed = outcome.turns.filter((t) => !t.pinned);
			assert.equal(server.requests.length, routed.length, "one classifier call per routed turn, and none for pinned ones");
			assert.equal(metrics.ineligibleChoices, 0);
			assert.equal(metrics.heuristicFallbacks, 0, "a healthy endpoint should never fall through to the heuristic");

			// The state that went over the wire is the one src/state.ts builds.
			const sent = server.requests[0]!.body.state as { request: string; recent: unknown[]; session: { turn: number; current_model: string } };
			assert.ok(sent.request.length > 0);
			assert.equal(sent.session.turn, 1);
			assert.ok(sent.session.current_model.startsWith("faux-"));

			// And every routed turn was billed the endpoint's reported cost.
			for (const turn of routed) assert.ok(turn.classifierCostUsd > 0);
			assert.ok(metrics.classifierCostUsd > 0);
		},
	);
});

test("a live classifier that starts failing falls through to the heuristic without stopping the run", async () => {
	await withJev(
		(_req, i) => (i < 3 ? { status: 200, body: routingAnswer("standard", 0.8) } : { status: 500, body: { error: { message: "upstream down" } } }),
		async (client) => {
			const loaded = loadFleet(FLEET);
			const outcome = await runEval({ pack: pack(), loaded, classifier: "live", jev: client });
			const metrics = computeMetrics(outcome.turns, outcome.stateChars);

			assert.ok(metrics.heuristicFallbacks > 0, "the outage should be visible as fallbacks");
			assert.ok(metrics.heuristicFallbacks < metrics.routedTurns, "...and the calls before it should still have counted");
			assert.equal(metrics.ineligibleChoices, 0, "an outage must not produce an invalid route");
			for (const turn of outcome.turns.filter((t) => t.classifierSource === "heuristic")) {
				assert.equal(turn.classifierCostUsd, 0, "a failed call is not billed");
			}
		},
	);
});

test("--record writes back exactly what the endpoint said", async () => {
	await withJev(
		(req) => {
			const state = req.body.state as { request?: string };
			const tier = /test|document|print|show me/i.test(state.request ?? "") ? ("light" as const) : ("heavy" as const);
			return { status: 200, body: routingAnswer(tier, 0.64, { tools: 0.51, stakes: 1.93 }) };
		},
		async (client) => {
			const original = pack();
			const loaded = loadFleet(FLEET);
			const outcome = await runEval({ pack: original, loaded, classifier: "live", jev: client });
			const result = recordAnswers(original, outcome.turns);

			assert.ok(result.recorded > 20);
			const byTurn = new Map(outcome.turns.map((t) => [`${t.taskId}#${t.turn}`, t]));
			for (const [i, task] of result.pack.tasks.entries()) {
				for (const [j, turn] of task.turns.entries()) {
					const before = original.tasks[i]!.turns[j]!;
					assert.equal(turn.prompt, before.prompt, "recording must not touch the prompts");
					assert.equal(turn.requiredSkill, before.requiredSkill, "...or the declared ground truth");
					const record = byTurn.get(`${task.id}#${j + 1}`)!;
					if (record.pinned) continue;
					// The recorded answer is the endpoint's, rounded to two places.
					assert.equal(turn.jev!.confidence, 0.64);
					assert.equal(turn.jev!.needsTools, 0.51);
					assert.equal(turn.jev!.stakes, 1.93);
					assert.equal(turn.jev!.tier, record.classifierAnswer!.tier);
				}
			}
		},
	);
});

test("the Jev judge sends src/parallel.ts's question and reads its choice", async () => {
	await withJev(
		() => ({ status: 200, body: judgeAnswer("B", 0.71, ["A", "B", "C"]) }),
		async (client, server) => {
			const judge = new JevJudge(client, DEFAULT_CONFIG.parallel.maxResponseCharsForJudge);
			const verdict = await judge.pick("fix the race", [
				{ label: "A", key: "x/a", text: "a".repeat(9000), trueSkill: 50 },
				{ label: "B", key: "x/b", text: "bee", trueSkill: 80 },
				{ label: "C", key: "x/c", text: "sea", trueSkill: 60 },
			]);

			assert.equal(verdict.pick, "B");
			assert.equal(verdict.confidence, 0.71);
			assert.ok(verdict.costUsd > 0);

			const sent = server.requests[0]!.body;
			assert.deepEqual(Object.keys(sent.questions), ["best"]);
			assert.deepEqual(Object.keys((sent.questions.best as { criteria: Record<string, string> }).criteria), ["A", "B", "C"]);
			const state = sent.state as { request: string; responses: Record<string, string> };
			assert.equal(state.request, "fix the race");
			// Long responses are truncated to the configured budget before being sent.
			assert.equal(state.responses.A!.length, DEFAULT_CONFIG.parallel.maxResponseCharsForJudge);
			assert.equal(state.responses.B, "bee");
		},
	);
});
