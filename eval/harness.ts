/**
 * The run loop.
 *
 * One task = one pi session. Each turn reproduces what src/index.ts does in
 * `before_agent_start`, in the same order and with the same code:
 *
 *   turn++ -> manual pin check -> buildRoutingState -> classify -> stakes override
 *          -> chooseModel -> setModel -> thinking level -> record usage
 *
 * Everything that decides is imported from src/. The harness only supplies the
 * world (a fleet, a conversation, a clock-free cost model) and writes down what
 * happened.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelKey, type RouterConfig, type ThinkingLevel } from "../src/config.ts";
import type { JevClient } from "../src/jev.ts";
import { Ledger } from "../src/ledger.ts";
import { chooseModel, type Decision } from "../src/router.ts";
import { buildRoutingState } from "../src/state.ts";
import { applyStakesOverride, classify } from "./classifier.ts";
import { type Judge, type JudgeCandidate, NoisyJudge, pickCandidates, syntheticResponse } from "./candidates.ts";
import type { LoadedFleet } from "./fleet.ts";
import { FakeSession } from "./session.ts";
import { DEFAULT_TRAFFIC, effectiveSkill, simulateFanoutUsage, simulateTurnUsage, solves, type TrafficProfile } from "./simulate.ts";
import { cheapestCapableTier } from "./validate.ts";
import type { CandidateOutcome, CandidateTurnRecord, ClassifierMode, EvalTask, FleetModel, TaskPack, TurnRecord } from "./types.ts";

export interface RunOptions {
	pack: TaskPack;
	loaded: LoadedFleet;
	classifier: ClassifierMode;
	/** Model the session starts on, as a real pi session would. */
	startModel?: string;
	/** 0 disables candidate-selection mode. */
	candidateN?: number;
	judge?: Judge;
	judgeNoise?: number;
	seed?: string;
	jev?: JevClient;
	ledgerFile?: string;
	/** Overrides the measured calls/growth/output profile the cost model rests on. */
	traffic?: TrafficProfile;
	signal?: AbortSignal;
}

export interface RunOutcome {
	turns: TurnRecord[];
	tasks: { id: string; resolved: boolean; turns: number }[];
	ledger: Ledger;
	/** Serialized size of the state the classifier is handed, per turn. */
	stateChars: number[];
	config: RouterConfig;
	startModel: string;
}

const DEFAULT_START_MODEL = "faux-plan-anthropic/claude-opus-5";

export async function runEval(options: RunOptions): Promise<RunOutcome> {
	const { pack, loaded } = options;
	const cfg = loaded.config;
	const seed = options.seed ?? "swe-router-v1";
	const candidateN = options.candidateN ?? 0;
	const judge = options.judge ?? new NoisyJudge(options.judgeNoise ?? 10, seed);
	const startModelKey = options.startModel ?? DEFAULT_START_MODEL;
	const ledgerFile = options.ledgerFile ?? join(mkdtempSync(join(tmpdir(), "router-eval-")), "usage.json");
	// One ledger for the whole run: plan quota and cooldowns are account facts that
	// outlive a single session, so a 429 in one task must still steer the next.
	const ledger = new Ledger(ledgerFile);

	const turns: TurnRecord[] = [];
	const taskResults: RunOutcome["tasks"] = [];
	const stateChars: number[] = [];

	for (const task of pack.tasks) {
		const result = await runTask({ task, cfg, loaded, ledger, judge, candidateN, seed, startModelKey, options });
		turns.push(...result.turns);
		stateChars.push(...result.stateChars);
		taskResults.push({ id: task.id, resolved: result.turns.every((t) => t.solved), turns: result.turns.length });
	}

	ledger.save();
	return { turns, tasks: taskResults, ledger, stateChars, config: cfg, startModel: startModelKey };
}

interface TaskRunArgs {
	task: EvalTask;
	cfg: RouterConfig;
	loaded: LoadedFleet;
	ledger: Ledger;
	judge: Judge;
	candidateN: number;
	seed: string;
	startModelKey: string;
	options: RunOptions;
}

async function runTask(args: TaskRunArgs): Promise<{ turns: TurnRecord[]; stateChars: number[] }> {
	const { task, cfg, loaded, ledger, judge, candidateN, seed, startModelKey, options } = args;
	const { registry, byKey } = loaded;
	const session = new FakeSession();
	session.contextTokens = task.startContextTokens;
	session.model = findModel(loaded, startModelKey);

	let turnNo = 0;
	let pinnedUntilTurn = 0;
	let lastThinking: ThinkingLevel | undefined;
	let previousKey: string | undefined;
	const records: TurnRecord[] = [];
	const stateChars: number[] = [];

	for (const turn of task.turns) {
		// A /model pin lands between turns; src/index.ts stamps it with the turn count so far.
		if (turn.manualPin) {
			const pinned = findModel(loaded, turn.manualPin);
			if (pinned) session.model = pinned;
			pinnedUntilTurn = turnNo + cfg.switching.manualPinTurns;
		}

		turnNo += 1;
		session.addUser(turn.prompt);
		const contextTokens = session.contextTokens;
		const requiredSkill = turn.requiredSkill ?? task.requiredSkill;
		// Derived, not read from the fixture: the cheapest tier that can actually do this
		// turn is a fact about the fleet. A turn no model can do is scored against heavy.
		const goldTier = cheapestCapableTier(loaded, task.category, requiredSkill) ?? "heavy";
		const state = buildRoutingState(turn.prompt, session.asContext(), cfg, turnNo);
		stateChars.push(JSON.stringify(state).length);

		const isPinned = turnNo <= pinnedUntilTurn;
		let decision: Omit<Decision, "at" | "jevMs" | "jevModel" | "needsTools" | "stakes">;
		let classifierCostUsd = 0;
		let classifierSource: TurnRecord["classifierSource"] = "pinned";
		let requestedTier = goldTier;
		let confidence = 1;

		if (isPinned) {
			// src/index.ts returns before the Jev call, so a pinned turn costs nothing to route.
			decision = {
				requestedTier: goldTier,
				tier: goldTier,
				confidence: 1,
				model: session.model,
				switched: false,
				reason: `pinned ${session.model ? modelKey(session.model) : "none"}`,
				candidates: [],
			};
		} else {
			const classification = await classify({
				mode: options.classifier,
				turn: { ...turn, goldTier },
				prompt: turn.prompt,
				state,
				jev: options.jev,
				signal: options.signal,
			});
			classifierCostUsd = classification.costUsd;
			classifierSource = classification.source;
			requestedTier = applyStakesOverride(classification.tier, classification.stakes);
			confidence = classification.confidence;
			decision = chooseModel({
				tier: requestedTier,
				confidence,
				current: session.model,
				registry,
				cfg,
				ledger,
				contextTokens,
			});
			if (decision.model && decision.switched) session.model = decision.model;
		}

		const chosen = session.model;
		const chosenKey = chosen ? modelKey(chosen) : "none";
		const spec = byKey.get(chosenKey);
		const thinking = chosen?.reasoning ? cfg.thinking[decision.tier] : undefined;

		const coldCause = !previousKey
			? ("first-turn" as const)
			: previousKey !== chosenKey
				? ("model-switch" as const)
				: thinking !== lastThinking
					? ("thinking-change" as const)
					: undefined;

		const traffic = options.traffic ?? DEFAULT_TRAFFIC;
		const calls = task.callsPerTurn ?? traffic.callsPerTurn;
		const usageArgs = {
			contextTokens,
			calls,
			traffic,
			outputTokensPerCall: turn.expectedOutputTokens ? turn.expectedOutputTokens / calls : undefined,
		};
		const usage = spec ? simulateTurnUsage({ model: spec, cold: coldCause !== undefined, ...usageArgs }) : undefined;
		// The same turn priced warm, so the cold premium can be reported exactly.
		const warmUsage = spec ? simulateTurnUsage({ model: spec, cold: false, ...usageArgs }) : undefined;
		if (spec && usage) {
			const { provider, id } = splitModel(chosenKey);
			ledger.record(provider, id, usage.usage);
		}

		const eligibility = checkEligibility(chosen, loaded, ledger, cfg);
		const solved = spec ? solves(spec, task.category, requiredSkill) : false;
		const inTierAlternativeWouldSolve =
			!solved &&
			(cfg.tiers[decision.tier] ?? []).some((key) => {
				if (key === chosenKey || loaded.unauthed.has(key)) return false;
				const alt = loaded.byKey.get(key);
				return alt !== undefined && solves(alt, task.category, requiredSkill);
			});

		const record: TurnRecord = {
			taskId: task.id,
			turn: turnNo,
			goldTier,
			requestedTier,
			chosenTier: decision.tier,
			confidence,
			classifierSource,
			model: chosenKey,
			previousModel: previousKey,
			switched: previousKey !== undefined && previousKey !== chosenKey,
			pinned: isPinned,
			reason: decision.reason,
			eligible: eligibility.eligible,
			ineligibleReason: eligibility.reason,
			contextTokens,
			thinkingLevel: thinking,
			cold: coldCause !== undefined,
			coldCause,
			coldWriteTokens: usage?.coldWriteTokens ?? 0,
			ledgerCostUsd: usage?.ledgerCostUsd ?? 0,
			listEquivalentUsd: usage?.listEquivalentUsd ?? 0,
			warmListEquivalentUsd: warmUsage?.listEquivalentUsd ?? 0,
			classifierCostUsd,
			solved,
			effectiveSkill: spec ? effectiveSkill(spec, task.category) : 0,
			inTierAlternativeWouldSolve,
		};

		if (candidateN >= 2) {
			record.candidate = await runCandidateTurn({
				task,
				turn: turnNo,
				prompt: turn.prompt,
				requiredSkill,
				contextTokens,
				current: chosen,
				baselineSolved: solved,
				cfg,
				loaded,
				ledger,
				judge,
				candidateN,
				seed,
			});
		}

		records.push(record);
		session.addAssistant(`[${chosenKey}] ${classifierSource === "heuristic" ? "(heuristic route) " : ""}work on ${task.id}`, ["read", "edit"]);
		session.contextTokens += task.contextGrowthPerTurn;
		previousKey = chosenKey;
		lastThinking = thinking;

		if (turn.providerEvent) {
			ledger.observeResponse(turn.providerEvent.provider, turn.providerEvent.status, turn.providerEvent.headers, cfg);
		}
	}
	return { turns: records, stateChars };
}

interface CandidateTurnArgs {
	task: EvalTask;
	turn: number;
	prompt: string;
	requiredSkill: number;
	contextTokens: number;
	current: Model<Api> | undefined;
	baselineSolved: boolean;
	cfg: RouterConfig;
	loaded: LoadedFleet;
	ledger: Ledger;
	judge: Judge;
	candidateN: number;
	seed: string;
}

async function runCandidateTurn(args: CandidateTurnArgs): Promise<CandidateTurnRecord | undefined> {
	const { task, turn, prompt, requiredSkill, contextTokens, current, baselineSolved, cfg, loaded, ledger, judge, candidateN } = args;
	const specs = pickCandidates({ current, cfg, n: candidateN, byKey: loaded.byKey, unauthed: loaded.unauthed });
	if (specs.length < 2) return undefined;

	const outputTokens = cfg.switching.expectedOutputTokens;
	const outcomes: CandidateOutcome[] = [];
	const judgeInput: JudgeCandidate[] = [];

	specs.forEach((spec, i) => {
		const label = String.fromCharCode(65 + i);
		const usage = simulateFanoutUsage(spec, contextTokens, outputTokens);
		const { provider, id } = splitModel(spec.key);
		ledger.record(provider, id, usage.usage);
		const skill = effectiveSkill(spec, task.category);
		outcomes.push({
			key: spec.key,
			label,
			effectiveSkill: skill,
			solved: skill >= requiredSkill,
			judgeScore: 0,
			judgeProbability: 0,
			cold: true,
			ledgerCostUsd: usage.ledgerCostUsd,
			listEquivalentUsd: usage.listEquivalentUsd,
		});
		judgeInput.push({
			label,
			key: spec.key,
			trueSkill: skill,
			// List output price stands in for "looks like the flagship's answer".
			flashiness: spec.cost.output,
			text: syntheticResponse(spec, task.category, prompt),
		});
	});

	const verdict = await judge.pick(prompt, judgeInput, { taskId: task.id, turn });
	for (const o of outcomes) {
		o.judgeProbability = verdict.probabilities[o.label] ?? 0;
		o.judgeScore = o.judgeProbability;
	}
	const picked = outcomes.find((o) => o.label === verdict.pick);
	const oracleBest = outcomes.reduce((a, b) => (b.effectiveSkill > a.effectiveSkill ? b : a));

	return {
		candidates: outcomes,
		judgePick: picked?.key ?? "none",
		judgeConfidence: verdict.confidence,
		judgeSolved: picked?.solved ?? false,
		oracleBest: oracleBest.key,
		oracleSolved: oracleBest.solved,
		baselineSolved,
		judgeCostUsd: verdict.costUsd,
		fanoutLedgerCostUsd: outcomes.reduce((a, o) => a + o.ledgerCostUsd, 0),
		fanoutListEquivalentUsd: outcomes.reduce((a, o) => a + o.listEquivalentUsd, 0),
	};
}

function checkEligibility(
	model: Model<Api> | undefined,
	loaded: LoadedFleet,
	ledger: Ledger,
	cfg: RouterConfig,
): { eligible: boolean; reason?: string } {
	if (!model) return { eligible: false, reason: "no model chosen" };
	const key = modelKey(model);
	if (!loaded.byKey.has(key)) return { eligible: false, reason: "model is not in the fleet" };
	if (!loaded.registry.hasConfiguredAuth(model)) return { eligible: false, reason: "no auth" };
	const block = ledger.isBlocked(model.provider, cfg);
	if (block.blocked) return { eligible: false, reason: block.reason };
	return { eligible: true };
}

function findModel(loaded: LoadedFleet, key: string): Model<Api> | undefined {
	const { provider, id } = splitModel(key);
	return loaded.registry.find(provider, id);
}

function splitModel(key: string): { provider: string; id: string } {
	const slash = key.indexOf("/");
	return { provider: key.slice(0, slash), id: key.slice(slash + 1) };
}

export type { FleetModel };
