/**
 * Writing the global `modelrouter.json`, which only the interactive model picker does.
 *
 * The file stays the source of truth and stays the user's: a save replaces the text of the tier
 * arrays that actually changed and leaves every other byte where it was - keys, order, spacing,
 * the tiers nobody touched. Only `tiers` and `preference` are writable here. Everything else, and above all every key
 * the project-trust allowlist keeps global-only (`models`, `billing`, `entitlement`, ...), is edited
 * by hand or not at all, so this surface can never widen what a route may spend.
 *
 * Only the global file is ever written. A project's `.pi/modelrouter.json` arrives with whatever
 * repository is open and is read, never written, by the router.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPaths, DEFAULT_CONFIG, type Tier, TIERS } from "./config.ts";

export type TierLists = Record<Tier, string[]>;

/** What the global file says about tiers right now, straight from disk. */
export interface GlobalTiersFile {
	path: string;
	exists: boolean;
	/** The raw tier arrays the file itself states; a tier it does not state is absent. */
	tiers: Partial<TierLists>;
	/** Set when the file exists but cannot be parsed; nothing may be written over it then. */
	error?: string;
}

export function readGlobalTiers(path: string): GlobalTiersFile {
	if (!existsSync(path)) return { path, exists: false, tiers: {} };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(raw)) return { path, exists: true, tiers: {}, error: "top level is not a JSON object" };
		return { path, exists: true, tiers: statedTiers(raw.tiers) };
	} catch (err) {
		return { path, exists: true, tiers: {}, error: err instanceof Error ? err.message : String(err) };
	}
}

/** The tier lists a parsed `tiers` value states, ignoring anything that is not a list of ids. */
export function statedTiers(value: unknown): Partial<TierLists> {
	const out: Partial<TierLists> = {};
	if (!isRecord(value)) return out;
	for (const tier of TIERS) {
		const list = value[tier];
		if (Array.isArray(list) && list.every((k) => typeof k === "string")) out[tier] = [...list];
	}
	return out;
}

/** The tiers whose lists differ, in tier order. Order within a list is preference, so it counts. */
export function changedTiers(before: TierLists, after: TierLists): Tier[] {
	return TIERS.filter((t) => !sameList(before[t], after[t]));
}

export interface WriteResult {
	path: string;
	/** Where the previous file was copied, when there was one. */
	backup?: string;
	written: Tier[];
	/** True when the root `preference` list was rewritten too. */
	preference: boolean;
}

/**
 * Replaces the named tier arrays, and the root `preference` array when one is given, in the
 * global file as one atomic write, keeping a `.bak` of what was there before the save. Each
 * `expected` is what the file stated when the edit began (a `preference` of `undefined` when it
 * did not state the key): anything that has changed on disk since then is a conflict and nothing
 * is written, because saving would silently undo someone else's edit.
 */
export function writeGlobalTiers(
	path: string,
	changes: Partial<TierLists>,
	expected: Partial<TierLists>,
	preference?: { items: string[]; expected: string[] | undefined },
): WriteResult {
	const target = existsSync(path) ? realpathSync(path) : path;
	const current = readGlobalTiers(target);
	if (current.error) throw new Error(`${path} is not valid JSON (${current.error}); fix it by hand before saving from /router models`);
	const tiers = TIERS.filter((t) => changes[t] !== undefined);
	for (const tier of tiers) {
		if (!sameList(current.tiers[tier], expected[tier])) {
			throw new Error(`${path} changed tier "${tier}" on disk since the picker opened; reopen /router models and try again`);
		}
	}
	const statedPreference = readGlobalPreference(target).preference;
	if (preference && !sameList(statedPreference, preference.expected)) {
		throw new Error(`${path} changed "preference" on disk since the picker opened; reopen /router models and try again`);
	}
	const writePreference = preference !== undefined && !sameList(statedPreference, preference.items);
	if (tiers.length === 0 && !writePreference) return { path, written: [], preference: false };

	const before = current.exists ? readFileSync(target, "utf8") : "";
	const withTiers = editTiersText(before, changes);
	const after = writePreference ? editRootArray(withTiers, "preference", preference.items) : withTiers;
	mkdirSync(dirname(target), { recursive: true });
	let backup: string | undefined;
	if (current.exists) {
		backup = `${target}.bak`;
		copyFileSync(target, backup);
	}
	const tmp = `${target}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, after, { mode: current.exists ? statSync(target).mode & 0o777 : 0o644 });
		renameSync(tmp, target);
	} catch (err) {
		if (existsSync(tmp)) unlinkSync(tmp);
		throw err;
	}
	return { path, backup, written: tiers, preference: writePreference };
}

export interface GlobalPreferenceFile {
	path: string;
	exists: boolean;
	/** Absent when the file does not state the key. */
	preference?: string[];
	error?: string;
}

export function readGlobalPreference(path: string): GlobalPreferenceFile {
	if (!existsSync(path)) return { path, exists: false };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(raw)) return { path, exists: true, error: "top level is not a JSON object" };
		return { path, exists: true, preference: statedStringList(raw.preference) };
	} catch (err) {
		return { path, exists: true, error: err instanceof Error ? err.message : String(err) };
	}
}

/** A list of strings, or undefined when the value is absent or not that shape. */
export function statedStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
	return [...value];
}

// ---- text-preserving edit ----------------------------------------------------

/**
 * The file's text with only the named tier arrays replaced. A tier the file already states keeps
 * its position and its one-line or one-item-per-line shape; a tier it does not state is added to
 * `tiers`, and `tiers` to the top level, in the indentation the file already uses.
 */
export function editTiersText(text: string, changes: Partial<TierLists>): string {
	const tiers = TIERS.filter((t) => changes[t] !== undefined);
	if (tiers.length === 0) return text;
	if (text.trim() === "") {
		return `${objectText([["tiers", objectText(tiers.map((t) => [t, inlineArray(changes[t]!)]), "  ", "  ")]], "", "  ")}\n`;
	}
	const root = parseSpans(text);
	if (root.kind !== "object") throw new Error("top level is not a JSON object");
	const unit = indentUnit(text);
	const tiersMember = root.members.find((m) => m.key === "tiers");

	// Edits are applied back to front so earlier offsets stay valid.
	const edits: { start: number; end: number; text: string }[] = [];
	if (tiersMember && tiersMember.value.kind === "object") {
		const obj = tiersMember.value;
		const missing: Tier[] = [];
		for (const tier of tiers) {
			const member = obj.members.find((m) => m.key === tier);
			if (member) edits.push({ start: member.value.start, end: member.value.end, text: formatArrayLike(text, member.value, changes[tier]!, unit) });
			else missing.push(tier);
		}
		if (missing.length > 0) edits.push(insertMembers(text, obj, missing.map((t) => [t, inlineArray(changes[t]!)]), unit));
	} else if (tiersMember) {
		throw new Error(`"tiers" is not an object; fix it by hand before saving from /router models`);
	} else {
		const indent = root.members.length > 0 ? lineIndent(text, root.members[0]!.keyStart) : unit;
		const multiline = text.slice(root.start, root.end).includes("\n");
		const value = multiline ? objectText(tiers.map((t) => [t, inlineArray(changes[t]!)]), indent, unit) : inlineObject(tiers.map((t) => [t, inlineArray(changes[t]!)]));
		edits.push(insertMembers(text, root, [["tiers", value]], unit));
	}
	let out = text;
	for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
	return out;
}

/** The file's text with one root array replaced, or added when the file does not state it. */
export function editRootArray(text: string, key: string, items: string[]): string {
	if (text.trim() === "") return `${objectText([[key, inlineArray(items)]], "", "  ")}\n`;
	const root = parseSpans(text);
	if (root.kind !== "object") throw new Error("top level is not a JSON object");
	const unit = indentUnit(text);
	const member = root.members.find((m) => m.key === key);
	const edits: { start: number; end: number; text: string }[] = [];
	if (member && member.value.kind === "array") {
		edits.push({ start: member.value.start, end: member.value.end, text: formatArrayLike(text, member.value, items, unit) });
	} else if (member) {
		throw new Error(`"${key}" is not an array; fix it by hand before saving from /router models`);
	} else {
		const indent = root.members.length > 0 ? lineIndent(text, root.members[0]!.keyStart) : unit;
		const multiline = text.slice(root.start, root.end).includes("\n");
		const written =
			multiline && items.length > 1
				? `[\n${items.map((item) => `${indent}${unit}${JSON.stringify(item)}`).join(",\n")}\n${indent}]`
				: inlineArray(items);
		edits.push(insertMembers(text, root, [[key, written]], unit));
	}
	let out = text;
	for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
	return out;
}

function inlineArray(items: string[]): string {
	return `[${items.map((i) => JSON.stringify(i)).join(", ")}]`;
}

function inlineObject(members: [string, string][]): string {
	return members.length === 0 ? "{}" : `{ ${members.map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(", ")} }`;
}

function objectText(members: [string, string][], indent: string, unit: string): string {
	if (members.length === 0) return "{}";
	return `{\n${members.map(([k, v]) => `${indent}${unit}${JSON.stringify(k)}: ${v}`).join(",\n")}\n${indent}}`;
}

/** A replacement array in the shape the old value had: one line, or one item per line. */
function formatArrayLike(text: string, old: Span, items: string[], unit: string): string {
	const oldText = text.slice(old.start, old.end);
	if (!oldText.includes("\n") || items.length === 0) return inlineArray(items);
	const closeIndent = lineIndent(text, old.end - 1);
	const firstItem = old.kind === "array" ? old.items[0] : undefined;
	const itemIndent = firstItem ? lineIndent(text, firstItem.start) : closeIndent + unit;
	return `[\n${items.map((i) => `${itemIndent}${JSON.stringify(i)}`).join(",\n")}\n${closeIndent}]`;
}

/** Appends members after an object's last member, matching its one-line or multi-line layout. */
function insertMembers(text: string, obj: ObjectSpan, members: [string, string][], unit: string): { start: number; end: number; text: string } {
	const close = obj.end - 1;
	const last = obj.members[obj.members.length - 1];
	const multiline = text.slice(obj.start, obj.end).includes("\n");
	if (!multiline) {
		const body = members.map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(", ");
		if (!last) return { start: obj.start + 1, end: close, text: ` ${body} ` };
		return { start: last.value.end, end: last.value.end, text: `, ${body}` };
	}
	if (!last) {
		const indent = lineIndent(text, close) + unit;
		const body = members.map(([k, v]) => `${indent}${JSON.stringify(k)}: ${v}`).join(",\n");
		return { start: obj.start + 1, end: close, text: `\n${body}\n${lineIndent(text, close)}` };
	}
	const indent = lineIndent(text, last.keyStart);
	const body = members.map(([k, v]) => `,\n${indent}${JSON.stringify(k)}: ${v}`).join("");
	return { start: last.value.end, end: last.value.end, text: body };
}

/** Leading whitespace of the line holding `pos`. */
function lineIndent(text: string, pos: number): string {
	const start = text.lastIndexOf("\n", pos - 1) + 1;
	return /^[ \t]*/.exec(text.slice(start))![0];
}

/** The file's own indentation step: the first indented line's leading whitespace, else two spaces. */
function indentUnit(text: string): string {
	const m = /\n([ \t]+)\S/.exec(text);
	return m ? m[1]! : "  ";
}

// ---- span parser ---------------------------------------------------------------

interface BaseSpan {
	start: number;
	end: number;
}
interface ObjectSpan extends BaseSpan {
	kind: "object";
	members: { key: string; keyStart: number; value: Span }[];
}
interface ArraySpan extends BaseSpan {
	kind: "array";
	items: Span[];
}
interface ScalarSpan extends BaseSpan {
	kind: "scalar";
}
type Span = ObjectSpan | ArraySpan | ScalarSpan;

/** Where each value sits in the text. The text has already passed JSON.parse. */
function parseSpans(text: string): Span {
	let pos = 0;
	const ws = () => {
		while (pos < text.length && /\s/.test(text[pos]!)) pos++;
	};
	const str = (): string => {
		const start = pos;
		pos++;
		while (text[pos] !== '"') pos += text[pos] === "\\" ? 2 : 1;
		pos++;
		return JSON.parse(text.slice(start, pos)) as string;
	};
	const value = (): Span => {
		ws();
		const start = pos;
		const c = text[pos];
		if (c === "{") {
			pos++;
			const members: ObjectSpan["members"] = [];
			ws();
			if (text[pos] === "}") {
				pos++;
				return { kind: "object", start, end: pos, members };
			}
			for (;;) {
				ws();
				const keyStart = pos;
				const key = str();
				ws();
				pos++; // ':'
				const v = value();
				members.push({ key, keyStart, value: v });
				ws();
				if (text[pos++] === "}") return { kind: "object", start, end: pos, members };
			}
		}
		if (c === "[") {
			pos++;
			const items: Span[] = [];
			ws();
			if (text[pos] === "]") {
				pos++;
				return { kind: "array", start, end: pos, items };
			}
			for (;;) {
				items.push(value());
				ws();
				if (text[pos++] === "]") return { kind: "array", start, end: pos, items };
			}
		}
		if (c === '"') {
			str();
			return { kind: "scalar", start, end: pos };
		}
		while (pos < text.length && /[^\s,\]}]/.test(text[pos]!)) pos++;
		return { kind: "scalar", start, end: pos };
	};
	const root = value();
	return root;
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---- layers --------------------------------------------------------------------

export interface TierLayers {
	/** The global file as it stands, which is what a save edits. */
	file: GlobalTiersFile;
	/** The defaults with the global file's tiers over them: what the picker starts from. */
	global: TierLists;
	/** Tiers the project file replaces; these win in this project whatever the global file says. */
	project: Partial<TierLists>;
	projectPath: string;
	/** The preference list the picker starts from: the file's, or the defaults when it states none. */
	preference: string[];
	/** What the global file itself stated. Absent when the key is not in the file. */
	statedPreference?: string[];
	/** Set when this project's file replaces the preference list. */
	projectPreference?: string[];
}

export function tierLayers(cwd: string): TierLayers {
	const paths = configPaths(cwd);
	const file = readGlobalTiers(paths.global);
	const preferenceFile = readGlobalPreference(paths.global);
	let project: Partial<TierLists> = {};
	let projectPreference: string[] | undefined;
	if (existsSync(paths.project)) {
		try {
			const raw = JSON.parse(readFileSync(paths.project, "utf8")) as unknown;
			if (isRecord(raw)) {
				project = statedTiers(raw.tiers);
				projectPreference = statedStringList(raw.preference);
			}
		} catch {
			// loadConfig reports an unreadable project file; it overrides nothing then
		}
	}
	return {
		file,
		global: { ...structuredClone(DEFAULT_CONFIG.tiers), ...file.tiers },
		project,
		projectPath: paths.project,
		preference: preferenceFile.preference ?? [...DEFAULT_CONFIG.preference],
		statedPreference: preferenceFile.preference,
		projectPreference,
	};
}
