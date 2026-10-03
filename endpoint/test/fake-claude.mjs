#!/usr/bin/env node
/**
 * A stand-in for the `claude` CLI that speaks the stream-json shapes the real one emits
 * (captured from claude 2.1.284). Behaviour is chosen by `--model`:
 *   fable      the model-entitlement refusal: rate_limit_event rejected + credits_required
 *   limit5h    an account-wide rejection of the five-hour window (also any config dir named *limited*)
 *   broken     exits 1 with nothing on stdout
 *   hang       prints nothing and never exits
 *   anything   answers `reply:<model>:<first stdin line>`, reporting utilization from FAKE_UTIL
 * Every invocation appends its argv and stdin to FAKE_CLAUDE_LOG when set.
 */
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
// A config dir containing "limited" is an account whose five-hour window is spent, whatever the model.
const model = (process.env.CLAUDE_CONFIG_DIR ?? "").includes("limited") ? "limit5h" : argv[argv.indexOf("--model") + 1];
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv, stdin, configDir: process.env.CLAUDE_CONFIG_DIR })}\n`);
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const now = Math.floor(Date.now() / 1000);
  out({ type: "system", subtype: "init", model });
  if (model === "hang") return setInterval(() => {}, 1000);
  if (model === "broken") {
    process.stderr.write("boom\n");
    process.exit(1);
  }
  if (model === "fable") {
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: now + 7200, errorCode: "credits_required", isUsingOverage: false } });
    out({ type: "assistant", message: { content: [{ type: "text", text: "Fable 5.1 requires usage credits." }] }, error: "rate_limit" });
    out({ type: "result", subtype: "success", is_error: true, result: "Fable 5.1 requires usage credits.", api_error_status: 429 });
    return;
  }
  if (model === "limit5h") {
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: now + 3600, unifiedWindows: { five_hour: { utilization: 1, resetsAt: now + 3600 } } } });
    out({ type: "result", subtype: "success", is_error: true, result: "You've hit your session limit", api_error_status: 429 });
    return;
  }
  const text = `reply:${model}:${stdin.split("\n")[0]}`;
  const half = Math.ceil(text.length / 2);
  for (const piece of [text.slice(0, half), text.slice(half)]) {
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } } });
  }
  const util = JSON.parse(process.env.FAKE_UTIL || '{"five_hour":0.2,"seven_day":0.1}');
  out({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", unifiedWindows: Object.fromEntries(Object.entries(util).map(([k, u]) => [k, { utilization: u, resetsAt: now + 3600 }])) },
  });
  out({ type: "result", subtype: "success", is_error: false, result: text, usage: { input_tokens: 7, output_tokens: 3 } });
});
