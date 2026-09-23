/**
 * Turn a live run into a fixture.
 *
 * The `scripted` classifier answers in `eval/tasks/*.json` are hand-written: what a
 * calibrated classifier *ought* to say, judged against the criteria in `src/state.ts`.
 * That is an honest starting point and a permanent asterisk on every number derived
 * from it — round 12's calibration curve, most of all, is a curve of my handwriting.
 *
 * `--record` removes the asterisk for anyone with a credential: run the pack against
 * live Jev once, write what it actually said back into the pack, and every later
 * offline run replays a real classifier for free.
 *
 * The merge is deliberately narrow. It rewrites `turns[].jev` and nothing else, so the
 * declared ground truth (`requiredSkill`) and the prompts survive untouched, and a
 * recorded pack still has to pass `--validate`.
 */
import type { ScriptedJev, TaskPack } from "./types.ts";
import type { TurnRecord } from "./types.ts";

export interface RecordResult {
	pack: TaskPack;
	/** One line per turn whose recorded answer differs from the fixture's. */
	changes: string[];
	recorded: number;
	skipped: string[];
}

export function recordAnswers(pack: TaskPack, turns: TurnRecord[]): RecordResult {
	const byTurn = new Map<string, TurnRecord>();
	for (const turn of turns) byTurn.set(`${turn.taskId}#${turn.turn}`, turn);

	const changes: string[] = [];
	const skipped: string[] = [];
	let recorded = 0;

	const tasks = pack.tasks.map((task) => ({
		...task,
		turns: task.turns.map((turn, i) => {
			const record = byTurn.get(`${task.id}#${i + 1}`);
			const where = `${task.id} turn ${i + 1}`;
			if (!record) {
				skipped.push(`${where}: no run record`);
				return turn;
			}
			if (record.pinned) {
				// A pinned turn never called the classifier, so there is nothing to record.
				skipped.push(`${where}: pinned, classifier not consulted`);
				return turn;
			}
			if (record.classifierSource !== "jev" || !record.classifierAnswer) {
				skipped.push(`${where}: classifier did not answer (${record.classifierSource})`);
				return turn;
			}
			const next: ScriptedJev = { ...record.classifierAnswer };
			// A fixture that models an outage keeps modelling one.
			if (turn.jev?.fail) next.fail = true;
			if (!same(turn.jev, next)) changes.push(`${where}: ${describe(turn.jev)} -> ${describe(next)}`);
			recorded += 1;
			return { ...turn, jev: next };
		}),
	}));

	return { pack: { ...pack, tasks }, changes, recorded, skipped };
}

function same(a: ScriptedJev | undefined, b: ScriptedJev): boolean {
	if (!a) return false;
	return a.tier === b.tier && a.confidence === b.confidence && a.needsTools === b.needsTools && a.stakes === b.stakes && !!a.fail === !!b.fail;
}

function describe(jev: ScriptedJev | undefined): string {
	if (!jev) return "(none)";
	const bits = [`${jev.tier} ${jev.confidence.toFixed(2)}`];
	if (jev.needsTools !== undefined) bits.push(`tools ${jev.needsTools.toFixed(2)}`);
	if (jev.stakes !== undefined) bits.push(`stakes ${jev.stakes.toFixed(2)}`);
	if (jev.fail) bits.push("fail");
	return bits.join(" ");
}

export function renderRecord(result: RecordResult, path: string): string {
	const out: string[] = ["", `recorded ${result.recorded} classifier answer(s) into ${path}`, ""];
	if (result.changes.length === 0) out.push("  the fixture already matched what the classifier said");
	for (const change of result.changes) out.push(`  ${change}`);
	if (result.skipped.length > 0) {
		out.push("");
		for (const skip of result.skipped) out.push(`  skipped  ${skip}`);
	}
	out.push("");
	out.push("  run `npm run eval -- --validate` before trusting the recorded pack");
	out.push("");
	return `${out.join("\n")}\n`;
}
