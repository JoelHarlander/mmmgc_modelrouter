import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { classify, systemOneUrl, warmLaya } from "../src/laya.mjs";

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
