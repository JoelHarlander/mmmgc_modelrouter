import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cliArgs, runClaude, transcript, windowsOf } from "../src/claude-cli.mjs";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs");
const account = (extra = {}) => ({ id: "a", kind: "claude-code", cli: FAKE, configDir: "/accounts/a", ...extra });
const body = (text) => ({ messages: [{ role: "user", content: text }] });

async function collect(events) {
  let text = "";
  let done;
  for await (const e of events) {
    if (e.text) text += e.text;
    if (e.done) done = e;
  }
  return { text, done };
}

test("a successful call streams text, reports usage and learns the account's windows", async () => {
  const seen = [];
  const out = await runClaude(account(), { model: "opus", body: body("hello there"), protocol: "openai", onWindows: (w) => seen.push(w) });
  assert.equal(out.ok, true);
  const { text, done } = await collect(out.events);
  assert.equal(text, "reply:opus:hello there");
  assert.deepEqual(done.usage, { input_tokens: 7, output_tokens: 3 });
  assert.deepEqual(Object.keys(seen[0]).sort(), ["5h", "7d"]);
  assert.equal(seen[0]["5h"].u, 0.2);
  assert.ok(seen[0]["5h"].reset > Date.now());
});

test("it runs the CLI the way pi-claude-bridge does: no tools, no persistence, no user hooks, the account's config dir", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "router-log-")), "calls.jsonl");
  process.env.FAKE_CLAUDE_LOG = log;
  try {
    const out = await runClaude(account(), { model: "sonnet", body: { system: "Be terse.", messages: [{ role: "user", content: "hi" }] }, protocol: "anthropic" });
    await collect(out.events);
  } finally {
    delete process.env.FAKE_CLAUDE_LOG;
  }
  const call = JSON.parse(readFileSync(log, "utf8").trim());
  const at = (flag) => call.argv[call.argv.indexOf(flag) + 1];
  assert.equal(at("--tools"), "");
  assert.equal(at("--setting-sources"), "");
  assert.equal(at("--model"), "sonnet");
  assert.equal(at("--system-prompt"), "Be terse.");
  for (const flag of ["--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config"]) assert.ok(call.argv.includes(flag), flag);
  assert.equal(call.configDir, "/accounts/a");
  assert.equal(call.stdin, "hi");
});

test("a model entitlement refusal is reported before any text, scoped to the series, with its reset", async () => {
  const out = await runClaude(account(), { model: "fable", body: body("hi"), protocol: "openai" });
  assert.equal(out.ok, false);
  assert.equal(out.quota, true);
  assert.equal(out.status, 429);
  assert.equal(out.scope, "series");
  assert.match(out.error, /requires usage credits/);
  assert.ok(out.resetAt > Date.now() && out.resetAt < Date.now() + 3 * 3600_000);
});

test("a five-hour rejection is account-wide and still reports the window it saw", async () => {
  const seen = [];
  const out = await runClaude(account(), { model: "limit5h", body: body("hi"), protocol: "openai", onWindows: (w) => seen.push(w) });
  assert.equal(out.ok, false);
  assert.equal(out.scope, "account");
  assert.equal(seen[0]["5h"].u, 1);
});

test("a crash with no output is a plain failure, not quota", async () => {
  const out = await runClaude(account(), { model: "broken", body: body("hi"), protocol: "openai" });
  assert.equal(out.ok, false);
  assert.equal(out.quota, false);
  assert.match(out.error, /exited 1.*boom/);
});

test("a missing binary fails cleanly", async () => {
  const out = await runClaude(account({ cli: "/nonexistent/claude" }), { model: "opus", body: body("hi"), protocol: "openai" });
  assert.equal(out.ok, false);
  assert.equal(out.quota, false);
});

test("aborting the request kills the CLI and releases its slot", async () => {
  const abort = new AbortController();
  const pending = runClaude(account(), { model: "hang", body: body("hi"), protocol: "openai", signal: abort.signal });
  setTimeout(() => abort.abort(), 150);
  const out = await pending;
  assert.equal(out.ok, false);
  const after = await runClaude(account(), { model: "opus", body: body("again"), protocol: "openai" });
  assert.equal(after.ok, true, "the concurrency slot was freed");
  await collect(after.events);
});

test("transcript sends a single turn as is and earlier turns as context", () => {
  assert.equal(transcript([{ role: "user", content: "just this" }]), "just this");
  const multi = transcript([
    { role: "system", content: "ignored here, sent as the system prompt" },
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: [{ type: "text", text: "three" }] },
  ]);
  assert.match(multi, /\[user\]\none\n\n\[assistant\]\ntwo\n\n\[user\]\nthree/);
  assert.match(multi, /Reply as the assistant to the last user message\.$/);
});

test("windowsOf maps the CLI's names and clamps", () => {
  const w = windowsOf({ unifiedWindows: { five_hour: { utilization: 1.4, resetsAt: 10 }, seven_day_opus: { utilization: 0.5 }, nope: { utilization: 0.9 }, seven_day: { utilization: "x" } } });
  assert.deepEqual(w, { "5h": { u: 1, reset: 10_000 }, "7d_opus": { u: 0.5, reset: undefined } });
  assert.deepEqual(windowsOf(undefined), {});
  assert.ok(cliArgs({ model: "m", system: "" }).includes("You are a helpful assistant."));
});
