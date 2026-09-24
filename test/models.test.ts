/**
 * `/router models`: the tier editing logic, the report of what the tiers get wrong, the
 * text-preserving write of the global file, and the boundary that keeps the picker away from the
 * project file and from every key but `tiers`. The picker component is driven headless with raw
 * terminal key sequences; its look in a real terminal was checked by driving pi (see README).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, loadConfig, mergeConfig, type RouterConfig } from "../src/config.ts";
import { changedTiers, editTiersText, readGlobalTiers, type TierLists, writeGlobalTiers } from "../src/configfile.ts";
import { Ledger } from "../src/ledger.ts";
import { addToTier, factsCache, moveInTier, offeredModels, removeFromTier, reportLines, reportTiers } from "../src/models.ts";
import { createModelPicker, type PickerSave, runModelsCommand } from "../src/picker.ts";

// The global layer lives in a scratch agent dir, so the user's own config is never read or written.
const AGENT_DIR = mkdtempSync(join(tmpdir(), "mr-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
const GLOBAL = join(AGENT_DIR, "modelrouter.json");

function model(provider: string, id: string, cost: Partial<Model<Api>["cost"]> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://x",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...cost },
		contextWindow: 200000,
		maxTokens: 8192,
	} as Model<Api>;
}

const opus5 = model("claude-bridge", "claude-opus-5", { input: 15, output: 75 });
const opus55 = model("claude-bridge", "claude-opus-5-5", { input: 15, output: 75 });
const codex = model("openai-codex", "gpt-6-astra", { input: 1.25, output: 10 });
const glm = model("openrouter", "z-ai/glm-5.3", { input: 0.5, output: 2 });
const grok = model("xai", "grok-4.6", { input: 3, output: 15 });
const CATALOG = [opus5, opus55, codex, glm, grok];

function fakeRegistry(models: Model<Api>[], opts: { unauthed?: string[]; oauth?: string[] } = {}): ModelRegistry {
	const authed = (m: Model<Api>) => !(opts.unauthed ?? []).includes(m.provider);
	return {
		find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
		hasConfiguredAuth: authed,
		isUsingOAuth: (m: Model<Api>) => (opts.oauth ?? ["claude-bridge", "openai-codex"]).includes(m.provider),
		getAll: () => models,
		getAvailable: () => models.filter(authed),
	} as unknown as ModelRegistry;
}

function ledger(): Ledger {
	return new Ledger(join(mkdtempSync(join(tmpdir(), "mr-models-")), "usage.json"));
}

const plain = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;

const KEY = {
	up: "\x1b[A",
	left: "\x1b[D",
	down: "\x1b[B",
	shiftUp: "\x1b[1;2A",
	shiftDown: "\x1b[1;2B",
	enter: "\r",
	tab: "\t",
	esc: "\x1b",
	ctrlS: "\x13",
	backspace: "\x7f",
};

const OPUS = "claude-bridge/claude-opus-5";

function tiers(light: string[], standard: string[], heavy: string[]): TierLists {
	return { light, standard, heavy };
}

// ---- tier editing ---------------------------------------------------------------

test("adding appends as least preferred, and never duplicates", () => {
	const t = tiers([], [], ["a"]);
	assert.deepEqual(addToTier(t, "heavy", "b").heavy, ["a", "b"]);
	assert.equal(addToTier(t, "heavy", "a"), t);
	assert.deepEqual(t.heavy, ["a"], "the input is not mutated");
});

test("moving reorders within a tier, clamped at the ends", () => {
	const t = tiers([], [], ["a", "b", "c"]);
	assert.deepEqual(moveInTier(t, "heavy", 2, -1).heavy, ["a", "c", "b"]);
	assert.deepEqual(moveInTier(t, "heavy", 0, 1).heavy, ["b", "a", "c"]);
	assert.equal(moveInTier(t, "heavy", 0, -1), t, "already first");
	assert.equal(moveInTier(t, "heavy", 2, 1), t, "already last");
	assert.deepEqual(removeFromTier(t, "heavy", "b").heavy, ["a", "c"]);
});

test("a reorder is a change, since order is preference", () => {
	const before = tiers(["x"], ["y"], ["a", "b"]);
	assert.deepEqual(changedTiers(before, tiers(["x"], ["y"], ["b", "a"])), ["heavy"]);
	assert.deepEqual(changedTiers(before, structuredClone(before)), []);
});

// ---- the report -----------------------------------------------------------------

test("the captain's case: every tier on opus-5 while opus-5-5 is enabled is reported, not silent", () => {
	const cfg = mergeConfig(DEFAULT_CONFIG, { tiers: tiers([opus5.provider + "/" + opus5.id], ["claude-bridge/claude-opus-5"], ["claude-bridge/claude-opus-5"]) });
	const registry = fakeRegistry(CATALOG);
	const offered = offeredModels([{ model: opus5 }, { model: opus55 }], registry);
	const report = reportTiers(cfg.tiers, offered, factsCache({ cfg, registry, ledger: ledger() }));

	assert.equal(offered.explicit, true);
	assert.deepEqual(
		report.untiered.map((f) => f.key),
		["claude-bridge/claude-opus-5-5"],
	);
	assert.match(reportLines(report).join("\n"), /in no tier, never routed to: claude-bridge\/claude-opus-5-5 \(subscription/);
});

test("a tier entry pi does not have, cannot authenticate, or may not bill is unusable, with the reason", () => {
	const cfg = mergeConfig(DEFAULT_CONFIG, {
		tiers: tiers(["nope/missing"], ["xai/grok-4.6"], ["claude-bridge/claude-opus-5", "someone/billed"]),
		billing: { ...DEFAULT_CONFIG.billing, allowPayPerToken: [] },
	});
	const billed = model("someone", "billed", { input: 1, output: 2 });
	const registry = fakeRegistry([...CATALOG, billed], { unauthed: ["xai"] });
	const report = reportTiers(cfg.tiers, offeredModels([], registry), factsCache({ cfg, registry, ledger: ledger() }));

	assert.deepEqual(
		report.unusable.map((u) => [u.tier, u.position, u.key, u.state]),
		[
			["light", 1, "nope/missing", "unknown"],
			["standard", 1, "xai/grok-4.6", "no-auth"],
			["heavy", 2, "someone/billed", "excluded"],
		],
	);
	assert.match(report.unusable[2]!.why, /not in billing\.allowPayPerToken/);
});

test("without an explicit enabled set only no-marginal-cost models are flagged, and billed ones are counted", () => {
	const cfg = mergeConfig(DEFAULT_CONFIG, { tiers: tiers([], [], ["claude-bridge/claude-opus-5"]) });
	const registry = fakeRegistry(CATALOG);
	const report = reportTiers(cfg.tiers, offeredModels([], registry), factsCache({ cfg, registry, ledger: ledger() }));

	assert.deepEqual(
		report.untiered.map((f) => f.key).sort(),
		["claude-bridge/claude-opus-5-5", "openai-codex/gpt-6-astra"],
	);
	// openrouter and xai bill per token and are allowed to: offered, eligible, but not flagged one by one.
	assert.equal(report.untieredQuiet, 2);
	assert.deepEqual(report.empty, ["light", "standard"]);
});

// ---- text-preserving write -----------------------------------------------------------

const HAND_WRITTEN = `{
    "notifyOnSwitch": false,
    "tiers": {
        "light": ["openrouter/z-ai/glm-5.3"],
        "heavy": [
            "claude-bridge/claude-opus-5",
            "anthropic/claude-opus-5"
        ]
    },
    "models": { "claude-bridge/*": { "billing": "plan" } },
    "billing": {
        "allowPayPerToken": ["openrouter/*"],
        "probe": { "enabled": false }
    }
}
`;

test("only the changed tier's text changes; every other byte stays where it was", () => {
	const out = editTiersText(HAND_WRITTEN, { light: ["ds4/deepseek-v4-flash", "openrouter/z-ai/glm-5.3"] });
	assert.equal(
		out,
		HAND_WRITTEN.replace(`"light": ["openrouter/z-ai/glm-5.3"]`, `"light": ["ds4/deepseek-v4-flash", "openrouter/z-ai/glm-5.3"]`),
	);
});

test("a one-item-per-line tier keeps that layout", () => {
	const out = editTiersText(HAND_WRITTEN, { heavy: ["claude-bridge/claude-opus-5-5", "claude-bridge/claude-opus-5"] });
	assert.equal(
		out,
		HAND_WRITTEN.replace(
			`"claude-bridge/claude-opus-5",\n            "anthropic/claude-opus-5"`,
			`"claude-bridge/claude-opus-5-5",\n            "claude-bridge/claude-opus-5"`,
		),
	);
});

test("a tier the file does not state is added beside the others in the file's own indentation", () => {
	const out = editTiersText(HAND_WRITTEN, { standard: ["openai-codex/gpt-6-astra"] });
	assert.ok(out.includes(`"anthropic/claude-opus-5"\n        ],\n        "standard": ["openai-codex/gpt-6-astra"]\n    },`), out);
	assert.deepEqual(JSON.parse(out).tiers.standard, ["openai-codex/gpt-6-astra"]);
});

test("a file with no tiers gets them, and nothing else moves", () => {
	const text = `{\n\t"notifyOnSwitch": false,\n\t"billing": { "allowPayPerToken": [] }\n}\n`;
	const out = editTiersText(text, { heavy: ["a/b"] });
	assert.equal(out, `{\n\t"notifyOnSwitch": false,\n\t"billing": { "allowPayPerToken": [] },\n\t"tiers": {\n\t\t"heavy": ["a/b"]\n\t}\n}\n`);
	const oneLine = editTiersText(`{"enabled": true}`, { light: [] });
	assert.equal(oneLine, `{"enabled": true, "tiers": { "light": [] }}`);
	assert.equal(editTiersText(`{}`, { light: ["a/b"] }), `{ "tiers": { "light": ["a/b"] } }`);
	assert.deepEqual(JSON.parse(editTiersText("", { light: ["a/b"] })), { tiers: { light: ["a/b"] } });
});

test("strings containing braces, quotes and escapes do not confuse the edit", () => {
	const text = `{ "jev": { "apiKeyEnv": "A}\\"]{" }, "tiers": { "heavy": ["x/y"] } }`;
	const out = editTiersText(text, { heavy: ["p/q"] });
	assert.deepEqual(JSON.parse(out), { jev: { apiKeyEnv: 'A}"]{' }, tiers: { heavy: ["p/q"] } });
});

test("round trip: the router loads what was written, and untouched keys come back unchanged", () => {
	writeFileSync(GLOBAL, HAND_WRITTEN);
	const before = loadConfig(mkdtempSync(join(tmpdir(), "mr-cwd-"))).config;
	const res = writeGlobalTiers(GLOBAL, { heavy: ["claude-bridge/claude-opus-5-5"] }, readGlobalTiers(GLOBAL).tiers);
	const after = loadConfig(mkdtempSync(join(tmpdir(), "mr-cwd-"))).config;

	assert.deepEqual(res.written, ["heavy"]);
	assert.deepEqual(after.tiers.heavy, ["claude-bridge/claude-opus-5-5"]);
	for (const key of Object.keys(before) as (keyof RouterConfig)[]) {
		if (key !== "tiers") assert.deepEqual(after[key], before[key], key);
	}
	assert.deepEqual(after.tiers.light, before.tiers.light);
	assert.equal(readFileSync(res.backup!, "utf8"), HAND_WRITTEN, "the previous file is kept");
	assert.deepEqual(
		Object.keys(JSON.parse(readFileSync(GLOBAL, "utf8"))),
		["notifyOnSwitch", "tiers", "models", "billing"],
		"no key is added or reordered",
	);
});

test("a tier changed on disk since the picker opened is a conflict, and nothing is written", () => {
	writeFileSync(GLOBAL, HAND_WRITTEN);
	const opened = readGlobalTiers(GLOBAL).tiers;
	const edited = HAND_WRITTEN.replace(`"light": ["openrouter/z-ai/glm-5.3"]`, `"light": ["ds4/deepseek-v4-flash"]`);
	writeFileSync(GLOBAL, edited);
	assert.throws(() => writeGlobalTiers(GLOBAL, { light: ["x/y"] }, opened), /changed tier "light" on disk/);
	assert.equal(readFileSync(GLOBAL, "utf8"), edited);
	// A different tier is still free to save: the other edit survives it.
	writeGlobalTiers(GLOBAL, { heavy: ["x/y"] }, opened);
	assert.deepEqual(JSON.parse(readFileSync(GLOBAL, "utf8")).tiers, { light: ["ds4/deepseek-v4-flash"], heavy: ["x/y"] });
});

test("a file that is not valid JSON is never written over", () => {
	writeFileSync(GLOBAL, `{ "tiers": { "heavy": ["a/b"], } }`);
	assert.throws(() => writeGlobalTiers(GLOBAL, { heavy: ["c/d"] }, {}), /not valid JSON/);
	assert.equal(readFileSync(GLOBAL, "utf8"), `{ "tiers": { "heavy": ["a/b"], } }`);
});

test("a symlinked global file stays a symlink; its target is what gets edited", () => {
	const dir = mkdtempSync(join(tmpdir(), "mr-dotfiles-"));
	const target = join(dir, "modelrouter.json");
	writeFileSync(target, `{ "tiers": { "heavy": ["a/b"] } }`);
	const link = join(mkdtempSync(join(tmpdir(), "mr-agent-link-")), "modelrouter.json");
	symlinkSync(target, link);
	writeGlobalTiers(link, { heavy: ["c/d"] }, { heavy: ["a/b"] });
	assert.equal(realpathSync(link), realpathSync(target));
	assert.deepEqual(JSON.parse(readFileSync(target, "utf8")).tiers.heavy, ["c/d"]);
});

// ---- the picker, headless -------------------------------------------------------------

function picker(global: TierLists, extra: { project?: Partial<TierLists>; offered?: Model<Api>[] } = {}) {
	const registry = fakeRegistry(CATALOG);
	let result: PickerSave | undefined | "open" = "open";
	const cfg = mergeConfig(DEFAULT_CONFIG, { tiers: global });
	const c: Component = createModelPicker(
		{
			cfg,
			registry,
			ledger: ledger(),
			global,
			project: extra.project ?? {},
			offered: offeredModels((extra.offered ?? [opus5, opus55, codex]).map((model) => ({ model })), registry),
			path: "~/.pi/agent/modelrouter.json",
		},
		plain,
		() => {},
		(r) => (result = r),
	);
	const press = (...keys: string[]) => {
		for (const k of keys) c.handleInput!(k);
	};
	return { press, screen: () => c.render(120).join("\n"), result: () => result };
}

test("the picker shows the untiered model as the first thing to add", () => {
	const p = picker(tiers(["claude-bridge/claude-opus-5"], ["claude-bridge/claude-opus-5"], ["claude-bridge/claude-opus-5"]));
	const screen = p.screen();
	assert.match(screen, /\[router models\]/);
	assert.match(screen, /⚠ in no tier, never routed to: claude-bridge\/claude-opus-5-5/);
	const add = screen.slice(screen.indexOf("add to light"));
	assert.match(add.split("\n")[1]!, /\+ claude-bridge\/claude-opus-5-5 .*subscription \(unverified\).*⚠ in no tier/);
});

test("add, reorder to first, save: the draft handed back is the new preference order", () => {
	const p = picker(tiers([OPUS], [OPUS], [OPUS]));
	p.press(KEY.tab, KEY.tab); // light -> standard -> heavy
	p.press(KEY.down, KEY.enter); // cursor onto the first pool model (opus-5-5) and add it
	assert.match(p.screen(), /2\. claude-bridge\/claude-opus-5-5/);
	p.press(KEY.up, KEY.up, KEY.down, KEY.shiftUp); // onto entry #2 and move it up
	assert.match(p.screen(), /1\. claude-bridge\/claude-opus-5-5/);
	assert.match(p.screen(), /● unsaved/);
	p.press(KEY.ctrlS);
	assert.deepEqual(p.result(), { tiers: tiers([OPUS], [OPUS], ["claude-bridge/claude-opus-5-5", OPUS]), preference: [...DEFAULT_CONFIG.preference] });
});

test("Esc with unsaved changes asks once before discarding", () => {
	const p = picker(tiers([OPUS], [OPUS], [OPUS]));
	p.press(KEY.left, KEY.enter); // light -> heavy, then remove its only entry
	assert.match(p.screen(), /heavy 0 ✗/);
	p.press(KEY.esc);
	assert.equal(p.result(), "open");
	assert.match(p.screen(), /Esc again to discard/);
	p.press(KEY.esc);
	assert.equal(p.result(), undefined);
});

test("the picker opens on the first tier with a problem", () => {
	const p = picker(tiers(["claude-bridge/claude-opus-5"], ["claude-bridge/claude-opus-5"], ["nope/missing"]));
	assert.match(p.screen(), /add to heavy/);
	assert.match(p.screen(), /heavy 1 ✗/);
});

test("typing filters the models to add; Tab moves between tiers", () => {
	const p = picker(tiers(["claude-bridge/claude-opus-5"], [], []));
	assert.match(p.screen(), /add to standard/, "standard is the first empty tier");
	p.press(KEY.tab, KEY.tab); // standard -> heavy -> light
	for (const ch of "codex") p.press(ch);
	const screen = p.screen();
	assert.match(screen, /add to light/);
	assert.match(screen, /\+ openai-codex\/gpt-6-astra/);
	assert.doesNotMatch(screen, /\+ claude-bridge/);
	p.press(KEY.enter, KEY.ctrlS);
	assert.deepEqual(p.result(), { tiers: tiers(["claude-bridge/claude-opus-5", "openai-codex/gpt-6-astra"], [], []), preference: [...DEFAULT_CONFIG.preference] });
});

test("a scrolled list counts every hidden line above and below", () => {
	const many = Array.from({ length: 30 }, (_, i) => model("openrouter", `m-${String(i).padStart(2, "0")}`, { input: 1, output: 1 }));
	const p = picker(tiers([OPUS], [OPUS], [OPUS]), { offered: many });
	for (let i = 0; i < 15; i++) p.press(KEY.down);
	const screen = p.screen().split("\n");
	const above = screen.map((l) => /↑ (\d+) more/.exec(l)).find(Boolean);
	const below = screen.map((l) => /↓ (\d+) more/.exec(l)).find(Boolean);
	assert.ok(above && below, "scrolled into the middle of the list");
	// light header, OPUS, blank line, "add to light" header, then the 30 offered models.
	const listLength = 1 + 1 + 1 + 1 + many.length;
	assert.equal(Number(above[1]) + Number(below[1]) + 14 - 2, listLength);
});

test("a tier this project replaces is called out, and what it names is not reported as in no tier", () => {
	const p = picker(tiers([OPUS], [OPUS], [OPUS]), { project: { heavy: ["openai-codex/gpt-6-astra"] } });
	p.press(KEY.left);
	const screen = p.screen();
	assert.match(screen, /this project's \.pi\/modelrouter\.json sets heavy/);
	assert.match(screen, /\+ openai-codex\/gpt-6-astra .*in heavy for this project/);
	assert.doesNotMatch(screen, /in no tier, never routed to: openai-codex/);
	assert.match(screen, /in no tier, never routed to: claude-bridge\/claude-opus-5-5/);
});

// ---- the command: global file only, tiers only ------------------------------------------

test("Ctrl+P reorders the fallback list and the save hands that order back", () => {
	const p = picker(tiers([OPUS], [OPUS], [OPUS]));
	p.press("\x10");
	assert.match(p.screen(), /fallback/);
	assert.match(p.screen(), /1\. fable/);
	p.press(KEY.shiftDown);
	assert.match(p.screen(), /1\. grok/);
	assert.match(p.screen(), /2\. fable/);
	p.press(KEY.ctrlS);
	assert.deepEqual((p.result() as PickerSave).preference, ["grok", "fable", "opus", "astra"]);
});

test("in the fallback view, tier keys do nothing: no hidden tier is edited and nothing is dirty", () => {
	const p = picker(tiers([OPUS], [OPUS], [OPUS]));
	p.press("\x10", KEY.enter, "\x1b[3~", "\x1b[Z", "\x1b[6~", KEY.backspace, "x");
	assert.match(p.screen(), /1\. fable/);
	p.press(KEY.ctrlS);
	assert.equal(p.result(), "open", "nothing to save");
	p.press(KEY.tab, KEY.esc);
	assert.equal(p.result(), undefined, "closes without a discard prompt, so nothing was changed");
});

test("a save of tiers and preference together is one write whose backup is the file before the save", () => {
	writeFileSync(GLOBAL, HAND_WRITTEN);
	const res = writeGlobalTiers(GLOBAL, { heavy: ["x/y"] }, readGlobalTiers(GLOBAL).tiers, { items: ["grok", "fable"], expected: undefined });
	assert.deepEqual(res.written, ["heavy"]);
	assert.equal(res.preference, true);
	const written = JSON.parse(readFileSync(GLOBAL, "utf8"));
	assert.deepEqual(written.tiers.heavy, ["x/y"]);
	assert.deepEqual(written.preference, ["grok", "fable"]);
	assert.equal(readFileSync(res.backup!, "utf8"), HAND_WRITTEN);

	// A preference changed on disk is a conflict for the whole save: the tiers are not written either.
	const onDisk = readFileSync(GLOBAL, "utf8");
	assert.throws(
		() => writeGlobalTiers(GLOBAL, { light: ["p/q"] }, { light: written.tiers.light }, { items: ["opus"], expected: undefined }),
		/changed "preference" on disk/,
	);
	assert.equal(readFileSync(GLOBAL, "utf8"), onDisk);
});

test("/router models writes the global tiers and nothing else: not the project file, not a global-only key", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "mr-project-"));
	mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	const projectFile = join(cwd, CONFIG_DIR_NAME, "modelrouter.json");
	const projectText = `{ "tiers": { "light": ["openrouter/z-ai/glm-5.3"] }, "billing": { "allowPayPerToken": ["*"] } }\n`;
	writeFileSync(projectFile, projectText);
	writeFileSync(GLOBAL, HAND_WRITTEN);

	const registry = fakeRegistry(CATALOG);
	const cards: { title: string; lines: string[] }[] = [];
	let reloaded = 0;
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		modelRegistry: registry,
		scopedModels: [opus5, opus55].map((model) => ({ model })),
		ui: {
			notify: () => {},
			custom: async <T>(factory: (tui: unknown, theme: Theme, kb: unknown, done: (r: T) => void) => Component) => {
				let out: T | undefined;
				const c = factory({ requestRender: () => {} }, plain, undefined, (r) => (out = r));
				// Opens on standard (xai may not bill per token here); Tab to heavy, add opus-5-5, save.
				assert.match(c.render(120).join("\n"), /add to standard/);
				for (const k of [KEY.tab, KEY.down, KEY.down, KEY.enter, KEY.ctrlS]) c.handleInput!(k);
				return out as T;
			},
		},
	} as unknown as ExtensionCommandContext;

	await runModelsCommand({
		ctx,
		cfg: loadConfig(cwd).config,
		ledger: ledger(),
		reload: async () => {
			reloaded++;
			return loadConfig(cwd).config;
		},
		showCard: (title, lines) => cards.push({ title, lines }),
	});

	assert.equal(readFileSync(projectFile, "utf8"), projectText, "the project file is never written");
	const written = JSON.parse(readFileSync(GLOBAL, "utf8"));
	const original = JSON.parse(HAND_WRITTEN);
	assert.deepEqual(written.tiers.heavy, ["claude-bridge/claude-opus-5", "anthropic/claude-opus-5", "claude-bridge/claude-opus-5-5"]);
	assert.deepEqual({ ...written, tiers: undefined }, { ...original, tiers: undefined }, "global-only keys are untouched");
	assert.deepEqual(written.tiers.light, original.tiers.light, "a tier the project overrides is not copied into the global file");
	assert.equal(reloaded, 1, "the change is applied the way /router reload applies it");
	assert.match(cards[0]!.lines[0]!, /saved heavy to .*modelrouter\.json \(previous copy: .*\.bak\)/);
	assert.ok(existsSync(`${realpathSync(GLOBAL)}.bak`));
});
