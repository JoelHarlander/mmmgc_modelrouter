import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/server.mjs";
import { forgetListings } from "../src/models.mjs";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs");
const TOKEN = "test-token-0123456789";
delete process.env.TYPESAFE_API_KEY;

/** An OpenAI-compatible upstream: /models lists three GLMs, /chat/completions answers or streams. */
async function startUpstream() {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      calls.push({ url: req.url, auth: req.headers.authorization, body });
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: ["z-ai/glm-5.2", "z-ai/glm-5.3", "z-ai/glm-5.3-flash", "other/model-9"].map((id) => ({ id })) }));
      }
      if (body.model === "fail-429") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "120" });
        return res.end(JSON.stringify({ error: { message: "slow down" } }));
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "he" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "llo" } }] })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.setHeader("content-type", "application/json");
      const reply = body.tools?.length
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: body.tools[0].function.name, arguments: '{"path":"a.txt"}' } }] }
        : { role: "assistant", content: `upstream:${body.model}` };
      res.end(JSON.stringify({ choices: [{ index: 0, message: reply, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { calls, base: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() };
}

let upstream;
before(async () => {
  upstream = await startUpstream();
});
after(() => upstream.close());

const claude = (id, series, extra = {}) => ({ id, kind: "claude-code", enabled: true, series, cli: FAKE, configDir: `/accounts/${id}`, ...extra });
const backup = () => ({ id: "or", kind: "openai", enabled: true, backup: true, series: ["backup"], baseUrl: upstream.base, modelGlob: "z-ai/glm-*" });

async function boot(accounts, extra = {}) {
  forgetListings();
  const state = {
    host: "127.0.0.1", port: 0, token: TOKEN, layaUrl: "", preference: ["opus", "sonnet"], gates: [], tiers: {}, cooldownFallbackMs: 60_000,
    accounts, rr: {}, decisions: [], ...extra,
  };
  const app = createApp({ state, persist: false, authPath: join(mkdtempSync(join(tmpdir(), "auth-")), "auth.json") });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (path, body, headers = {}) =>
    fetch(base + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { app, state, base, call, close: () => app.server.close() };
}

const chat = (content, extra = {}) => ({ model: "auto", messages: [{ role: "user", content }], ...extra });

test("the UI and healthz are open; the model and admin APIs need the token", async () => {
  const t = await boot([claude("a", ["opus"])]);
  try {
    assert.equal((await fetch(`${t.base}/healthz`)).status, 200);
    const page = await fetch(`${t.base}/`);
    assert.match(await page.text(), /<title>Router<\/title>/);
    for (const path of ["/v1/models", "/api/status"]) assert.equal((await fetch(t.base + path)).status, 401, path);
    assert.equal((await fetch(`${t.base}/v1/chat/completions`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await t.call("/v1/models", undefined, { authorization: "Bearer wrong" })).status, 401);
    const status = await (await t.call("/api/status")).json();
    assert.equal(JSON.stringify(status).includes(TOKEN), false, "the token is never echoed back");
    assert.deepEqual((await (await t.call("/v1/models")).json()).data.map((m) => m.id), ["auto"]);
  } finally {
    t.close();
  }
});

test("OpenAI and Anthropic clients both get one model, streamed or not, from a Claude subscription account", async () => {
  const t = await boot([claude("a", ["opus"])]);
  try {
    const plain = await t.call("/v1/chat/completions", chat("hello"));
    assert.equal(plain.status, 200);
    const json = await plain.json();
    assert.equal(json.choices[0].message.content, "reply:opus:hello");
    assert.equal(json.model, "auto");
    assert.equal(json.usage.total_tokens, 10);
    assert.equal(plain.headers.get("x-router-account"), "a");
    assert.equal(plain.headers.get("x-router-model"), "opus", "the CLI alias is the latest opus");

    const sse = await (await t.call("/v1/chat/completions", chat("hello", { stream: true }))).text();
    const deltas = [...sse.matchAll(/^data: (\{.*\})$/gm)].map((m) => JSON.parse(m[1]).choices[0].delta.content).filter(Boolean);
    assert.equal(deltas.join(""), "reply:opus:hello");
    assert.ok(deltas.length > 1, "text arrives in pieces");
    assert.match(sse, /data: \[DONE\]\n\n$/);

    const msg = await (await t.call("/v1/messages", { model: "auto", max_tokens: 64, system: "terse", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })).json();
    assert.equal(msg.type, "message");
    assert.equal(msg.content[0].text, "reply:opus:hi");

    const events = await (await t.call("/v1/messages", { model: "auto", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] })).text();
    assert.match(events, /event: message_start/);
    assert.equal([...events.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1]).join(""), "reply:opus:hi");
    assert.match(events, /event: message_stop/);
  } finally {
    t.close();
  }
});

test("a model refusal cools that series only: the same account still answers on the next series", async () => {
  const t = await boot([claude("a", ["fable", "sonnet"])], { preference: ["fable", "sonnet"] });
  try {
    const first = await t.call("/v1/chat/completions", chat("hi"));
    assert.equal(first.status, 200);
    assert.equal((await first.json()).choices[0].message.content, "reply:sonnet:hi");
    const a = t.state.accounts[0];
    assert.ok(a.coolSeries.fable - Date.now() > 7_000_000, "fable cools until the reported reset (two hours)");
    assert.equal(a.cooldownUntil, undefined, "the account itself is not cooling");
    assert.deepEqual(t.state.decisions[0].attempts.map((x) => `${x.series}:${x.ok}`), ["fable:false", "sonnet:true"]);
    // The next request does not retry fable at all.
    const second = await t.call("/v1/chat/completions", chat("again"));
    assert.equal(second.headers.get("x-router-model"), "sonnet");
    assert.equal(t.state.decisions[0].attempts, undefined, "one attempt, no failover");
  } finally {
    t.close();
  }
});

test("an account-wide rejection cools that account and fails over, so a burst keeps going on the others", async () => {
  const t = await boot([claude("limited-a", ["opus"]), claude("b", ["opus"])]);
  try {
    const first = await t.call("/v1/chat/completions", chat("hi"));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-router-account"), "b", "limited-a was tried first, refused, and b answered the same request");
    const cooling = t.state.accounts[0].cooldownUntil - Date.now();
    assert.ok(cooling > 3_500_000 && cooling <= 3_600_000, `limited-a cools until the reset the CLI reported (an hour), not a short transient pause: ${cooling}`);
    assert.equal(t.state.accounts[1].cooldownUntil, undefined);
    assert.deepEqual(t.state.decisions[0].attempts.map((a) => `${a.id}:${a.ok}`), ["limited-a:false", "b:true"]);
    const second = await t.call("/v1/chat/completions", chat("again"));
    assert.equal(t.state.decisions[0].attempts, undefined, "limited-a is not tried again while it cools");
    assert.equal(second.headers.get("x-router-account"), "b");
  } finally {
    t.close();
  }
});

test("when every account is cooling the client gets 429 with the reasons, then 503 until one resets", async () => {
  const t = await boot([claude("limited-a", ["opus"]), claude("limited-b", ["opus"])]);
  try {
    const res = await t.call("/v1/chat/completions", chat("hi"));
    assert.equal(res.status, 429);
    assert.match((await res.json()).error.message, /no account could answer.*limited-a.*limited-b/);
    const again = await t.call("/v1/chat/completions", chat("hi"));
    assert.equal(again.status, 503);
    assert.match((await again.json()).error.message, /no account available/);
  } finally {
    t.close();
  }
});

test("a gate trips from utilization the CLI reported, and later turns follow it", async () => {
  const t = await boot([claude("a", ["opus", "sonnet"])], { gates: [{ series: "opus", at: 0.5, then: "sonnet" }] });
  try {
    process.env.FAKE_UTIL = JSON.stringify({ five_hour: 0.3, seven_day_opus: 0.2 });
    assert.equal((await t.call("/v1/chat/completions", chat("one"))).headers.get("x-router-model"), "opus");
    process.env.FAKE_UTIL = JSON.stringify({ five_hour: 0.3, seven_day_opus: 0.7 });
    assert.equal((await t.call("/v1/chat/completions", chat("two"))).headers.get("x-router-model"), "opus", "the gate acts on what it has already seen");
    const third = await t.call("/v1/chat/completions", chat("three"));
    assert.equal(third.headers.get("x-router-model"), "sonnet", "opus is now past 50%");
    assert.equal(t.state.decisions[0].route, "gate:opus>sonnet");
    const status = await (await t.call("/api/status")).json();
    assert.equal(status.accounts[0].utilization.opus, 0.7);
  } finally {
    delete process.env.FAKE_UTIL;
    t.close();
  }
});

test("requests with tools skip Claude CLI accounts and reach an account that can return tool calls", async () => {
  const t = await boot([claude("a", ["opus"]), { id: "api", kind: "openai", enabled: true, series: ["opus"], baseUrl: upstream.base, models: { opus: "vendor/big-1" } }]);
  try {
    const tools = [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } } }];
    const res = await t.call("/v1/chat/completions", chat("open a.txt", { tools }));
    const json = await res.json();
    assert.equal(res.headers.get("x-router-account"), "api");
    assert.equal(json.choices[0].message.tool_calls[0].function.name, "read_file");
    const sent = upstream.calls.at(-1);
    assert.equal(sent.body.model, "vendor/big-1", "the pinned model replaces `auto`");
    assert.equal(sent.body.tools.length, 1, "tool definitions are forwarded untouched");

    const anthropic = await (await t.call("/v1/messages", { model: "auto", max_tokens: 64, messages: [{ role: "user", content: "open a.txt" }], tools: [{ name: "read_file", description: "read", input_schema: { type: "object", properties: {} } }] })).json();
    assert.equal(anthropic.stop_reason, "tool_use");
    assert.deepEqual(anthropic.content[0].input, { path: "a.txt" });
  } finally {
    t.close();
  }
});

test("the backup takes over when the subscription cools, resolves the newest GLM, and streams through untouched", async () => {
  const t = await boot([claude("a", ["limit5h"]), backup()], { preference: ["limit5h"] });
  try {
    const res = await t.call("/v1/chat/completions", chat("hi"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-router-account"), "or");
    assert.equal(res.headers.get("x-router-model"), "z-ai/glm-5.3", "newest, and the plain id over -flash");
    assert.equal((await res.json()).choices[0].message.content, "upstream:z-ai/glm-5.3");
    assert.equal(t.state.decisions[0].route, "backup");
    assert.equal(res.headers.get("x-router-route"), "backup", "a client can see that this turn was pay-per-token");

    const sse = await (await t.call("/v1/chat/completions", chat("hi", { stream: true }))).text();
    assert.match(sse, /"content":"he"/);
    assert.match(sse, /data: \[DONE\]/);
  } finally {
    t.close();
  }
});

test("a backup that is rate limited cools and the error reaches the client", async () => {
  const t = await boot([{ ...backup(), models: { backup: "fail-429" } }]);
  try {
    const res = await t.call("/v1/chat/completions", chat("hi"));
    assert.equal(res.status, 429);
    assert.ok(t.state.accounts[0].cooldownUntil - Date.now() <= 120_000, "retry-after is honoured");
  } finally {
    t.close();
  }
});

test("bad requests are 400 with the client's own error shape, and the secret never leaks", async () => {
  const t = await boot([claude("a", ["opus"])]);
  try {
    const noMessages = await t.call("/v1/chat/completions", { model: "auto" });
    assert.equal(noMessages.status, 400);
    assert.match((await noMessages.json()).error.message, /messages/);
    const broken = await fetch(`${t.base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{not json" });
    assert.equal(broken.status, 400);
    assert.equal((await broken.json()).type, "error", "Anthropic clients get Anthropic's error shape");
    assert.equal((await t.call("/nope")).status, 404);
  } finally {
    t.close();
  }
});

test("the admin API validates accounts, edits policy, and deletes", async () => {
  const t = await boot([]);
  try {
    const post = (path, body) => t.call(path, body);
    assert.equal((await post("/api/accounts", { id: "bad id!", series: ["opus"], configDir: "/x" })).status, 400);
    assert.equal((await post("/api/accounts", { id: "a", kind: "claude-code", series: ["opus"] })).status, 400, "claude-code needs a config dir");
    assert.equal((await post("/api/accounts", { id: "a", kind: "pi-auth", series: ["opus"] })).status, 400, "pi-auth needs a provider");
    assert.equal((await post("/api/accounts", { id: "a", kind: "claude-code", configDir: "/x" })).status, 400, "series or backup required");
    const exfil = await post("/api/accounts", { id: "x", kind: "pi-auth", provider: "openrouter", backup: true, baseUrl: "http://attacker.example/v1" });
    assert.equal(exfil.status, 400, "the API cannot point a pi-auth account (which sends pi's stored token) at another host");
    assert.match((await exfil.json()).error, /provider's own URL/);
    assert.equal(t.state.accounts.some((a) => a.id === "x"), false);
    const ok = await post("/api/accounts", { id: "a", kind: "claude-code", configDir: "/x", series: ["opus"], apiKey: "secret-key-value" });
    assert.equal(ok.status, 200);
    assert.equal(JSON.stringify(await ok.json()).includes("secret-key-value"), false, "keys are write-only");
    assert.equal((await post("/api/accounts", { id: "or", kind: "pi-auth", provider: "openrouter", backup: true, modelGlob: "z-ai/glm-*" })).status, 200);
    assert.deepEqual(t.state.accounts.find((a) => a.id === "or").series, ["backup"]);

    assert.equal((await post("/api/policy", { preference: [] })).status, 400);
    assert.equal((await post("/api/policy", { gates: [{ series: "opus", at: 3 }] })).status, 400);
    for (const bad of [{ light: "sonnet" }, { fast: ["sonnet"] }, { light: [] }, { light: [1] }, ["sonnet"], null]) {
      assert.equal((await post("/api/policy", { tiers: bad })).status, 400, `tiers ${JSON.stringify(bad)}`);
    }
    const policy = await post("/api/policy", { preference: ["sonnet", "opus"], gates: [{ series: "opus", at: 0.5, then: "sonnet" }], tiers: { light: ["sonnet"] } });
    assert.equal(policy.status, 200);
    assert.deepEqual(t.state.preference, ["sonnet", "opus"]);
    assert.deepEqual(t.state.gates, [{ series: "opus", at: 0.5, then: "sonnet" }]);

    assert.equal((await post("/api/accounts/update", { id: "a", enabled: false })).status, 200);
    assert.equal(t.state.accounts[0].enabled, false);
    assert.equal((await post("/api/accounts/delete", { id: "nope" })).status, 404);
    assert.equal((await post("/api/accounts/delete", { id: "a" })).status, 200);
    assert.equal(t.state.accounts.some((a) => a.id === "a"), false);
  } finally {
    t.close();
  }
});

test("every turn logs one line saying how it was routed, and no log line carries a prompt or a secret", async () => {
  const lines = [];
  const state = { host: "127.0.0.1", port: 0, token: TOKEN, layaUrl: "", preference: ["opus"], gates: [], tiers: {}, cooldownFallbackMs: 1000, rr: {}, decisions: [],
    accounts: [claude("a", ["opus"], { apiKey: "SECRET-KEY-123" })] };
  const { createLogger } = await import("../src/log.mjs");
  const app = createApp({ state, persist: false, authPath: "/none", log: createLogger({ out: { write: (l) => lines.push(l) }, enabled: true }) });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  try {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(chat("a very private prompt")) });
    await fetch(`${base}/api/accounts`, { method: "POST", headers, body: JSON.stringify({ id: "z", kind: "echo", series: ["opus"], apiKey: "SECRET-KEY-456" }) });
    const all = lines.join("");
    assert.match(lines.find((l) => l.includes(" turn ")), /info turn account=a series=opus model=opus route=open tier=\w+ via=\S+ ms=\d+/);
    assert.match(all, /account saved id=z kind=echo/);
    for (const secret of ["private prompt", "SECRET-KEY", TOKEN]) assert.equal(all.includes(secret), false, `the log must not contain ${secret}`);
  } finally {
    app.server.close();
  }
});

test("an internal error is logged, but the client gets no detail", async () => {
  const t = await boot([claude("a", ["opus"])]);
  try {
    t.state.accounts = null; // a corrupted state: pick will throw
    const res = await t.call("/v1/chat/completions", chat("hi"));
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.message, "internal error");
    const admin = await t.call("/api/status");
    assert.equal(admin.status, 500);
    assert.equal((await admin.json()).error, "internal error");
  } finally {
    t.close();
  }
});

test("pi-auth accounts read the credential from pi's auth.json at request time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-auth-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ openrouter: { type: "oauth", access: "or-live-token", refresh: "r", expires: 0 } }));
  forgetListings();
  const state = { host: "127.0.0.1", port: 0, token: TOKEN, layaUrl: "", preference: ["opus"], gates: [], tiers: {}, cooldownFallbackMs: 1000, rr: {}, decisions: [],
    accounts: [{ id: "or", kind: "pi-auth", provider: "openrouter", baseUrl: upstream.base, enabled: true, backup: true, series: ["backup"], modelGlob: "z-ai/glm-*" }] };
  const app = createApp({ state, persist: false, authPath });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  try {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(chat("hi")) });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.at(-1).auth, "Bearer or-live-token");
  } finally {
    app.server.close();
  }
});
