import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { classify, createBreakers, systemOneUrl, warmLaya } from "../src/classifier.mjs";

async function fakeSystemOne(tier, seen) {
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "fake", answers: { tier: { type: "choice", choice: tier, confidence: 0.9 } } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

test("laya answers first; jev only when laya is down; heuristic last", async () => {
  delete process.env.TYPESAFE_API_KEY;
  const laya = [];
  const jev = [];
  const a = await fakeSystemOne("heavy", laya);
  const b = await fakeSystemOne("standard", jev);

  const first = await classify("hi", { layaUrl: a.url, typesafeUrl: b.url, authPath: "/nonexistent" });
  assert.equal(first.via, "laya");
  assert.equal(first.tier, "heavy");
  assert.equal(jev.length, 0);

  process.env.TYPESAFE_API_KEY = "ts-test";
  const second = await classify("hi", { layaUrl: "http://127.0.0.1:9/v1", typesafeUrl: b.url, authPath: "/nonexistent" });
  assert.equal(second.via, "typesafe:jev");
  assert.equal(second.tier, "standard");
  assert.equal(jev[0], "Bearer ts-test");
  assert.match(second.errors[0], /^laya:/);

  delete process.env.TYPESAFE_API_KEY;
  const third = await classify("hi", { layaUrl: "http://127.0.0.1:9/v1", typesafeUrl: b.url, authPath: "/nonexistent" });
  assert.equal(third.via, "heuristic");
  assert.match(third.errors.join(" "), /typesafe:jev: no TYPESAFE_API_KEY/);
  a.server.close();
  b.server.close();
});

test("a bare host and a /v1 base reach the same endpoint", () => {
  assert.equal(systemOneUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787/v1/systemone");
  assert.equal(systemOneUrl("http://127.0.0.1:8787/v1/"), "http://127.0.0.1:8787/v1/systemone");
  assert.equal(systemOneUrl("https://api.typesafe.ai/v1"), "https://api.typesafe.ai/v1/systemone");
});

test("warming Laya retries until it answers, never asks the hosted Jev, and gives up quietly", async () => {
  process.env.TYPESAFE_API_KEY = "ts-test";
  const hosted = [];
  const jev = await fakeSystemOne("light", hosted);
  let calls = 0;
  const flaky = createServer((req, res) => {
    calls += 1;
    res.setHeader("content-type", "application/json");
    if (calls < 3) {
      res.statusCode = 503;
      return res.end("{}");
    }
    res.end(JSON.stringify({ model: "fake", answers: { tier: { type: "choice", choice: "light", confidence: 0.9 } } }));
  });
  flaky.listen(0, "127.0.0.1");
  await once(flaky, "listening");
  try {
    const url = `http://127.0.0.1:${flaky.address().port}`;
    assert.equal(await warmLaya(url, { attempts: 5, delayMs: 10 }), true);
    assert.equal(calls, 3, "two failures, then success");
    assert.equal(await warmLaya("http://127.0.0.1:9", { attempts: 2, delayMs: 5 }), false);
    assert.equal(await warmLaya("", { attempts: 2 }), false);
    assert.equal(hosted.length, 0, "warming never spends a hosted call");
  } finally {
    delete process.env.TYPESAFE_API_KEY;
    flaky.close();
    jev.server.close();
  }
});

test("a classifier that failed is skipped for a while, so a dead Laya and a slow Jev do not tax every turn", async () => {
  process.env.TYPESAFE_API_KEY = "ts-test";
  const hosted = [];
  const jev = await fakeSystemOne("standard", hosted);
  const breakers = createBreakers();
  let clock = 1_000_000;
  const opts = { layaUrl: "http://127.0.0.1:9/v1", typesafeUrl: jev.url, authPath: "/none", breakers, now: () => clock };
  try {
    const first = await classify("hi", opts);
    assert.equal(first.via, "typesafe:jev");
    assert.match(first.errors[0], /^laya: (?!skipped)/, "the first failure is a real attempt");

    clock += 5_000;
    const second = await classify("hi", opts);
    assert.equal(second.via, "typesafe:jev");
    assert.match(second.errors[0], /^laya: skipped, failed recently \(retry in 25s\)$/, "Laya is not tried again inside its window");

    clock += 31_000;
    const third = await classify("hi", opts);
    assert.match(third.errors[0], /^laya: (?!skipped)/, "after the window it is tried again");

    // The hosted Jev fails too: heuristic immediately, then no repeat attempts inside its window.
    const failing = { ...opts, typesafeUrl: "http://127.0.0.1:9/v1", breakers: createBreakers() };
    const a = await classify("hi", failing);
    assert.equal(a.via, "heuristic");
    assert.match(a.errors.join(" "), /laya: .*typesafe:jev: /);
    const b = await classify("hi", failing);
    assert.match(b.errors.join(" "), /laya: skipped.*typesafe:jev: skipped/, "nothing is attempted, so the heuristic answers at once");

    // A success clears the breaker.
    breakers.laya = clock + 99_000;
    const healed = await fakeSystemOne("heavy", []);
    breakers.laya = 0;
    const ok = await classify("hi", { ...opts, layaUrl: healed.url, breakers });
    assert.equal(ok.via, "laya");
    assert.equal(breakers.laya, 0);
    healed.server.close();
  } finally {
    delete process.env.TYPESAFE_API_KEY;
    jev.server.close();
  }
});
