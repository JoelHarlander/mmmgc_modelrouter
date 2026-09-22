#!/usr/bin/env node
/**
 * `npm run eval` — run the SWE-bench-style router eval and write a results file.
 *
 * Offline and deterministic by default: no network, no credential, no spend.
 * `--classifier live` is the only mode that leaves the machine, and it refuses to
 * run unless both the flag and ROUTER_EVAL_LIVE=1 are set.
 *
 *   npm run eval                          # offline, scripted classifier
 *   npm run eval -- --classifier heuristic
 *   npm run eval -- --candidates 3        # candidate-selection mode
 *   npm run eval -- --compare eval/results/latest-scripted.json
 *   npm run eval -- --json                # machine-readable summary on stdout
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { JevClient } from "../src/jev.ts";
import { JevJudge, NoisyJudge } from "./candidates.ts";
import { auditConfig, renderAudit } from "./audit.ts";
import { computeCalibration, renderCalibration } from "./calibration.ts";
import { loadProbePack, renderProbe, runProbe } from "./probe.ts";
import { loadFleet } from "./fleet.ts";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { runEval } from "./harness.ts";
import { computeMetrics, type RunMetrics } from "./metrics.ts";
import { DEFAULT_TRAFFIC } from "./simulate.ts";
import {
	appendLog,
	compareMetrics,
	ensureDirFor,
	gateRegressions,
	latestPath,
	readRun,
	resultsDir,
	type RunRecord,
	writeRun,
} from "./results.ts";
import {
	renderConfidenceSweep,
	renderGateSweep,
	renderOracleSweep,
	renderPolicySweep,
	renderSweep,
	renderTrafficSweep,
	runConfidenceSweep,
	runJudgeSweep,
	runOracleSweep,
	runPolicySweep,
	runTrafficSweep,
} from "./sweep.ts";
import { formatProblems, validatePack } from "./validate.ts";
import type { ClassifierMode, TaskPack } from "./types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Args {
	pack: string;
	fleet: string;
	classifier: ClassifierMode;
	candidates: number;
	judgeNoise: number;
	seed: string;
	startModel?: string;
	unauthed: string[];
	compare?: string;
	profile?: string;
	json: boolean;
	note?: string;
	noWrite: boolean;
	validateOnly: boolean;
	auditConfig: boolean;
	auditLocal: boolean;
	allowInconsistent: boolean;
	gate: boolean;
	gateTolerance: number;
	sweep?: "judge" | "bias" | "profile" | "oracle" | "gate" | "policy" | "confidence";
	calibration: boolean;
	candidatePolicy?: string;
	judgeMinConfidence?: number;
	callsPerTurn?: number;
	probe: boolean;
	probePack: string;
	liveJudge: boolean;
	judgeBias: number;
	help: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		pack: join(ROOT, "eval", "tasks", "swe-router-v1.json"),
		fleet: join(ROOT, "eval", "tasks", "fleet.json"),
		classifier: "scripted",
		candidates: 0,
		judgeNoise: 10,
		seed: "swe-router-v1",
		unauthed: [],
		json: false,
		noWrite: false,
		validateOnly: false,
		auditConfig: false,
		calibration: false,
		auditLocal: false,
		allowInconsistent: false,
		gate: false,
		gateTolerance: 1,
		judgeBias: 0,
		probe: false,
		probePack: join(ROOT, "eval", "tasks", "judge-probe-v1.json"),
		liveJudge: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${arg} needs a value`);
			return v;
		};
		switch (arg) {
			case "--pack":
				args.pack = abs(next());
				break;
			case "--fleet":
				args.fleet = abs(next());
				break;
			case "--classifier":
				args.classifier = next() as ClassifierMode;
				break;
			case "--candidates":
				args.candidates = Number(next());
				break;
			case "--judge-noise":
				args.judgeNoise = Number(next());
				break;
			case "--judge-bias":
				args.judgeBias = Number(next());
				break;
			case "--candidate-policy":
				args.candidatePolicy = next();
				break;
			case "--judge-min-confidence":
				args.judgeMinConfidence = Number(next());
				break;
			case "--sweep":
				args.sweep = next() as Args["sweep"];
				break;
			case "--calls-per-turn":
				args.callsPerTurn = Number(next());
				break;
			case "--probe":
				args.probe = true;
				break;
			case "--probe-pack":
				args.probePack = abs(next());
				break;
			case "--live-judge":
				args.liveJudge = true;
				break;
			case "--seed":
				args.seed = next();
				break;
			case "--start-model":
				args.startModel = next();
				break;
			case "--no-auth":
				args.unauthed.push(next());
				break;
			case "--compare":
				args.compare = abs(next());
				break;
			case "--profile":
				args.profile = next();
				break;
			case "--note":
				args.note = next();
				break;
			case "--json":
				args.json = true;
				break;
			case "--no-write":
				args.noWrite = true;
				break;
			case "--validate":
				args.validateOnly = true;
				break;
			case "--calibration":
				args.calibration = true;
				break;
			case "--audit-config":
				args.auditConfig = true;
				break;
			case "--audit-local":
				args.auditConfig = true;
				args.auditLocal = true;
				break;
			case "--allow-inconsistent":
				args.allowInconsistent = true;
				break;
			case "--gate":
				args.gate = true;
				break;
			case "--gate-tolerance":
				args.gateTolerance = Number(next());
				break;
			case "-h":
			case "--help":
				args.help = true;
				break;
			default:
				throw new Error(`unknown argument ${arg}`);
		}
	}
	return args;
}

function abs(p: string): string {
	return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/**
 * `--sweep bias` prices judge bias; the probe measures how much of it a judge has.
 * Offline it runs the stand-in judge (which is how the probe itself is tested);
 * `--live-judge` points it at real Jev for a fraction of a cent and no model inference.
 */
async function runProbeCommand(args: Args): Promise<number> {
	const probePack = loadProbePack(args.probePack);
	let judge: JevJudge | NoisyJudge;
	if (args.liveJudge) {
		const cfg = loadFleet(args.fleet).config;
		const jev = new JevClient(cfg.jev);
		if (!jev.available()) {
			process.stderr.write(`--live-judge needs a Jev credential: ${jev.describe()}\n`);
			return 2;
		}
		process.stderr.write(`LIVE: ${probePack.items.length * 2} judge calls via ${jev.describe()}\n`);
		judge = new JevJudge(jev, cfg.parallel.maxResponseCharsForJudge);
	} else {
		judge = new NoisyJudge({ noise: args.judgeNoise, seed: args.seed, bias: args.judgeBias });
	}

	const report = await runProbe(judge, probePack);
	if (args.json) process.stdout.write(`${JSON.stringify(report, null, "\t")}\n`);
	else process.stdout.write(renderProbe(report));
	if (!args.noWrite) {
		const name = `probe-${args.liveJudge ? "jev" : "offline"}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${shortGit()}.json`;
		const path = join(resultsDir(ROOT), name);
		ensureDirFor(path);
		writeFileSync(path, `${JSON.stringify({ probePack: probePack.id, ...report }, null, "\t")}\n`);
		process.stderr.write(`wrote ${path.replace(`${ROOT}/`, "")}\n`);
	}
	return 0;
}

const HELP = `router eval — SWE-bench-style measurement of the model switcher

  --pack <file>          task pack (default eval/tasks/swe-router-v1.json)
  --fleet <file>         model fleet (default eval/tasks/fleet.json)
  --classifier <mode>    scripted | heuristic | oracle | live   (default scripted)
  --candidates <n>       run n candidates per turn and let a judge pick (0 = off)
  --judge-noise <n>      offline judge error half-width in skill points (default 10)
  --judge-bias <n>       skill points the judge hands the flashiest candidate regardless
  --sweep judge          sweep candidate count x judge noise x seed and print the lift curve
  --sweep bias           sweep the judge's preference for the flashy candidate
  --sweep profile        sweep the measured traffic constants the cost model rests on
  --sweep oracle         jitter the declared model skills and see which findings survive
  --sweep gate           sweep the confidence bar src/parallel.ts auto-adopts above
  --sweep policy         compare the shipped candidate set against alternatives
  --sweep confidence     sweep switching.minConfidence, the routing bar
  --calibration          is the classifier's confidence worth anything?
  --candidate-policy <p> shipped | strongest | cheapest | spread | tier-top
  --judge-min-confidence <c>  that bar (default: switching.minConfidence)
  --calls-per-turn <n>   provider calls per user turn (default 5, the measured median)
  --probe                measure a judge's presentation bias on paired responses and exit
  --probe-pack <file>    probe pack (default eval/tasks/judge-probe-v1.json)
  --live-judge           run the probe against real Jev instead of the offline judge
  --seed <s>             deterministic seed for the offline judge
  --start-model <key>    model each task session starts on
  --no-auth <key>        mark a fleet model unauthed (repeatable)
  --compare <file>       compare against this results file instead of latest-<profile>
  --profile <name>       results profile name (default derived from the flags)
  --note <text>          one-line round note appended to eval/results/log.md
  --json                 print the run record as JSON instead of a table
  --no-write             do not write a results file
  --gate                 exit non-zero when a headline metric regressed past tolerance
  --gate-tolerance <x>   multiplier on the default tolerances (default 1)
  --audit-config         price the shipped DEFAULT_CONFIG tiers and check both ladders
  --audit-local          audit this machine's merged config instead (not reproducible)
  --validate             check the pack's ground truth against the fleet and exit
  --allow-inconsistent   run even when the pack fails that check

live mode sends real requests and costs money: it needs --classifier live AND
ROUTER_EVAL_LIVE=1 in the environment.`;

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(`${HELP}\n`);
		return 0;
	}

	const live = args.classifier === "live" || args.liveJudge;
	if (live && process.env.ROUTER_EVAL_LIVE !== "1") {
		process.stderr.write("refusing to run live: set ROUTER_EVAL_LIVE=1 to allow real, billed Jev calls\n");
		return 2;
	}

	if (args.auditConfig) {
		// DEFAULT_CONFIG by default, not the merged local one: the audit is a claim about
		// what ships, and it has to give the same answer on every machine.
		const loadedCfg = args.auditLocal ? loadConfig(process.cwd()) : { config: DEFAULT_CONFIG, sources: [] };
		const label = args.auditLocal
			? `this machine's merged config (${loadedCfg.sources.length ? loadedCfg.sources.join(", ") : "no overrides found"})`
			: "shipped DEFAULT_CONFIG tiers";
		const audit = auditConfig(loadedCfg.config, join(ROOT, "docs"), label);
		if (args.json) process.stdout.write(`${JSON.stringify(audit, null, "\t")}\n`);
		else process.stdout.write(renderAudit(audit));
		const problems = audit.priceInversions.length + audit.capabilityInversions.length + audit.dominatedTiers.length + (audit.collapsedTiers ? 1 : 0);
		return problems > 0 ? 4 : 0;
	}

	if (args.probe) return runProbeCommand(args);

	const pack = JSON.parse(readFileSync(args.pack, "utf8")) as TaskPack;
	const loaded = loadFleet(args.fleet, { unauthed: args.unauthed });
	const profile = args.profile ?? defaultProfile(args, pack.id);

	// A pack whose goldTier disagrees with its own requiredSkill punishes a correct
	// classification, so it cannot judge a router. Round 1 shipped one; never again.
	const problems = validatePack(pack, loaded);
	const errors = problems.filter((p) => p.level === "error");
	if (problems.length > 0 && (args.validateOnly || errors.length > 0 || !args.json)) {
		process.stderr.write(`${args.pack.replace(`${ROOT}/`, "")} vs ${args.fleet.replace(`${ROOT}/`, "")}:\n${formatProblems(problems)}\n`);
	}
	if (args.validateOnly) {
		if (problems.length === 0) process.stdout.write(`${pack.id}: ground truth is consistent with the fleet\n`);
		return errors.length > 0 ? 2 : 0;
	}
	if (errors.length > 0 && !args.allowInconsistent) {
		process.stderr.write(`\n${errors.length} ground-truth error(s); fix the pack or pass --allow-inconsistent\n`);
		return 2;
	}

	let jev: JevClient | undefined;
	if (live) {
		jev = new JevClient(loaded.config.jev);
		if (!jev.available()) {
			process.stderr.write(`live mode needs a Jev credential: ${jev.describe()}\n`);
			return 2;
		}
		process.stderr.write(`LIVE: ${pack.tasks.reduce((n, t) => n + t.turns.length, 0)} classifier calls via ${jev.describe()}\n`);
	}

	if (args.sweep) {
		const base = { pack, loaded, classifier: args.classifier, startModel: args.startModel };
		let title: string;
		let cells: unknown[];
		let rendered: string;
		if (args.sweep === "profile") {
			title = `profile sweep — pack ${pack.id}, classifier ${args.classifier}, candidates ${args.candidates || 3}`;
			const c = await runTrafficSweep({ ...base, candidateN: args.candidates || 3 });
			cells = c;
			rendered = renderTrafficSweep(c, title);
		} else if (args.sweep === "confidence") {
			title = `confidence sweep — pack ${pack.id}, classifier ${args.classifier}`;
			const c = await runConfidenceSweep(base);
			cells = c;
			rendered = renderConfidenceSweep(c, title);
		} else if (args.sweep === "policy") {
			title = `policy sweep — pack ${pack.id}, classifier ${args.classifier}, n=${args.candidates || 3}, mean of 5 seeds per cell`;
			const c = await runPolicySweep({ ...base, candidateN: args.candidates || 3 });
			cells = c;
			rendered = renderPolicySweep(c, title);
		} else if (args.sweep === "gate") {
			title = `gate sweep — pack ${pack.id}, classifier ${args.classifier}, mean of 5 seeds per cell`;
			const c = await runJudgeSweep({
				...base,
				candidateNs: [3],
				noises: [10],
				biases: [0, 20, 40],
				minConfidences: [0, 0.3, 0.5, 0.7, 0.9],
			});
			cells = c;
			rendered = renderGateSweep(c, title);
		} else if (args.sweep === "oracle") {
			title = `oracle sweep — pack ${pack.id}, turn success per classifier, mean of 5 jittered fleets per row`;
			const c = await runOracleSweep(base);
			cells = c;
			rendered = renderOracleSweep(c, title);
		} else {
			const shape = args.sweep === "bias" ? { noises: [10, 30], biases: [0, 10, 20, 40], candidateNs: [2, 3] } : { biases: [0] };
			title = `${args.sweep} sweep — pack ${pack.id}, classifier ${args.classifier}, mean of 5 seeds per cell`;
			const c = await runJudgeSweep({ ...base, ...shape });
			cells = c;
			rendered = renderSweep(c, title);
		}
		if (args.json) process.stdout.write(`${JSON.stringify({ title, cells }, null, "\t")}\n`);
		else process.stdout.write(rendered);
		if (!args.noWrite) {
			const path = join(resultsDir(ROOT), `sweep-${args.sweep}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${shortGit()}.json`);
			ensureDirFor(path);
			writeFileSync(path, `${JSON.stringify({ title, pack: pack.id, classifier: args.classifier, cells }, null, "\t")}\n`);
			process.stderr.write(`wrote ${path.replace(`${ROOT}/`, "")}\n`);
		}
		return 0;
	}

	const outcome = await runEval({
		pack,
		loaded,
		classifier: args.classifier,
		startModel: args.startModel,
		candidateN: args.candidates,
		judge: new NoisyJudge({ noise: args.judgeNoise, seed: args.seed, bias: args.judgeBias }),
		judgeMinConfidence: args.judgeMinConfidence,
		candidatePolicy: args.candidatePolicy,
		seed: args.seed,
		jev,
		traffic: args.callsPerTurn ? { ...DEFAULT_TRAFFIC, callsPerTurn: args.callsPerTurn } : undefined,
	});
	const metrics = computeMetrics(outcome.turns, outcome.stateChars);

	if (args.calibration) {
		const report = computeCalibration(outcome.turns, loaded.config.switching.minConfidence);
		if (args.json) process.stdout.write(`${JSON.stringify(report, null, "\t")}\n`);
		else process.stdout.write(renderCalibration(report, `${pack.id}, classifier ${args.classifier}`));
		return 0;
	}

	const at = new Date();
	const record: RunRecord = {
		version: 1,
		runId: `${at.toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${profile}-${shortGit()}`,
		at: at.toISOString(),
		profile,
		pack: pack.id,
		fleet: args.fleet.replace(`${ROOT}/`, ""),
		classifier: args.classifier,
		candidateN: args.candidates,
		judge: args.candidates >= 2 ? `noisy(${args.judgeNoise}${args.judgeBias ? `,bias ${args.judgeBias}` : ""})` : "none",
		seed: args.seed,
		startModel: outcome.startModel,
		live,
		git: shortGit(),
		metrics,
		turns: outcome.turns,
	};

	const baselinePath = args.compare ?? latestPath(ROOT, profile);
	const baseline = readRun(baselinePath);
	const deltas = compareMetrics(baseline?.metrics, metrics);

	if (!args.noWrite) {
		const written = writeRun(ROOT, record);
		if (args.note) {
			appendLog(ROOT, `- **${at.toISOString().slice(0, 10)}** \`${profile}\` — ${args.note} (\`${written.runPath.replace(`${ROOT}/`, "")}\`)`);
		}
	}

	const failures = args.gate ? gateRegressions(deltas, args.gateTolerance) : [];

	if (args.json) {
		process.stdout.write(
			`${JSON.stringify({ ...record, deltas, gateFailures: failures }, (_k, v) => (v === Number.POSITIVE_INFINITY ? "Infinity" : v), "\t")}\n`,
		);
	} else {
		process.stdout.write(renderTable(record, metrics, baseline?.runId, deltas));
	}

	// A routing bug is always a failure; a regression is only one when asked for.
	if (metrics.ineligibleChoices > 0) {
		process.stderr.write(`${metrics.ineligibleChoices} turn(s) routed to an ineligible model\n`);
		return 1;
	}
	if (args.gate && !baseline) {
		process.stderr.write(`--gate: no baseline for profile "${profile}"; recording this run as the baseline\n`);
		return 0;
	}
	if (failures.length > 0) {
		process.stderr.write(`\n--gate: ${failures.length} regression(s) against ${baseline?.runId}\n`);
		for (const f of failures) {
			process.stderr.write(`  ${f.key}: ${fmtNum(f.previous)} -> ${fmtNum(f.current)} (${fmtDelta(f.delta)}, tolerance ${f.kind} ${f.tolerance})\n`);
		}
		return 3;
	}
	return 0;
}

/** The pack is part of the profile: a long-session run must not be compared to a short one. */
function defaultProfile(args: Args, packId: string): string {
	const bits: string[] = [packId, args.classifier];
	if (args.candidates >= 2) bits.push(`cand${args.candidates}`);
	if (args.judgeBias) bits.push(`bias${args.judgeBias}`);
	if (args.candidatePolicy && args.candidatePolicy !== "shipped") bits.push(args.candidatePolicy);
	if (args.callsPerTurn) bits.push(`calls${args.callsPerTurn}`);
	if (args.unauthed.length) bits.push(`noauth${args.unauthed.length}`);
	return bits.join("-");
}

function shortGit(): string {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "nogit";
	}
}

function renderTable(record: RunRecord, m: RunMetrics, baselineId: string | undefined, deltas: ReturnType<typeof compareMetrics>): string {
	const deltaBy = new Map(deltas.map((d) => [d.key, d]));
	const out: string[] = [];
	out.push("");
	out.push(`router eval  ${record.runId}`);
	out.push(`pack ${record.pack}  classifier ${record.classifier}  candidates ${record.candidateN || "off"}  start ${record.startModel}`);
	out.push(baselineId ? `compared against ${baselineId}` : "no previous run for this profile");
	out.push("");

	const row = (label: string, key: string, value: string) => {
		const d = deltaBy.get(key);
		const mark =
			!d || d.direction === "same" || d.delta === 0
				? ""
				: d.direction === "neutral"
					? `  (${fmtDelta(d.delta)})`
					: `  ${d.direction === "better" ? "▲" : "▼"} ${fmtDelta(d.delta)}`;
		out.push(`  ${label.padEnd(26)}${value.padStart(12)}${mark}`);
	};

	out.push("quality");
	row("task resolve rate", "taskResolveRate", pct(m.taskResolveRate));
	row("  median task turn rate", "medianTaskTurnSuccess", pct(m.medianTaskTurnSuccess));
	row("  worst task turn rate", "worstTaskTurnSuccess", pct(m.worstTaskTurnSuccess));
	row("turn success rate", "turnSuccessRate", pct(m.turnSuccessRate));
	row("tier accuracy (landed)", "tierAccuracy", pct(m.tierAccuracy));
	row("  classifier accuracy", "classifierAccuracy", pct(m.classifierAccuracy));
	row("under-routed", "underRouteRate", pct(m.underRouteRate));
	row("over-routed", "overRouteRate", pct(m.overRouteRate));
	row("under-route failures", "underRouteFailures", String(m.underRouteFailures));
	row("in-tier misses", "inTierMisses", String(m.inTierMisses));
	out.push("");
	out.push("mechanism");
	row("ineligible choices", "ineligibleChoices", String(m.ineligibleChoices));
	row("heuristic fallbacks", "heuristicFallbacks", String(m.heuristicFallbacks));
	row("tier escalations", "tierEscalations", String(m.tierEscalations));
	row("pinned turns", "pinnedTurns", String(m.pinnedTurns));
	out.push("");
	out.push("spend");
	row("ledger cost", "ledgerCostUsd", usd(m.ledgerCostUsd));
	row("list-equivalent cost", "listEquivalentUsd", usd(m.listEquivalentUsd));
	row("hidden on plan", "planHiddenUsd", usd(m.planHiddenUsd));
	row("  = weekly plan points", "planPointsUsed", m.planPointsUsed.toFixed(3));
	row("classifier cost", "classifierCostUsd", usd(m.classifierCostUsd, 6));
	row("list $ / resolved task", "listUsdPerResolvedTask", usd(m.listUsdPerResolvedTask));
	out.push("");
	out.push("cache");
	row("switches", "switches", String(m.switches));
	row("cold turns", "coldTurns", `${m.coldTurns}/${m.turns}`);
	row("cold write tokens", "coldWriteTokens", m.coldWriteTokens.toLocaleString("en-US"));
	row("cold premium", "coldPremiumUsd", usd(m.coldPremiumUsd));
	row("  = share of all spend", "coldPremiumShare", pct(m.coldPremiumShare));
	out.push(`  ${"cold causes".padEnd(26)}${Object.entries(m.coldByCause).map(([k, v]) => `${k}=${v}`).join(" ").padStart(12)}`);
	out.push("");

	if (m.candidate) {
		const c = m.candidate;
		out.push(`candidate selection (n=${c.avgCandidates}, judge ${record.judge})`);
		row("baseline success", "candidate.baselineSuccessRate", pct(c.baselineSuccessRate));
		row("judge success (raw pick)", "candidate.judgeSuccessRate", pct(c.judgeSuccessRate));
		row("adopted success (gated)", "candidate.adoptedSuccessRate", pct(c.adoptedSuccessRate));
		row("  gated turns", "candidate.gatedTurns", String(c.gatedTurns));
		row("  gate rescue rate", "candidate.gateRescueRate", pct(c.gateRescueRate));
		row("oracle ceiling", "candidate.oracleSuccessRate", pct(c.oracleSuccessRate));
		row("judge lift (raw)", "candidate.judgeLift", pct(c.judgeLift));
		row("adopted lift", "candidate.adoptedLift", pct(c.adoptedLift));
		row("headroom captured", "candidate.judgeHeadroomCaptured", pct(c.judgeHeadroomCaptured));
		row("judge recall", "candidate.judgeRecall", pct(c.judgeRecall));
		row("judge regressions", "candidate.judgeRegressions", String(c.judgeRegressions));
		row("fan-out list cost", "candidate.fanoutListEquivalentUsd", usd(c.fanoutListEquivalentUsd));
		row("list $ / extra solve", "candidate.listUsdPerExtraSolve", usd(c.listUsdPerExtraSolve));
		out.push("");
	}

	const share = Object.entries(m.modelShare).sort((a, b) => b[1] - a[1]);
	out.push(`model share: ${share.map(([k, v]) => `${k} ${v}`).join("  ")}`);
	out.push(`state size: ${m.avgStateChars} chars avg`);
	out.push("");
	return `${out.join("\n")}\n`;
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function fmtNum(n: number): string {
	return Number.isInteger(n) ? String(n) : n.toFixed(4);
}

function usd(n: number, digits = 4): string {
	return Number.isFinite(n) ? `$${n.toFixed(digits)}` : "n/a";
}

function fmtDelta(n: number): string {
	const s = Math.abs(n) < 1 && n !== 0 ? n.toFixed(4) : n.toFixed(2);
	return n > 0 ? `+${s}` : s;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(err: unknown) => {
		process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
		process.exitCode = 1;
	},
);
