import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText } from "./protocol.mjs";

/**
 * Claude subscription accounts, served the way pi-claude-bridge serves them: by running the
 * official `claude` CLI headless with that account's config dir. Nothing here calls Anthropic's
 * API with an OAuth token or presents itself as Claude Code; Claude Code makes its own requests.
 *
 * What that costs: the CLI cannot hand a client's tool definitions back as tool calls, so these
 * accounts answer text-only requests and are skipped for any request that carries `tools`.
 */

/** Window names in the CLI's `rate_limit_event.unifiedWindows` -> the ids the gates use. */
const WINDOW_IDS = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_opus: "7d_opus",
  seven_day_sonnet: "7d_sonnet",
  seven_day_overage_included: "7d_oi",
};

/** A conversation as one prompt: the CLI takes a single user turn, so earlier turns ride along as a transcript. */
export function transcript(messages) {
  const turns = (messages ?? []).filter((m) => m.role !== "system");
  const last = turns.at(-1);
  if (turns.length <= 1) return contentText(last?.content);
  const body = turns.map((m) => `[${m.role === "assistant" ? "assistant" : "user"}]\n${contentText(m.content)}`).join("\n\n");
  return `${body}\n\n[end of conversation]\nReply as the assistant to the last user message.`;
}

export function systemText(body, protocol) {
  if (protocol === "anthropic") return contentText(body.system);
  return (body.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => contentText(m.content))
    .join("\n\n");
}

export function cliArgs({ model, system }) {
  return [
    "-p",
    "--model", model,
    "--tools", "",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--strict-mcp-config",
    // Without this the user's own hooks and settings run on every request.
    "--setting-sources", "",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--system-prompt", system || "You are a helpful assistant.",
  ];
}

/** Window utilization (0..1) and resets from a `rate_limit_info`, in the shape `usage.windows` stores. */
export function windowsOf(info) {
  const out = {};
  for (const [name, w] of Object.entries(info?.unifiedWindows ?? {})) {
    const id = WINDOW_IDS[name];
    if (!id || typeof w?.utilization !== "number") continue;
    out[id] = { u: Math.min(1, Math.max(0, w.utilization)), reset: typeof w.resetsAt === "number" ? w.resetsAt * 1000 : undefined };
  }
  return out;
}

class Semaphore {
  constructor(n) {
    this.n = n;
    this.waiting = [];
  }
  async acquire() {
    if (this.n > 0) {
      this.n -= 1;
      return;
    }
    await new Promise((resolve) => this.waiting.push(resolve));
  }
  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.n += 1;
  }
}

const gate = new Semaphore(Number(process.env.ROUTER_CLAUDE_CONCURRENCY || 3));

/**
 * Run one request. Resolves once the outcome is known up to the first text, so a refusal (which
 * arrives before any text) can still fail over to another account:
 *   { ok: false, ... }                         refused or failed, nothing was sent
 *   { ok: true, events, windows }              `events` yields { text } then { done, usage }
 * `onWindows(windows)` fires whenever the CLI reports utilization, including on a refusal.
 */
export async function runClaude(account, { model, body, protocol, signal, onWindows, spawnImpl = spawn }) {
  await gate.acquire();
  const cwd = mkdtempSync(join(tmpdir(), "router-claude-"));
  const child = spawnImpl(account.cli || process.env.CLAUDE_BIN || "claude", cliArgs({ model, system: systemText(body, protocol) }), {
    cwd,
    env: { ...process.env, ...(account.configDir ? { CLAUDE_CONFIG_DIR: account.configDir } : {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let finished = false;
  let exitCode;
  const exited = new Promise((resolve) =>
    child.on("close", (code) => {
      exitCode = code ?? 1;
      resolve(exitCode);
    }),
  );
  child.on("error", () => {});
  const kill = () => {
    if (exitCode === undefined) child.kill("SIGTERM");
  };
  const timer = setTimeout(kill, Number(process.env.ROUTER_CLAUDE_TIMEOUT_MS || 300_000));
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
    kill();
    gate.release();
    rmSync(cwd, { recursive: true, force: true });
  };
  signal?.addEventListener("abort", kill, { once: true });

  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
  child.stdin.on("error", () => {});
  child.stdin.end(transcript(body.messages));

  // An explicit iterator: `for await ... break` would close the generator, and the rest is read later.
  const lines = readLines(child.stdout)[Symbol.asyncIterator]();
  let refusal;
  let first;
  try {
    for (;;) {
      const next = await lines.next();
      if (next.done) break;
      const out = interpret(next.value, onWindows);
      if (!out) continue;
      if (out.refusal) refusal = out.refusal;
      if (out.text !== undefined || out.done) {
        first = out;
        break;
      }
    }
  } catch (err) {
    finish();
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err), quota: false };
  }

  if (refusal || (first?.done && first.isError)) {
    await Promise.race([exited, new Promise((r) => setTimeout(r, 1500))]);
    finish();
    return failure(refusal ?? first, first);
  }
  if (!first) {
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 5000))]);
    finish();
    return { ok: false, status: 0, error: `claude exited ${code} with no answer${stderr ? `: ${stderr.trim().slice(-200)}` : ""}`, quota: false };
  }

  async function* events() {
    try {
      yield first;
      if (first.done) return;
      for (;;) {
        const next = await lines.next();
        if (next.done) break;
        const out = interpret(next.value, onWindows);
        if (out) yield out;
      }
    } finally {
      finish();
    }
  }
  return { ok: true, events: events() };
}

function failure(info, first) {
  const text = info?.message || first?.error || "claude refused the request";
  const quota = info?.status === 429 || first?.status === 429 || info?.rejected === true;
  return {
    ok: false,
    status: quota ? 429 : first?.status || 0,
    error: text,
    quota,
    resetAt: info?.resetAt,
    scope: info?.scope ?? "account",
  };
}

/** One stream-json line -> { text } | { done, ... } | { refusal } | undefined. */
function interpret(e, onWindows) {
  if (e.type === "rate_limit_event") {
    const info = e.rate_limit_info ?? {};
    const windows = windowsOf(info);
    if (Object.keys(windows).length > 0) onWindows?.(windows);
    if (info.status === "rejected") {
      // A model entitlement refusal (credits required) is that model's, not the account's.
      const modelScoped = info.errorCode === "credits_required" || /opus|sonnet|fable|oi/.test(String(info.rateLimitType ?? ""));
      return {
        refusal: {
          rejected: true,
          status: 429,
          resetAt: typeof info.resetsAt === "number" ? info.resetsAt * 1000 : undefined,
          scope: modelScoped ? "series" : "account",
          message: undefined,
        },
      };
    }
    return undefined;
  }
  if (e.type === "stream_event" && e.event?.type === "content_block_delta" && e.event.delta?.type === "text_delta") {
    return { text: e.event.delta.text };
  }
  if (e.type === "result") {
    return {
      done: true,
      isError: e.is_error === true,
      status: e.api_error_status ?? undefined,
      error: e.is_error ? e.result : undefined,
      message: e.is_error ? e.result : undefined,
      text: undefined,
      usage: usageOf(e),
      result: e.result,
    };
  }
  return undefined;
}

function usageOf(result) {
  const u = result.usage ?? {};
  return { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 };
}

/** NDJSON lines from a stream, whole lines only, bad lines skipped. */
async function* readLines(stream) {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // not JSON: a stray log line
      }
    }
  }
  const tail = buffer.trim();
  if (tail) {
    try {
      yield JSON.parse(tail);
    } catch {
      // ignore
    }
  }
}
