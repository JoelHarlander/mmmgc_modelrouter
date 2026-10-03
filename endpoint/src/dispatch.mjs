import { runClaude } from "./claude-cli.mjs";
import { upstreamOf } from "./models.mjs";
import { anthropicToOpenaiBody } from "./protocol.mjs";
import { cooldownMs, isQuotaFailure } from "./select.mjs";
import { applyWindows } from "./usage.mjs";

/**
 * Run one turn on an already-chosen account and model. Outcomes:
 *   { ok: false, status, error, quota, resetAt?, scope?, cooldownMs? }   nothing was sent to the client
 *   { ok: true, kind: "events", events }    a Claude CLI stream: { text } then { done, usage }
 *   { ok: true, kind: "http", res }         an OpenAI-compatible reply to pass straight through
 *   { ok: true, kind: "buffered", json }    an OpenAI-compatible reply the caller must translate
 * A refusal is always reported before anything is sent, which is what lets the caller fail over.
 * @param {import("./types.js").Account} account
 * @param {{ protocol: import("./types.js").Protocol, body: any, series: string, model: string, tier?: string, signal?: AbortSignal,
 *           fetchImpl: typeof fetch, authPath: string, spawnImpl?: any }} ctx
 * @returns {Promise<import("./types.js").DispatchResult>}
 */
export async function dispatch(account, ctx) {
  if (account.kind === "echo") return echo(account, ctx);
  if (account.kind === "claude-code") return claude(account, ctx);
  if (account.kind === "openai" || account.kind === "pi-auth") return openai(account, ctx);
  return { ok: false, status: 0, error: `unknown account kind ${account.kind}`, quota: false };
}

/** A stand-in that needs no credential, for trying the plumbing. */
/** @returns {Promise<import("./types.js").DispatchResult>} */
async function echo(account, ctx) {
  const text = `pong from ${account.id} (${ctx.series}/${ctx.model}, tier ${ctx.tier})`;
  async function* events() {
    yield { text };
    yield { done: true, usage: { input_tokens: 0, output_tokens: 0 } };
  }
  return { ok: true, kind: "events", events: events() };
}

/** @returns {Promise<import("./types.js").DispatchResult>} */
async function claude(account, ctx) {
  const out = await runClaude(account, {
    model: ctx.model,
    body: ctx.body,
    protocol: ctx.protocol,
    signal: ctx.signal,
    onWindows: (windows) => applyWindows(account, windows),
    spawnImpl: ctx.spawnImpl,
  });
  if (out.ok) return { ok: true, kind: "events", events: out.events };
  return { ...out, cooldownMs: out.resetAt ? Math.max(0, out.resetAt - Date.now()) : undefined };
}

/** @returns {Promise<import("./types.js").DispatchResult>} */
async function openai(account, ctx) {
  let upstream;
  try {
    upstream = upstreamOf(account, ctx.authPath);
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err), quota: false };
  }
  const passthrough = ctx.protocol === "openai";
  const body = passthrough ? { ...ctx.body, model: ctx.model } : anthropicToOpenaiBody(ctx.body, ctx.model);
  const res = await ctx.fetchImpl(`${upstream.base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(upstream.token ? { authorization: `Bearer ${upstream.token}` } : {}) },
    body: JSON.stringify(body),
    signal: ctx.signal,
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).replace(/(sk|vck|or)-[A-Za-z0-9_-]{8,}/g, "[redacted]").slice(0, 300);
    return {
      ok: false,
      status: res.status,
      error: text || `upstream ${res.status}`,
      quota: isQuotaFailure(res.status, text),
      cooldownMs: cooldownMs(`${text}\nretry-after: ${res.headers.get("retry-after") ?? ""}`, undefined),
    };
  }
  if (passthrough) return { ok: true, kind: "http", res };
  return { ok: true, kind: "buffered", json: await res.json() };
}
