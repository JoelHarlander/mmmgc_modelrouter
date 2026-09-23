/**
 * `--explain <task>` — the turn-by-turn trace behind one task's score.
 *
 * After seventeen rounds the harness reports a great many numbers and, until now, gave
 * no way to see *why* any single one came out as it did. Every round that found a bug
 * in the measurement found it by dropping into an ad-hoc script; this is that script,
 * made part of the tool.
 *
 * It renders exactly what the run recorded — no re-simulation — so what it shows is
 * what was scored.
 */
import type { TurnRecord } from "./types.ts";

export function explainTask(turns: TurnRecord[], taskId: string): string {
	const matching = turns.filter((t) => t.taskId === taskId);
	if (matching.length === 0) {
		const known = [...new Set(turns.map((t) => t.taskId))];
		return `no task "${taskId}" in this run. Known tasks:\n${known.map((k) => `  ${k}`).join("\n")}\n`;
	}

	const out: string[] = ["", `${taskId}  —  ${matching.length} turns, ${matching.filter((t) => t.solved).length} solved`, ""];
	for (const turn of matching) {
		out.push(...explainTurn(turn));
		out.push("");
	}

	const totalList = matching.reduce((a, t) => a + t.listEquivalentUsd + (t.compaction?.listEquivalentUsd ?? 0), 0);
	const totalLedger = matching.reduce((a, t) => a + t.ledgerCostUsd + (t.compaction?.ledgerCostUsd ?? 0), 0);
	const cold = matching.filter((t) => t.cold).length;
	out.push(
		`  total: $${totalList.toFixed(4)} at list, $${totalLedger.toFixed(4)} to the ledger, ` +
			`${cold}/${matching.length} cold, ${matching.filter((t) => t.switched).length} switches`,
	);
	out.push("");
	return `${out.join("\n")}\n`;
}

function explainTurn(t: TurnRecord): string[] {
	const out: string[] = [];
	const verdict = t.solved ? "SOLVED" : "FAILED";
	out.push(`  turn ${t.turn}  ${verdict}`);
	out.push(`    prompt        ${truncate(t.prompt ?? "", 96)}`);

	// How the tier was decided.
	if (t.pinned) {
		out.push(`    routing       ${t.committed ? "committed" : "pinned"} — the classifier was not consulted`);
	} else {
		const answer = t.classifierAnswer;
		const said = answer ? `${answer.tier} @ ${(answer.confidence * 100).toFixed(0)}%` : `${t.requestedTier} @ ${(t.confidence * 100).toFixed(0)}%`;
		const override = answer && answer.tier !== t.requestedTier ? ` → ${t.requestedTier} (stakes override)` : "";
		out.push(`    classifier    ${t.classifierSource} said ${said}${override}`);
	}
	const tierNote = t.effectiveTier === t.goldTier ? "matches gold" : `gold was ${t.goldTier}`;
	out.push(`    tier          landed ${t.effectiveTier} (${tierNote}); router reported ${t.chosenTier}`);
	out.push(`    model         ${t.model}${t.switched ? `  (switched from ${t.previousModel})` : ""}${t.eligible ? "" : `  INELIGIBLE: ${t.ineligibleReason}`}`);

	// Why it did or did not work.
	const margin = t.effectiveSkill - t.requiredSkill;
	const penalty = t.compactionPenalty > 0 ? `, ${t.requiredSkill - t.compactionPenalty} + ${t.compactionPenalty} for lost context` : "";
	out.push(`    competence    skill ${t.effectiveSkill} vs required ${t.requiredSkill}${penalty} → ${margin >= 0 ? `+${margin.toFixed(1)}` : margin.toFixed(1)}`);
	if (!t.solved && t.inTierAlternativeWouldSolve) out.push("                  another model in this tier would have solved it");

	// What it cost, and why it cost that.
	if (t.compaction) {
		out.push(
			`    compaction    ${t.compaction.tokensBefore.toLocaleString("en-US")} → ${t.compaction.tokensAfter.toLocaleString("en-US")} tokens, ` +
				`$${t.compaction.listEquivalentUsd.toFixed(4)}${t.compaction.avoidable ? "  (a roomier model would not have)" : ""}`,
		);
	}
	const cache = t.cold ? `cold (${t.coldCause}), rewrote ${t.coldWriteTokens.toLocaleString("en-US")} tokens` : "warm";
	out.push(`    cache         ${cache}; thinking ${t.thinkingLevel ?? "-"}`);
	out.push(
		`    cost          $${t.listEquivalentUsd.toFixed(4)} at list ($${t.warmListEquivalentUsd.toFixed(4)} if warm), ` +
			`$${t.ledgerCostUsd.toFixed(4)} to the ledger`,
	);

	if (t.candidate) {
		const c = t.candidate;
		const line = c.candidates
			.map((o) => `${o.label}:${o.key.split("/").pop()}${o.solved ? "✓" : "✗"} p=${o.judgeProbability.toFixed(2)}`)
			.join("  ");
		out.push(`    fan-out       ${line}`);
		out.push(
			`                  judge picked ${c.judgePick.split("/").pop()} @ ${(c.judgeConfidence * 100).toFixed(0)}%` +
				`${c.gated ? " — GATED, kept the routed answer" : ""}; best available was ${c.oracleBest.split("/").pop()}` +
				`; adopted ${c.adoptedSolved ? "solved" : "failed"}`,
		);
	}
	return out;
}

function truncate(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
