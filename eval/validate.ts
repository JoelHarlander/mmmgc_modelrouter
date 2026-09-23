/**
 * Ground-truth invariants for a task pack.
 *
 * Round 1 measured a pack whose `goldTier` labels disagreed with its own
 * `requiredSkill` numbers: turns marked `light` needed a skill no light model has,
 * so a correct classification scored worse than a crude one that over-routed
 * everything. A pack that punishes correctness cannot judge a router.
 *
 * The invariant that fixes it: **goldTier is the cheapest tier that contains a model
 * able to do the turn.** That is also the only definition under which "the router
 * chose the gold tier" and "the router spent as little as the work allows" are the
 * same statement.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TIERS } from "../src/config.ts";
import type { Tier } from "../src/config.ts";
import { Ledger } from "../src/ledger.ts";
import { chooseModel } from "../src/router.ts";
import type { LoadedFleet } from "./fleet.ts";
import { effectiveSkill, simulateTurnUsage } from "./simulate.ts";
import type { EvalTask, TaskPack, TaskTurn } from "./types.ts";

export interface PackProblem {
	level: "error" | "warning";
	where: string;
	message: string;
}

/** The cheapest tier holding a model that can do this turn, or undefined if none can. */
export function cheapestCapableTier(loaded: LoadedFleet, category: string, requiredSkill: number): Tier | undefined {
	for (const tier of TIERS) {
		const capable = (loaded.config.tiers[tier] ?? []).some((key) => {
			if (loaded.unauthed.has(key)) return false;
			const spec = loaded.byKey.get(key);
			return spec !== undefined && effectiveSkill(spec, category) >= requiredSkill;
		});
		if (capable) return tier;
	}
	return undefined;
}

export function validatePack(pack: TaskPack, loaded: LoadedFleet): PackProblem[] {
	const problems: PackProblem[] = [];
	const seen = new Set<string>();

	for (const tier of TIERS) {
		for (const key of loaded.config.tiers[tier] ?? []) {
			if (!loaded.byKey.has(key)) problems.push({ level: "error", where: `fleet.tiers.${tier}`, message: `${key} is not in the fleet` });
		}
	}
	problems.push(...checkTierPricing(loaded));

	for (const task of pack.tasks) {
		if (seen.has(task.id)) problems.push({ level: "error", where: task.id, message: "duplicate task id" });
		seen.add(task.id);
		if (task.turns.length === 0) problems.push({ level: "error", where: task.id, message: "task has no turns" });
		task.turns.forEach((turn, i) => problems.push(...validateTurn(task, turn, i, loaded)));
	}
	return problems;
}

function validateTurn(task: EvalTask, turn: TaskTurn, index: number, loaded: LoadedFleet): PackProblem[] {
	const where = `${task.id} turn ${index + 1}`;
	const problems: PackProblem[] = [];
	const requiredSkill = turn.requiredSkill ?? task.requiredSkill;
	const expected = cheapestCapableTier(loaded, task.category, requiredSkill);

	if (!expected) {
		problems.push({
			level: "warning",
			where,
			message: `requiredSkill ${requiredSkill} is beyond every model in the fleet: this turn can never be solved`,
		});
	} else if (turn.goldTier !== undefined && expected !== turn.goldTier) {
		problems.push({
			level: "error",
			where,
			message: `goldTier says "${turn.goldTier}" but requiredSkill ${requiredSkill} (category ${task.category}) is first met in "${expected}"`,
		});
	}

	if (turn.jev) {
		if (!TIERS.includes(turn.jev.tier)) problems.push({ level: "error", where, message: `jev.tier "${turn.jev.tier}" is not a tier` });
		if (turn.jev.confidence < 0 || turn.jev.confidence > 1) {
			problems.push({ level: "error", where, message: `jev.confidence ${turn.jev.confidence} is outside 0..1` });
		}
		if (turn.jev.stakes !== undefined && (turn.jev.stakes < 0 || turn.jev.stakes > 2)) {
			problems.push({ level: "error", where, message: `jev.stakes ${turn.jev.stakes} is outside the 0..2 range src/state.ts's three criteria produce` });
		}
		if (turn.jev.needsTools !== undefined && (turn.jev.needsTools < 0 || turn.jev.needsTools > 1)) {
			problems.push({ level: "error", where, message: `jev.needsTools ${turn.jev.needsTools} is outside 0..1` });
		}
	}

	if (turn.manualPin && !loaded.byKey.has(turn.manualPin)) {
		problems.push({ level: "error", where, message: `manualPin ${turn.manualPin} is not in the fleet` });
	}
	return problems;
}

/** Context size the tier price comparison is taken at; near this fleet's median turn. */
export const PRICE_REFERENCE_TOKENS = 100_000;

/**
 * Tiers are supposed to be a cost ladder: heavier means more expensive, so trading up
 * is a decision the router has to justify. When a heavier tier is *cheaper* than a
 * lighter one, every quality-vs-spend reading inverts and over-routing becomes free.
 * This is a warning rather than an error because the shipped defaults have exactly
 * this shape at published prices — gpt-6-astra (standard, $10/$50) costs twice
 * claude-opus-5 (heavy, $5/$25) — and the eval should report it, not refuse to run.
 */
export function checkTierPricing(loaded: LoadedFleet): PackProblem[] {
	const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "router-eval-price-")), "usage.json"));
	const picks = TIERS.map((tier) => {
		// The router's own comparator, not "cheapest at list": plan routes price at $0,
		// which is exactly how a tier can end up preferring an expensive model.
		const decision = chooseModel({
			tier,
			confidence: 1,
			current: undefined,
			registry: loaded.registry,
			cfg: loaded.config,
			ledger,
			contextTokens: PRICE_REFERENCE_TOKENS,
		});
		if (!decision.model || decision.tier !== tier) return { tier, pick: undefined };
		const key = `${decision.model.provider}/${decision.model.id}`;
		const spec = loaded.byKey.get(key);
		if (!spec) return { tier, pick: undefined };
		return { tier, pick: { key, usd: simulateTurnUsage({ model: spec, contextTokens: PRICE_REFERENCE_TOKENS, cold: false }).listEquivalentUsd } };
	});

	const problems: PackProblem[] = [];
	for (let i = 1; i < picks.length; i++) {
		const prev = picks[i - 1]!;
		const cur = picks[i]!;
		if (!prev.pick || !cur.pick) continue;
		if (cur.pick.usd < prev.pick.usd) {
			problems.push({
				level: "warning",
				where: `fleet.tiers.${cur.tier}`,
				message:
					`tier price inversion: the router prefers ${cur.pick.key} in ${cur.tier} ($${cur.pick.usd.toFixed(4)} per warm turn at ` +
					`${PRICE_REFERENCE_TOKENS / 1000}k context) over ${prev.pick.key} in the lighter ${prev.tier} tier ($${prev.pick.usd.toFixed(4)}), ` +
					"so escalating one tier makes the turn cheaper and every quality-vs-spend reading inverts",
			});
		}
	}
	return problems;
}

export function formatProblems(problems: PackProblem[]): string {
	return problems.map((p) => `  ${p.level === "error" ? "error" : "warn "}  ${p.where}: ${p.message}`).join("\n");
}
