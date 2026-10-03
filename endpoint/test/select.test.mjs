import assert from "node:assert/strict";
import { test } from "node:test";
import { coolAccount, cooldownMs, pickAccount, preferenceFor } from "../src/select.mjs";
import { utilization } from "../src/usage.mjs";

const NOW = 1_800_000_000_000;
const win = (u, reset = NOW + 3600_000) => ({ u, reset });
const claude = (id, series, windows = {}, extra = {}) => ({
  id,
  kind: "claude-code",
  enabled: true,
  series,
  usage: { windows },
  ...extra,
});
const stateOf = (accounts, extra = {}) => ({ preference: ["opus", "sonnet"], gates: [], tiers: {}, accounts, rr: {}, ...extra });
const ids = (state, n, opts = {}) => Array.from({ length: n }, () => pickAccount(state, { now: NOW, ...opts })?.account.id);

test("accounts serving one series share its turns round-robin", () => {
  const state = stateOf([claude("a", ["opus"]), claude("b", ["opus"]), claude("c", ["opus"])]);
  assert.deepEqual(ids(state, 6), ["a", "b", "c", "a", "b", "c"]);
});

test("a gate moves an account off a series at its threshold, to the gate's `then`", () => {
  const gates = [{ series: "opus", at: 0.5, then: "sonnet" }];
  const below = stateOf([claude("a", ["opus", "sonnet"], { "5h": win(0.49) })], { gates });
  assert.equal(pickAccount(below, { now: NOW }).series, "opus");

  const at = stateOf([claude("a", ["opus", "sonnet"], { "5h": win(0.5) })], { gates });
  const pick = pickAccount(at, { now: NOW });
  assert.equal(pick.series, "sonnet");
  assert.equal(pick.via, "gate:opus>sonnet");
});

test("a gate is judged per account: an open account keeps the series while a gated one is skipped", () => {
  const gates = [{ series: "opus", at: 0.5, then: "sonnet" }];
  const state = stateOf([claude("hot", ["opus"], { "7d_opus": win(0.9) }), claude("cool", ["opus"], { "7d_opus": win(0.1) })], { gates });
  assert.deepEqual(ids(state, 3), ["cool", "cool", "cool"]);
});

test("utilization is the highest live window that bounds the series; a reset window says nothing", () => {
  const account = claude("a", ["opus"], { "5h": win(0.2), "7d": win(0.4), "7d_opus": win(0.7), "7d_sonnet": win(0.95) });
  assert.equal(utilization(account, "opus", NOW), 0.7);
  assert.equal(utilization(account, "sonnet", NOW), 0.95);
  assert.equal(utilization(account, "haiku", NOW), 0.4);
  const stale = claude("b", ["opus"], { "5h": win(0.9, NOW - 1) });
  assert.equal(utilization(stale, "opus", NOW), undefined);
  assert.equal(utilization(claude("c", ["opus"]), "opus", NOW), undefined, "no evidence, no gate");
});

test("a gate is soft: when everything is gated the least-used subscription still beats the backup", () => {
  const gates = [{ series: "opus", at: 0.5 }];
  const backup = { id: "or", kind: "pi-auth", enabled: true, backup: true, series: ["backup"], provider: "openrouter" };
  const state = stateOf([claude("a", ["opus"], { "7d_opus": win(0.9) }), claude("b", ["opus"], { "7d_opus": win(0.6) }), backup], { gates, preference: ["opus"] });
  const pick = pickAccount(state, { now: NOW });
  assert.equal(pick.account.id, "b");
  assert.equal(pick.via, "soft");
});

test("the backup serves only when no subscription account can", () => {
  const backup = { id: "or", kind: "pi-auth", enabled: true, backup: true, series: ["backup"], provider: "openrouter" };
  const a = claude("a", ["opus"]);
  const state = stateOf([a, backup], { preference: ["opus"] });
  assert.equal(pickAccount(state, { now: NOW }).account.id, "a");
  coolAccount(a, NOW, 60_000, "rate limit");
  const pick = pickAccount(state, { now: NOW });
  assert.equal(pick.account.id, "or");
  assert.equal(pick.via, "backup");
  assert.equal(pickAccount(state, { now: NOW + 61_000 }).account.id, "a", "back on the subscription once the cooldown ends");
});

test("a series cooldown cools one series on an account, not the account", () => {
  const a = claude("a", ["fable", "sonnet"]);
  const state = stateOf([a], { preference: ["fable", "sonnet"] });
  coolAccount(a, NOW, 3600_000, "credits required", "fable");
  const pick = pickAccount(state, { now: NOW });
  assert.equal(pick.series, "sonnet", "fable is cooling, sonnet is not");
  assert.equal(pickAccount(state, { now: NOW + 3601_000 }).series, "fable");
});

test("requests with tools skip accounts that cannot return tool calls", () => {
  const cli = claude("cli", ["opus"]);
  const api = { id: "api", kind: "openai", enabled: true, series: ["opus"], baseUrl: "http://x" };
  const state = stateOf([cli, api]);
  assert.deepEqual(ids(state, 2, { needsTools: true }), ["api", "api"]);
  assert.equal(pickAccount(stateOf([cli]), { now: NOW, needsTools: true }), undefined);
  assert.equal(pickAccount(stateOf([{ ...cli, tools: true }]), { now: NOW, needsTools: true }).account.id, "cli", "an explicit override wins");
});

test("tiers can steer series; unlisted tiers use the preference list", () => {
  const state = stateOf([claude("a", ["opus", "sonnet"])], { tiers: { light: ["sonnet"], heavy: ["opus"] } });
  assert.equal(pickAccount(state, { now: NOW, tier: "light" }).series, "sonnet");
  assert.equal(pickAccount(state, { now: NOW, tier: "heavy" }).series, "opus");
  assert.equal(pickAccount(state, { now: NOW, tier: "standard" }).series, "opus");
  assert.deepEqual(preferenceFor(state, "light"), ["sonnet"]);
});

test("gates that point at each other cannot loop", () => {
  const gates = [{ series: "opus", at: 0.1, then: "sonnet" }, { series: "sonnet", at: 0.1, then: "opus" }];
  const state = stateOf([claude("a", ["opus", "sonnet"], { "5h": win(0.9) })], { gates });
  assert.ok(pickAccount(state, { now: NOW }), "falls through to the soft pass");
});

test("a disabled or excluded account is never picked", () => {
  const state = stateOf([claude("a", ["opus"], {}, { enabled: false }), claude("b", ["opus"])]);
  assert.equal(pickAccount(state, { now: NOW }).account.id, "b");
  assert.equal(pickAccount(state, { now: NOW, exclude: new Set(["b"]) }), undefined);
});

test("cooldownMs reads retry-after, a clock time, or falls back", () => {
  assert.equal(cooldownMs("retry-after: 90", 5), 90_000);
  assert.equal(cooldownMs("no hint", 5), 5);
  const at = new Date(2026, 9, 3, 10, 0, 0).getTime();
  assert.equal(cooldownMs("resets at 11:00:00", 5, at), 3600_000);
  const tomorrow = new Date(2026, 9, 4, 9, 0, 0).getTime() - at; // local calendar, so a DST change in between does not matter
  assert.equal(cooldownMs("resets at 09:00", 5, at), tomorrow, "a time already past means tomorrow");
});
