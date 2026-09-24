/**
 * `/router models`: choose which models each tier routes to, in preference order, without
 * hand-editing JSON - and see, for every model pi offers, what the router would make of it.
 *
 * The picker edits the global `modelrouter.json`, the file that stays the source of truth: on
 * save it rewrites only the tier lists that changed (see configfile.ts), then reloads exactly as
 * `/router reload` does. Every verdict it shows is routing's own (see models.ts), so the picker
 * never describes a route differently from how the router treats it.
 */
import { homedir } from "node:os";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, decodeKittyPrintable, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, modelKey, type RouterConfig, type Tier, TIERS } from "./config.ts";
import { changedTiers, type TierLists, tierLayers, type WriteResult, writeGlobalTiers } from "./configfile.ts";
import { resolveEntry } from "./preference.ts";
import type { Ledger } from "./ledger.ts";
import {
	addToTier,
	effectiveTiers,
	factsCache,
	type ModelFacts,
	moveInTier,
	type Offered,
	offeredModels,
	priceNote,
	removeFromTier,
	reportLines,
	reportTiers,
	shortVerdict,
} from "./models.ts";

export interface PickerInput {
	/** The effective config the router runs on now; its tiers are replaced by the draft for verdicts. */
	cfg: RouterConfig;
	registry: ExtensionCommandContext["modelRegistry"];
	ledger: Ledger;
	/** The global layer's tier lists: the defaults with the global file over them. What is edited. */
	global: TierLists;
	/** Tiers this project's `.pi/modelrouter.json` replaces; saving the global file does not change them here. */
	project: Partial<TierLists>;
	offered: Offered;
	/** Where a save goes, for the header. */
	path: string;
	/** Fallback order the picker starts from. Defaults to the shipped series list. */
	preference?: string[];
	/** Set when this project's file replaces the list, so a global save does not change it here. */
	projectPreference?: string[];
	now?: number;
}

export interface PickerSave {
	tiers: TierLists;
	preference: string[];
}

type Row = { kind: "entry"; key: string; index: number } | { kind: "pool"; key: string };

const LIST_LINES = 14;
const REPORT_LINES = 4;

/**
 * The picker as a plain component: `done` receives the edited tier lists on save, or undefined
 * when closed without saving. Exported so the key handling and rendering can be driven headless.
 */
export function createModelPicker(input: PickerInput, theme: Theme, requestRender: () => void, done: (result: PickerSave | undefined) => void): Component {
	let draft: TierLists = structuredClone(input.global);
	let preference = [...(input.preference ?? DEFAULT_CONFIG.preference)];
	const initialPreference = [...preference];
	let preferenceMode = false;
	let tierIdx = 0;
	let cursor = 0;
	let filter = "";
	let discardArmed = false;
	let flash: { text: string; color: "success" | "warning" | "muted" } | undefined;
	let cached: string[] | undefined;

	let facts = factsFor(draft);
	function factsFor(tiers: TierLists) {
		return factsCache({
			cfg: { ...input.cfg, tiers: effectiveTiers(tiers, input.project) },
			registry: input.registry,
			ledger: input.ledger,
			now: input.now,
		});
	}

	// Open where the attention is needed: the first tier holding an unusable entry or none at all.
	const opening = reportTiers(draft, input.offered, facts, input.project);
	tierIdx = Math.max(0, TIERS.findIndex((t) => opening.empty.includes(t) || opening.unusable.some((u) => u.tier === t)));

	const tier = (): Tier => TIERS[tierIdx]!;
	const preferenceDirty = () => !sameStrings(preference, initialPreference);
	const dirty = () => changedTiers(input.global, draft).length > 0 || preferenceDirty();
	const finish = () => done({ tiers: structuredClone(draft), preference: [...preference] });

	function rows(): Row[] {
		const t = tier();
		const entries: Row[] = draft[t].map((key, index) => ({ kind: "entry", key, index }));
		const named = new Set(TIERS.flatMap((x) => [...draft[x], ...(input.project[x] ?? [])]));
		const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
		const seen = new Set(draft[t]);
		const candidates: { key: string; facts: ModelFacts; untiered: boolean }[] = [];
		for (const m of input.offered.models) {
			const key = modelKey(m);
			if (seen.has(key)) continue;
			seen.add(key);
			const hay = `${key} ${m.name ?? ""}`.toLowerCase();
			if (!words.every((w) => hay.includes(w))) continue;
			const f = facts(key);
			candidates.push({ key, facts: f, untiered: !named.has(key) && f.state === "eligible" });
		}
		// What most needs a decision first: eligible models no tier names, then by routing rank.
		candidates.sort((a, b) => Number(b.untiered) - Number(a.untiered) || order(a.facts) - order(b.facts) || a.key.localeCompare(b.key));
		return [...entries, ...candidates.map((c): Row => ({ kind: "pool", key: c.key }))];
	}

	function edit(next: TierLists, message: string) {
		draft = next;
		facts = factsFor(draft);
		discardArmed = false;
		flash = { text: message, color: "muted" };
	}

	function refresh() {
		cached = undefined;
		requestRender();
	}

	function handleInput(data: string) {
		const all = rows();
		const row = all[cursor];
		const t = tier();
		const clamp = (n: number, length = rows().length) => Math.max(0, Math.min(length - 1, n));

		if (matchesKey(data, Key.ctrl("p"))) {
			preferenceMode = !preferenceMode;
			cursor = 0;
			filter = "";
			flash = { text: preferenceMode ? "Fallback order: Shift+↑↓ reorder, Tab returns to tiers" : "Back to tiers", color: "muted" };
		} else if (matchesKey(data, Key.escape)) {
			if (filter) {
				filter = "";
				cursor = 0;
			} else if (dirty() && !discardArmed) {
				discardArmed = true;
				flash = { text: "Unsaved changes: Esc again to discard, Ctrl+S to save", color: "warning" };
			} else {
				done(undefined);
				return;
			}
		} else if (matchesKey(data, Key.ctrl("s"))) {
			if (!dirty()) {
				flash = { text: "Nothing to save: the tiers and the preference order are as the file has them", color: "muted" };
			} else {
				finish();
				return;
			}
		} else if (preferenceMode && (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || matchesKey(data, Key.left))) {
			preferenceMode = false;
			cursor = 0;
		} else if (preferenceMode && (isMove(data, "up") || isMove(data, "down"))) {
			const delta = isMove(data, "up") ? -1 : 1;
			const next = moveString(preference, cursor, delta);
			if (next !== preference) {
				preference = next;
				discardArmed = false;
				flash = { text: `Moved ${preference[Math.max(0, Math.min(preference.length - 1, cursor + delta))]}`, color: "muted" };
				cursor = Math.max(0, Math.min(preference.length - 1, cursor + delta));
			}
		} else if (preferenceMode && matchesKey(data, Key.up)) {
			cursor = Math.max(0, cursor - 1);
		} else if (preferenceMode && matchesKey(data, Key.down)) {
			cursor = Math.min(preference.length - 1, cursor + 1);
		} else if (preferenceMode) {
			return;
		} else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			tierIdx = (tierIdx + 1) % TIERS.length;
			cursor = 0;
		} else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			tierIdx = (tierIdx - 1 + TIERS.length) % TIERS.length;
			cursor = 0;
		} else if (isMove(data, "up") || isMove(data, "down")) {
			if (row?.kind === "entry") {
				const delta = isMove(data, "up") ? -1 : 1;
				edit(moveInTier(draft, t, row.index, delta), `Moved ${row.key}`);
				cursor = clamp(row.index + delta, draft[t].length);
			} else {
				flash = { text: `Only ${t}'s own entries reorder: add this model first (Enter)`, color: "muted" };
			}
		} else if (matchesKey(data, Key.up)) {
			cursor = clamp(cursor - 1, all.length);
		} else if (matchesKey(data, Key.down)) {
			cursor = clamp(cursor + 1, all.length);
		} else if (matchesKey(data, Key.pageUp)) {
			cursor = clamp(cursor - 10, all.length);
		} else if (matchesKey(data, Key.pageDown)) {
			cursor = clamp(cursor + 10, all.length);
		} else if (matchesKey(data, Key.enter) || (matchesKey(data, Key.delete) && row?.kind === "entry")) {
			if (row?.kind === "entry") {
				edit(removeFromTier(draft, t, row.key), `Removed ${row.key} from ${t}`);
				cursor = clamp(draft[t].length > 0 ? Math.min(row.index, draft[t].length - 1) : 0);
			} else if (row?.kind === "pool") {
				edit(addToTier(draft, t, row.key), `Added ${row.key} to ${t} at #${draft[t].length + 1}`);
				// Stay on the next model in the list, so several can be added in a row.
				cursor = clamp(cursor + 1);
			}
		} else if (matchesKey(data, Key.backspace)) {
			filter = filter.slice(0, -1);
			cursor = 0;
		} else {
			const ch = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " && data !== "\x7f" ? data : undefined);
			if (ch === undefined) return;
			filter += ch;
			// Typing is for finding a model to add, so land on the first match.
			cursor = draft[t].length;
		}
		cursor = preferenceMode ? (preference.length === 0 ? 0 : Math.max(0, Math.min(preference.length - 1, cursor))) : clamp(cursor);
		refresh();
	}

	function render(width: number): string[] {
		if (cached) return cached;
		const w = Math.max(20, width);
		if (preferenceMode) return renderPreference(w);
		const lines: string[] = [];
		const fit = (s: string) => truncateToWidth(s, w);
		const t = tier();
		const all = rows();
		const row = all[cursor];
		const report = reportTiers(draft, input.offered, facts, input.project);

		lines.push(theme.fg("accent", "─".repeat(w)));
		const state = dirty() ? theme.fg("warning", "● unsaved") : theme.fg("dim", "unchanged");
		lines.push(fit(` ${theme.fg("accent", "[router models]")} ${state} ${theme.fg("dim", tildePath(input.path))}`));

		// Tier tabs, each with its size and a mark when it holds a problem.
		const tabs = TIERS.map((x, i) => {
			const bad = report.unusable.some((u) => u.tier === x) || report.empty.includes(x);
			const label = ` ${x} ${draft[x].length}${bad ? " ✗" : ""} `;
			return i === tierIdx ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(bad ? "error" : "muted", label);
		});
		lines.push(fit(` ${tabs.join(" ")}`));

		const problems = reportLines(report);
		if (problems.length === 0) {
			lines.push(fit(` ${theme.fg("success", "✓ every tier entry is usable and every eligible model pi offers is in a tier")}`));
		} else {
			for (const p of problems.slice(0, REPORT_LINES)) lines.push(fit(` ${theme.fg(p.startsWith("✗") ? "error" : "warning", p)}`));
			if (problems.length > REPORT_LINES) lines.push(fit(` ${theme.fg("dim", `  … ${problems.length - REPORT_LINES} more (/router shows them all)`)}`));
		}
		if (input.project[t]) {
			lines.push(fit(` ${theme.fg("warning", `⚠ this project's .pi/modelrouter.json sets ${t}; a save changes it everywhere else, not here`)}`));
		}
		lines.push("");

		// The tier and the pool as one scrolled list, so one cursor serves both.
		const list: string[] = [];
		let cursorLine = 0;
		list.push(` ${theme.bold(t)} ${theme.fg("dim", "— in preference order; billing rank, then cost, then capability are weighed first")}`);
		if (draft[t].length === 0) list.push(`   ${theme.fg("error", "(empty: turns routed here escalate to another tier)")}`);
		all.forEach((r, i) => {
			if (r.kind === "pool" && (i === 0 || all[i - 1]!.kind === "entry")) {
				list.push("");
				list.push(` ${theme.bold(`add to ${t}`)} ${theme.fg("dim", `— ${input.offered.explicit ? "pi's enabled models" : "models pi holds a credential for"}`)}`);
			}
			if (i === cursor) cursorLine = list.length;
			list.push(rowLine(r, i === cursor, w));
		});
		if (!all.some((r) => r.kind === "pool")) {
			list.push("");
			list.push(` ${theme.bold(`add to ${t}`)} ${theme.fg("dim", filter ? "— nothing matches the filter" : "— every model offered is already here")}`);
		}
		const start = Math.max(0, Math.min(cursorLine - Math.floor(LIST_LINES / 2), list.length - LIST_LINES));
		const shown = list.slice(start, start + LIST_LINES);
		if (start > 0) shown[0] = fit(theme.fg("dim", `   ↑ ${start + 1} more`));
		if (start + LIST_LINES < list.length) shown[shown.length - 1] = fit(theme.fg("dim", `   ↓ ${list.length - start - LIST_LINES + 1} more`));
		lines.push(...shown.map(fit));

		lines.push(fit(` ${theme.fg("muted", "filter:")} ${filter ? theme.fg("text", filter) : theme.fg("dim", "type to filter")}`));
		lines.push(theme.fg("borderMuted", "─".repeat(w)));
		if (row) lines.push(...detailLines(row.key, w));
		if (flash) lines.push(fit(` ${theme.fg(flash.color, flash.text)}`));
		lines.push(
			fit(
				` ${theme.fg("dim", "↑↓ select • Enter add/remove • Shift+↑↓ reorder • Tab tier • Ctrl+P preference • Ctrl+S save • Esc close")}`,
			),
		);
		lines.push(theme.fg("accent", "─".repeat(w)));
		cached = lines;
		return lines;
	}

	function renderPreference(w: number): string[] {
		const fit = (s: string) => truncateToWidth(s, w);
		const lines: string[] = [];
		lines.push(theme.fg("accent", "─".repeat(w)));
		const state = dirty() ? theme.fg("warning", "● unsaved") : theme.fg("dim", "unchanged");
		lines.push(fit(` ${theme.fg("accent", "[router models]")} ${state} ${theme.fg("dim", tildePath(input.path))}`));
		lines.push(fit(` ${theme.bold("fallback")} ${theme.fg("dim", "— used when the current model's subscription window is spent")}`));
		if (input.projectPreference) {
			lines.push(fit(` ${theme.fg("warning", "⚠ this project's .pi/modelrouter.json sets preference; a save changes it everywhere else, not here")}`));
		}
		lines.push("");
		preference.forEach((entry, i) => {
			const resolved = resolveEntry(entry, {
				cfg: input.cfg,
				registry: input.registry,
				ledger: input.ledger,
				models: input.offered.models,
				now: input.now,
			});
			const where = resolved ? resolved.key : "none available";
			const prefix = i === cursor ? theme.fg("accent", "> ") : "  ";
			const label = i === cursor ? theme.fg("accent", entry) : entry;
			lines.push(fit(` ${prefix}${i + 1}. ${label}  ${theme.fg("dim", "→")} ${where}`));
		});
		if (preference.length === 0) lines.push(fit(`   ${theme.fg("error", "(empty: a spent window has nowhere to go)")}`));
		lines.push("");
		if (flash) lines.push(fit(` ${theme.fg(flash.color, flash.text)}`));
		lines.push(fit(` ${theme.fg("dim", "↑↓ select • Shift+↑↓ reorder • Tab tiers • Ctrl+S save • Esc close")}`));
		lines.push(theme.fg("accent", "─".repeat(w)));
		cached = lines;
		return lines;
	}

	function rowLine(r: Row, selected: boolean, w: number): string {
		const f = facts(r.key);
		const prefix = selected ? theme.fg("accent", "> ") : "  ";
		const lead = r.kind === "entry" ? `${r.index + 1}. ` : "+ ";
		const verdict = theme.fg(verdictColor(f), shortVerdict(f));
		const tags: string[] = [];
		const price = priceNote(f);
		if (price) tags.push(theme.fg("dim", price));
		if (r.kind === "pool") {
			const elsewhere = TIERS.filter((x) => draft[x].includes(r.key));
			const projectOnly = TIERS.filter((x) => input.project[x]?.includes(r.key) && !elsewhere.includes(x));
			if (elsewhere.length > 0) tags.push(theme.fg("dim", `in ${elsewhere.join(", ")}`));
			if (projectOnly.length > 0) tags.push(theme.fg("dim", `in ${projectOnly.join(", ")} for this project`));
			if (elsewhere.length + projectOnly.length === 0 && f.state === "eligible") tags.push(theme.fg("warning", "⚠ in no tier"));
		}
		const name = selected ? theme.fg("accent", r.key) : r.key;
		const left = ` ${prefix}${theme.fg("muted", lead)}${name}`;
		const right = [verdict, ...tags].join(theme.fg("dim", " · "));
		const col = Math.max(visibleWidth(left) + 2, Math.min(56, Math.floor(w * 0.5)));
		return `${left}${" ".repeat(Math.max(2, col - visibleWidth(left)))}${right}`;
	}

	/** The highlighted model in full: routing's reason, the evidence, and what is still unproven. */
	function detailLines(key: string, w: number): string[] {
		const f = facts(key);
		const fit = (s: string) => truncateToWidth(s, w);
		const out: string[] = [];
		const m = f.model;
		const about = m ? [m.name && m.name !== m.id ? m.name : undefined, `${Math.round(m.contextWindow / 1000)}k ctx`, m.reasoning ? "reasoning" : undefined] : [];
		out.push(fit(` ${theme.bold(key)} ${theme.fg("dim", about.filter(Boolean).join(" · "))}`));
		const a = f.candidate.assessment;
		if (!a) {
			out.push(fit(`   ${theme.fg("error", f.state === "unknown" ? "pi has no model by this id: check `pi --list-models` for the exact provider/modelId" : "pi holds no credential for this provider: /login or its API key env var")}`));
			return out;
		}
		out.push(fit(`   ${theme.fg(verdictColor(f), `${a.basis} · ${a.verification} · ${a.eligibility}`)} ${theme.fg("dim", "—")} ${a.reason}`));
		for (const e of a.evidence.slice(0, 2)) out.push(fit(`   ${theme.fg("muted", "evidence:")} ${e}`));
		const uncertain = a.uncertainty.length ? a.uncertainty.slice(0, 2) : ["none"];
		for (const u of uncertain) out.push(fit(`   ${theme.fg("muted", "uncertain:")} ${u}`));
		const quota = m ? input.ledger.summaryLines().find((l) => l.startsWith(`quota ${input.ledger.accountOf(m.provider)}:`)) : undefined;
		if (quota) out.push(fit(`   ${theme.fg("muted", quota)}`));
		return out;
	}

	function verdictColor(f: ModelFacts): "success" | "warning" | "error" | "muted" {
		if (f.state !== "eligible") return "error";
		const a = f.candidate.assessment!;
		if (a.eligibility === "preferred") return "success";
		return a.basis === "pay-per-token" || a.basis === "extra-credits" ? "warning" : "muted";
	}

	return { render, handleInput, invalidate: () => (cached = undefined) };
}

function tildePath(path: string): string {
	const home = homedir();
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Sort order within the pool: usable before unusable, then routing's own preference rank. */
function order(f: ModelFacts): number {
	if (f.state === "eligible") return f.candidate.assessment?.rank ?? 5;
	return f.state === "excluded" ? 10 : f.state === "no-auth" ? 11 : 12;
}

/** Reordering accepts Shift, Alt or Ctrl with the arrows, since terminals differ in what they pass through. */
function isMove(data: string, dir: "up" | "down"): boolean {
	return matchesKey(data, Key.shift(dir)) || matchesKey(data, Key.alt(dir)) || matchesKey(data, Key.ctrl(dir));
}

function moveString(list: string[], index: number, delta: number): string[] {
	if (index < 0 || index >= list.length) return list;
	const to = Math.max(0, Math.min(list.length - 1, index + delta));
	if (to === index) return list;
	const next = [...list];
	const [item] = next.splice(index, 1);
	next.splice(to, 0, item!);
	return next;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---- the command -----------------------------------------------------------------

export interface ModelsCommandArgs {
	ctx: ExtensionCommandContext;
	cfg: RouterConfig;
	ledger: Ledger;
	/** Applies the saved file exactly as `/router reload` does and returns the config now in force. */
	reload: () => Promise<RouterConfig>;
	showCard: (title: string, lines: string[]) => void;
}

export async function runModelsCommand(args: ModelsCommandArgs): Promise<void> {
	const { ctx, cfg, ledger } = args;
	const layers = tierLayers(ctx.cwd);
	const offered = offeredModels(ctx.scopedModels, ctx.modelRegistry);
	const path = layers.file.path;

	if (ctx.mode !== "tui" || layers.file.error) {
		const lines = modelsCardLines(cfg, offered, ctx, ledger);
		lines.push(
			layers.file.error
				? `${path} is not valid JSON (${layers.file.error}); fix it by hand, then /router models can edit it`
				: `edit tiers in ${path}, or run /router models in pi's interactive mode`,
		);
		args.showCard("router models", lines);
		return;
	}

	const result = await ctx.ui.custom<PickerSave | undefined>((tui, theme, _kb, done) =>
		createModelPicker(
			{
				cfg,
				registry: ctx.modelRegistry,
				ledger,
				global: layers.global,
				project: layers.project,
				offered,
				path,
				preference: layers.preference,
				projectPreference: layers.projectPreference,
			},
			theme,
			() => tui.requestRender(),
			done,
		),
	);
	if (!result) {
		ctx.ui.notify("router: model tiers left unchanged", "info");
		return;
	}

	const tiers = changedTiers(layers.global, result.tiers);
	const preferenceChanged = !sameStrings(result.preference, layers.preference);
	if (tiers.length === 0 && !preferenceChanged) {
		ctx.ui.notify("router: model tiers left unchanged", "info");
		return;
	}
	const changes: Partial<TierLists> = Object.fromEntries(tiers.map((t) => [t, result.tiers[t]]));
	let written: WriteResult;
	try {
		written = writeGlobalTiers(
			path,
			changes,
			layers.file.tiers,
			preferenceChanged ? { items: result.preference, expected: layers.statedPreference } : undefined,
		);
	} catch (err) {
		ctx.ui.notify(`router: nothing saved: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}

	const now = await args.reload();
	const saved = [...tiers, ...(preferenceChanged ? ["preference"] : [])];
	const lines = [`saved ${saved.join(", ")} to ${written.path}${written.backup ? ` (previous copy: ${written.backup})` : ""}`];
	for (const t of tiers) {
		lines.push(`${t}: ${result.tiers[t].join(", ") || "(empty)"}`);
		lines.push(`  was: ${layers.global[t].join(", ") || "(empty)"}`);
	}
	if (preferenceChanged) {
		lines.push(`preference: ${result.preference.join(" > ")}`);
		lines.push(`  was: ${layers.preference.join(" > ")}`);
	}
	const overridden = tiers.filter((t) => layers.project[t]);
	if (overridden.length > 0) lines.push(`⚠ ${layers.projectPath} still sets ${overridden.join(", ")} for this project`);
	if (preferenceChanged && layers.projectPreference) lines.push(`⚠ ${layers.projectPath} still sets preference for this project`);
	lines.push(...reportLines(reportTiers(now.tiers, offered, factsCache({ cfg: now, registry: ctx.modelRegistry, ledger }))));
	args.showCard("router models", lines);
}

/** Tiers with routing's verdict per entry, then the problems: the picker's content as a card. */
export function modelsCardLines(cfg: RouterConfig, offered: Offered, ctx: Pick<ExtensionCommandContext, "modelRegistry">, ledger: Ledger): string[] {
	const facts = factsCache({ cfg, registry: ctx.modelRegistry, ledger });
	const lines: string[] = [];
	for (const t of TIERS) {
		lines.push(`${t}:`);
		cfg.tiers[t].forEach((key, i) => lines.push(`  ${i + 1}. ${key}  ${shortVerdict(facts(key))}`));
		if (cfg.tiers[t].length === 0) lines.push("  (empty)");
	}
	const problems = reportLines(reportTiers(cfg.tiers, offered, facts));
	lines.push(...(problems.length > 0 ? problems : ["✓ every tier entry is usable and every eligible model pi offers is in a tier"]));
	return lines;
}
