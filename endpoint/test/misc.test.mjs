import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forgetListings, resolveModel, upstreamOf } from "../src/models.mjs";
import { loadState, normalize, normalizeGates } from "../src/store.mjs";
import { seriesPattern as matcherFor } from "../src/policy.mjs";
import { globMatch, newestFirst, versionCompare } from "../src/policy.mjs";

test("version ordering matches the pi extension: newest first, dated snapshots are not versions, shorter id wins a tie", () => {
  assert.ok(versionCompare("claude-opus-5-5", "claude-opus-5") > 0);
  assert.ok(versionCompare("grok-4.7", "grok-4.6") > 0);
  assert.ok(versionCompare("claude-opus-5-5", "claude-opus-5-20260101") > 0);
  const ids = ["z-ai/glm-5.2", "z-ai/glm-5.3-flash", "z-ai/glm-5.3", "z-ai/glm-4.5v"];
  assert.deepEqual([...ids].sort(newestFirst), ["z-ai/glm-5.3", "z-ai/glm-5.3-flash", "z-ai/glm-5.2", "z-ai/glm-4.5v"]);
  assert.deepEqual(["claude-opus-5-5-20260101", "claude-opus-5-5"].sort(newestFirst)[0], "claude-opus-5-5");
});

test("globMatch treats only * as special", () => {
  assert.ok(globMatch("z-ai/glm-*", "z-ai/glm-5.3"));
  assert.ok(!globMatch("z-ai/glm-*", "other/z-ai/glm-5.3"));
  assert.ok(globMatch("a.b", "a.b") && !globMatch("a.b", "axb"));
});

test("model resolution: pinned beats everything, Claude accounts use the CLI alias, others take the newest listed match", async () => {
  forgetListings();
  const listing = async () => new Response(JSON.stringify({ data: ["z-ai/glm-5.2", "z-ai/glm-5.3", "z-ai/glm-5.3:batch", "z-ai/glm-5.3-flash", "z-ai/glm-5.4:batch"].map((id) => ({ id })) }), { status: 200 });
  const or = { id: "or", kind: "openai", baseUrl: "http://x/v1", modelGlob: "z-ai/glm-*" };
  assert.deepEqual(await resolveModel({ ...or, models: { backup: "z-ai/glm-5.2" } }, "backup", { fetchImpl: listing }), { model: "z-ai/glm-5.2", how: "pinned" });
  assert.deepEqual(await resolveModel(or, "backup", { fetchImpl: listing }), { model: "z-ai/glm-5.3", how: "latest" }, ":batch variants are routes, not newer models");
  forgetListings();
  assert.deepEqual(await resolveModel({ ...or, modelGlob: "z-ai/glm-*:batch" }, "backup", { fetchImpl: listing }), { model: "z-ai/glm-5.4:batch", how: "latest" }, "unless the glob asks for one");
  forgetListings();
  assert.deepEqual(await resolveModel({ id: "c", kind: "claude-code" }, "sonnet"), { model: "sonnet", how: "alias" });
  assert.deepEqual(await resolveModel({ id: "c", kind: "claude-code", models: { opus: "claude-opus-5" } }, "opus"), { model: "claude-opus-5", how: "pinned" });
  await assert.rejects(() => resolveModel({ id: "c", kind: "claude-code", latest: false }, "opus"), /latest is off and no model is pinned/);
  forgetListings();
  await assert.rejects(() => resolveModel({ ...or, id: "dead" }, "backup", { fetchImpl: async () => { throw new Error("down"); } }), /no listed model matches/);
});

test("upstreams: codex is refused by name, pi-auth needs a known provider, and nothing is guessed", async () => {
  await assert.rejects(() => upstreamOf({ id: "x", kind: "pi-auth", provider: "openai-codex" }, "/none"), /stays on pi's own provider/);
  await assert.rejects(() => upstreamOf({ id: "x", kind: "pi-auth", provider: "mystery" }, "/none"), /no baseUrl/);
  await assert.rejects(() => upstreamOf({ id: "x", kind: "openai" }), /no baseUrl/);
  assert.deepEqual(await upstreamOf({ id: "x", kind: "openai", baseUrl: "http://h/v1/", apiKey: "k" }), { base: "http://h/v1", token: "k" });
});

test("a pi OAuth login near expiry is refreshed through pi before use; a fresh one and an API key are used as is", async () => {
  const { piToken } = await import("../src/auth.mjs");
  const dir = mkdtempSync(join(tmpdir(), "piauth-"));
  const authPath = join(dir, "auth.json");
  const now = 1_800_000_000_000;
  writeFileSync(authPath, JSON.stringify({
    fresh: { type: "oauth", access: "A1", refresh: "R1", expires: now + 3600_000 },
    stale: { type: "oauth", access: "A2", refresh: "R2", expires: now + 30_000 },
    key: { type: "api_key", key: "K" },
  }));
  const calls = [];
  const refreshImpl = async (provider) => (calls.push(provider), { access: "A2-new" });
  assert.deepEqual(await piToken(authPath, "fresh", { now, refreshImpl }), { token: "A1" });
  assert.deepEqual(await piToken(authPath, "key", { now, refreshImpl }), { token: "K" });
  assert.deepEqual(await piToken(authPath, "stale", { now, refreshImpl }), { token: "A2-new", refreshed: true });
  assert.deepEqual(calls, ["stale"], "only the expiring one is refreshed");
  await assert.rejects(() => piToken(authPath, "stale", { now, refreshImpl: async () => undefined }), /could not be refreshed; open pi/);
  await assert.rejects(() => piToken(authPath, "nope", { now }), /no nope credential/);
  await assert.rejects(() => piToken(authPath, "stale", { now, piDir: "/nonexistent" }), /refresh code was not found/);
});

test("the state file is created 0600 on first run, and an unreadable one is never overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  const path = join(dir, "state.json");
  const fresh = loadState(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(fresh.token.length >= 32);
  assert.equal(loadState(path).token, fresh.token, "the token is stable across restarts");

  writeFileSync(path, "{ this is not json");
  assert.throws(() => loadState(path), /not valid JSON.*will not be overwritten/);
  assert.equal(readFileSync(path, "utf8"), "{ this is not json", "the broken file is untouched");
});

test("a hand-edited state with wrong shapes degrades to defaults instead of breaking a turn", () => {
  const state = normalize({ accounts: [{ id: "a" }, null, { nope: 1 }], preference: "opus", gates: [{ series: "opus", at: 0.5 }, { series: "x", at: 9 }, 3], tiers: [], decisions: "x", rr: null });
  assert.deepEqual(state.accounts.map((a) => a.id), ["a"]);
  assert.deepEqual(state.preference, ["opus", "sonnet"]);
  assert.deepEqual(state.gates, [{ series: "opus", at: 0.5 }]);
  assert.deepEqual(state.tiers, {});
  assert.deepEqual(state.decisions, []);
  assert.deepEqual(normalizeGates("nope"), []);
});

test("the service entry point starts even when reached through a symlinked path", async () => {
  // Regression: an "am I the main module?" check compared a real path with argv[1] and silently
  // did nothing (exit 0) when the install lived behind a symlink, as /home -> /var/home does on Fedora Atomic.
  const { spawn } = await import("node:child_process");
  const { symlinkSync, realpathSync } = await import("node:fs");
  const link = join(mkdtempSync(join(tmpdir(), "link-")), "via-symlink");
  symlinkSync(realpathSync(join(import.meta.dirname, "..")), link);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [join(link, "src", "main.mjs")], {
    env: { PATH: process.env.PATH, ROUTER_PORT: String(port), ROUTER_STATE: join(mkdtempSync(join(tmpdir(), "state-")), "s.json"), LAYA_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited;
  child.on("exit", (code) => (exited = code));
  try {
    let ok = false;
    for (let i = 0; i < 40 && !ok && exited === undefined; i++) {
      await new Promise((r) => setTimeout(r, 100));
      ok = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
    }
    assert.equal(exited, undefined, `the process exited early with ${exited}`);
    assert.ok(ok, "it answers /healthz");
  } finally {
    child.kill("SIGTERM");
  }
});

test("a bad state file makes the service fail loudly, not exit 0", async () => {
  const { spawnSync } = await import("node:child_process");
  const state = join(mkdtempSync(join(tmpdir(), "state-")), "s.json");
  writeFileSync(state, "{ nope");
  const out = spawnSync(process.execPath, [join(import.meta.dirname, "..", "src", "main.mjs")], { env: { PATH: process.env.PATH, ROUTER_STATE: state }, encoding: "utf8", timeout: 10000 });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /not valid JSON.*will not be overwritten/);
});

import { createLogger } from "../src/log.mjs";

test("the log is one line per event, quotes only what needs it, and drops empty fields", () => {
  const lines = [];
  const log = createLogger({ out: { write: (l) => lines.push(l) }, enabled: true, now: () => new Date("2026-10-03T12:00:00Z") });
  log.info("turn", { account: "claude-main", route: "gate:opus>sonnet", error: 'bad "thing" happened', skipped: undefined, empty: "", ms: 12 });
  log.warn("refused", { error: "x".repeat(400) });
  assert.equal(lines[0], '2026-10-03T12:00:00.000Z info turn account=claude-main route=gate:opus>sonnet error="bad \\"thing\\" happened" ms=12\n');
  assert.ok(lines[1].length < 400, "long values are cut");
  const off = [];
  createLogger({ out: { write: (l) => off.push(l) }, enabled: false }).info("turn", { a: 1 });
  assert.deepEqual(off, [], "ROUTER_LOG=0 silences it");
});

test("a series the code has never heard of matches whole tokens, like the pi extension: sol is not solar", () => {
  const sol = matcherFor("sol");
  assert.ok(sol.test("gpt-6.1-sol") && sol.test("openai/gpt-6-sol:batch") && sol.test("sol"));
  assert.ok(!sol.test("upstage/solar-pro-3"));
  assert.ok(matcherFor("glm").test("z-ai/glm-5.3") && !matcherFor("ol").test("gpt-6.1-sol"));
  assert.ok(matcherFor("opus").test("claude-opus-5-5"), "built-ins keep their own patterns");
  assert.ok(matcherFor("c++").test("tool/c++-1") && !matcherFor("c++").test("cxx"), "regex characters in a name are literal");
});

import { effortCacheSafe, withEffort } from "../src/dispatch.mjs";

test("effort goes out in each upstream's own spelling, and a client's own setting always wins", () => {
  const body = { model: "m", messages: [] };
  assert.equal(effortCacheSafe({ kind: "claude-code" }), true);
  assert.equal(effortCacheSafe({ provider: "xai" }), true);
  assert.equal(effortCacheSafe({ provider: "openai" }), false, "OpenAI's top-level effort rewrites the cached prefix");
  assert.equal(effortCacheSafe({ provider: "openrouter" }), false);
  assert.equal(effortCacheSafe({ provider: "openai", effortCacheSafe: true }), true, "an account can say it handles the change");
  assert.deepEqual(withEffort({ provider: "xai" }, body, "low").reasoning_effort, "low");
  assert.equal(withEffort({ provider: "openrouter" }, body, "high"), body, "an unknown cache interaction means no effort");
  const safe = { provider: "openrouter", effortCacheSafe: true };
  assert.deepEqual(withEffort(safe, body, "high").reasoning, { effort: "high" });
  assert.deepEqual(withEffort(safe, body, "off").reasoning, { enabled: false });
  assert.equal(withEffort({ provider: "xai" }, body, "max").reasoning_effort, "high", "Claude-only levels map to high elsewhere");
  assert.equal(withEffort({ kind: "openai", baseUrl: "http://x" }, body, "high"), body, "an unknown upstream gets nothing: an unexpected field can be a 400");
  assert.equal(withEffort({ kind: "openai", effortParam: "reasoning_effort" }, body, "medium"), body, "effort stays off where it would bust the cache");
  assert.equal(withEffort({ kind: "openai", effortParam: "reasoning_effort", effortCacheSafe: true }, body, "medium").reasoning_effort, "medium", "unless the account says the change is safe");
  const mine = { ...body, reasoning_effort: "minimal" };
  assert.equal(withEffort({ provider: "xai" }, mine, "high"), mine, "the client chose; leave it");
  assert.equal(withEffort({ provider: "xai" }, body, undefined), body);
});

test("a dotted minor is a decimal in the endpoint too: the latest grok is grok-4.7, not grok-4.20", () => {
  const xai = ["grok-4.7", "grok-4.6", "grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning"];
  assert.equal([...xai].sort(newestFirst)[0], "grok-4.7");
  assert.ok(versionCompare("grok-4.3", "grok-4.20-0309-reasoning") > 0);
});
