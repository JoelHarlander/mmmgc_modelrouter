#!/usr/bin/env node
/**
 * `npm run eval:all` — the whole standard eval, in one command.
 *
 * Validates both packs, runs the profile set, and prints one comparison table. Pass
 * `--gate` and it exits non-zero if any profile regressed past tolerance against its
 * own recorded baseline, which is the form a CI job or a pre-merge check wants.
 *
 * Everything here is offline: no flag in this file can reach a network.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunMetrics } from "./metrics.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "eval", "cli.ts");
const SHORT = join(ROOT, "eval", "tasks", "swe-router-v1.json");
const LONG = join(ROOT, "eval", "tasks", "swe-router-long-v1.json");

interface Profile {
	label: string;
	args: string[];
}

const PROFILES: Profile[] = [
	{ label: "short / scripted", args: ["--pack", SHORT] },
	{ label: "short / heuristic", args: ["--pack", SHORT, "--classifier", "heuristic"] },
	{ label: "short / oracle", args: ["--pack", SHORT, "--classifier", "oracle"] },
	{ label: "short / candidates 3", args: ["--pack", SHORT, "--candidates", "3"] },
	{ label: "long / scripted", args: ["--pack", LONG] },
	{ label: "long / heuristic", args: ["--pack", LONG, "--classifier", "heuristic"] },
	{ label: "long / oracle", args: ["--pack", LONG, "--classifier", "oracle"] },
	{ label: "long / candidates 3", args: ["--pack", LONG, "--candidates", "3"] },
];

interface Row {
	label: string;
	profile: string;
	metrics: RunMetrics;
	gateFailures: { key: string; previous: number; current: number }[];
	code: number;
}

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
	const result = spawnSync("node", ["--import", "tsx", CLI, ...args], { cwd: ROOT, encoding: "utf8" });
	return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function main(): number {
	const passthrough = process.argv.slice(2);
	const gate = passthrough.includes("--gate");

	for (const pack of [SHORT, LONG]) {
		const { code, stdout, stderr } = runCli(["--pack", pack, "--validate"]);
		process.stdout.write(stdout);
		if (code !== 0) {
			process.stderr.write(stderr);
			process.stderr.write("ground truth is inconsistent; refusing to run the suite\n");
			return 2;
		}
	}

	const rows: Row[] = [];
	for (const profile of PROFILES) {
		const { code, stdout, stderr } = runCli([...profile.args, ...passthrough, "--json"]);
		let parsed: { profile: string; metrics: RunMetrics; gateFailures?: Row["gateFailures"] };
		try {
			parsed = JSON.parse(stdout) as typeof parsed;
		} catch {
			process.stderr.write(`${profile.label}: could not read the run record\n${stderr}`);
			return 1;
		}
		rows.push({ label: profile.label, profile: parsed.profile, metrics: parsed.metrics, gateFailures: parsed.gateFailures ?? [], code });
		if (stderr.trim()) process.stderr.write(`${stderr.trim()}\n`);
	}

	process.stdout.write(render(rows));

	const failed = rows.filter((r) => r.code !== 0);
	if (failed.length > 0) {
		process.stderr.write(`\n${failed.length} profile(s) failed:\n`);
		for (const row of failed) {
			const why = row.code === 1 ? "routed to an ineligible model" : row.gateFailures.map((f) => f.key).join(", ") || `exit ${row.code}`;
			process.stderr.write(`  ${row.label}: ${why}\n`);
		}
		return failed.some((r) => r.code === 1) ? 1 : 3;
	}
	if (gate) process.stdout.write("gate: no regressions against the recorded baselines\n\n");
	return 0;
}

function render(rows: Row[]): string {
	const out: string[] = ["", "router eval — all profiles", ""];
	out.push("  profile                turn   session   tier acc   in-tier   ineligible      list $   plan pts   cold   cold prem   adopted lift");
	for (const row of rows) {
		const m = row.metrics;
		const lift = m.candidate ? signedPct(m.candidate.adoptedLift) : "—";
		out.push(
			`  ${row.label.padEnd(20)} ${pct(m.turnSuccessRate).padStart(6)}   ${pct(m.sessionSuccessRate).padStart(7)}   ${pct(m.tierAccuracy).padStart(8)}   ${String(m.inTierMisses).padStart(7)}   ` +
				`${String(m.ineligibleChoices).padStart(10)}   ${usd(m.listEquivalentUsd).padStart(9)}   ${m.planPointsUsed.toFixed(2).padStart(8)}   ` +
				`${`${m.coldTurns}/${m.turns}`.padStart(5)}   ${usd(m.coldPremiumUsd).padStart(9)}   ${lift.padStart(12)}`,
		);
	}
	out.push("");
	out.push(`  results in eval/results/ — see log.md for what each round measured and changed.`);
	out.push("");
	return `${out.join("\n")}\n`;
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function signedPct(n: number): string {
	return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}pp`;
}

function usd(n: number): string {
	return Number.isFinite(n) ? `$${n.toFixed(2)}` : "n/a";
}

process.exitCode = main();
