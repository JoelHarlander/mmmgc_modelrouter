/**
 * Shared-usage-file safety: two sessions writing the same ledger must both survive, and quota
 * facts must settle by recency rather than by whoever saved last.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG, type RouterConfig } from "../src/config.ts";
import { clearLedgerLock, Ledger, ledgerPath } from "../src/ledger.ts";

const cfg: RouterConfig = DEFAULT_CONFIG;

function scratch(): string {
	return ledgerPath(mkdtempSync(join(tmpdir(), "mr-ledger-")));
}

function usage(tokens: number, costUsd = 0): Usage {
	return { input: tokens, output: tokens, cacheRead: 0, cacheWrite: 0, totalTokens: tokens * 2, cost: { input: costUsd, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd } };
}

function readFile(file: string): { totals: Record<string, { calls: number; input: number; costUsd: number }>; providers: Record<string, { windows: Record<string, { utilization?: number; lastSeen: number }> }> } {
	return JSON.parse(readFileSync(file, "utf8"));
}

test("two concurrent sessions both keep their token totals in the shared file", () => {
	const file = scratch();
	const a = new Ledger(file);
	const b = new Ledger(file);

	a.record("claude-bridge", "claude-opus-5", usage(100, 0.5));
	a.save();
	// b started before a's write and does not know about it; its own save must not erase it.
	b.record("claude-bridge", "claude-opus-5", usage(10, 0.25));
	b.save();

	const totals = readFile(file).totals["claude-bridge/claude-opus-5"]!;
	assert.equal(totals.calls, 2, "both calls survived");
	assert.equal(totals.input, 110);
	assert.equal(totals.costUsd, 0.75);
});

test("interleaved saves accumulate rather than overwrite", () => {
	const file = scratch();
	const a = new Ledger(file);
	const b = new Ledger(file);
	for (let i = 0; i < 5; i++) {
		a.record("p", "m", usage(1));
		a.save();
		b.record("p", "m", usage(1));
		b.save();
	}
	assert.equal(readFile(file).totals["p/m"]!.calls, 10);
});

test("a third session sees the merged file and adds to it", () => {
	const file = scratch();
	const a = new Ledger(file);
	a.record("p", "m", usage(7));
	a.save();
	const c = new Ledger(file);
	c.record("p", "m", usage(3));
	c.save();
	assert.equal(readFile(file).totals["p/m"]!.input, 10);
});

test("the newer quota window wins when two sessions observed different responses", () => {
	const file = scratch();
	const a = new Ledger(file);
	const b = new Ledger(file);
	const t0 = Date.now();
	a.observeResponse("claude-bridge", 200, { "anthropic-ratelimit-unified-7d-utilization": "0.2" }, cfg, t0);
	a.save();
	b.observeResponse("claude-bridge", 200, { "anthropic-ratelimit-unified-7d-utilization": "0.9" }, cfg, t0 + 1000);
	b.save();
	assert.equal(readFile(file).providers["claude-bridge"]!.windows["7d"]!.utilization, 0.9);

	// And the older observation replayed afterwards does not roll the fresher one back.
	a.save();
	assert.equal(readFile(file).providers["claude-bridge"]!.windows["7d"]!.utilization, 0.9);
});

test("a stale lock left by a crashed session is broken instead of blocking forever", () => {
	const file = scratch();
	mkdirSync(`${file}.lock`);
	// Backdate the lock so it reads as abandoned.
	const past = new Date(Date.now() - 60_000);
	utimesSync(`${file}.lock`, past, past);

	const l = new Ledger(file);
	l.record("p", "m", usage(1));
	l.save();
	assert.ok(existsSync(file), "the save went through");
	assert.equal(readFile(file).totals["p/m"]!.calls, 1);
	clearLedgerLock(file);
});

test("a v2 ledger file is upgraded rather than discarded", () => {
	// A file a concurrent session may still be writing: dropping it would erase that session's
	// totals and every quota window it has learned.
	const file = scratch();
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify({
			version: 2,
			totals: { "p/m": { calls: 3, input: 30, output: 3, cacheRead: 0, cacheWrite: 0, costUsd: 1 } },
			providers: { p: { windows: { "5h": { utilization: 0.4, source: "header", lastSeen: 1 } }, cooldownUntil: 99, lastSeen: 1 } },
		}),
	);
	const l = new Ledger(file);
	l.record("p", "m", usage(1));
	l.save();

	const after = readFile(file);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 3);
	assert.equal(after.totals["p/m"]!.calls, 4, "totals survive");
	assert.equal(after.providers.p!.windows["5h"]!.utilization, 0.4, "and so does the quota state");
});

test("a v1 ledger file is read and upgraded without losing totals", () => {
	const file = scratch();
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, JSON.stringify({ version: 1, totals: { "p/m": { calls: 3, input: 30, output: 3, cacheRead: 0, cacheWrite: 0, costUsd: 1 } }, plans: { p: { utilization: 0.4, lastSeen: 1 } } }));
	const l = new Ledger(file);
	l.record("p", "m", usage(1));
	l.save();
	const after = readFile(file);
	assert.equal(after.totals["p/m"]!.calls, 4);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 3);
});

test("a corrupt ledger file does not throw and is replaced on the next save", () => {
	const file = scratch();
	writeFileSync(file, "{not json");
	const l = new Ledger(file);
	l.record("p", "m", usage(2));
	l.save();
	assert.equal(readFile(file).totals["p/m"]!.calls, 1);
});
