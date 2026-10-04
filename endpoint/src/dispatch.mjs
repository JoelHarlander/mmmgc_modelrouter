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
 * @param {{ protocol: import("./types.js").Protocol, body: any, series: string, model: string, tier?: string, effort?: string, signal?: AbortSignal,
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
    effort: ctx.effort,
    spawnImpl: ctx.spawnImpl,
  });
  if (out.ok) return { ok: true, kind: "events", events: out.events };
  return { ...out, cooldownMs: out.resetAt ? Math.max(0, out.resetAt - Date.now()) : undefined };
}

/** @returns {Promise<import("./types.js").DispatchResult>} */
async function openai(account, ctx) {
  let upstream;
  try {
    upstream = await upstreamOf(account, ctx.authPath);
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err), quota: false };
  }
  const passthrough = ctx.protocol === "openai";
  const body = withEffort(account, passthrough ? { ...ctx.body, model: ctx.model } : anthropicToOpenaiBody(ctx.body, ctx.model), ctx.effort);
  const send = (b) =>
    ctx.fetchImpl(`${upstream.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(upstream.token ? { authorization: `Bearer ${upstream.token}` } : {}) },
      body: JSON.stringify(b),
      signal: ctx.signal,
    });
  let res = await send(body);
  // Some models take no effort parameter at all. When the one this endpoint added is what got refused, ask again
  // without it rather than give the turn to another account (or the paid backup).
  const added = body.reasoning_effort !== ctx.body.reasoning_effort || body.reasoning !== ctx.body.reasoning;
  if (res.status === 400 && added) {
    const text = await res.clone().text().catch(() => "");
    if (/reasoning/i.test(text)) {
      const { reasoning_effort, reasoning, ...plain } = body;
      res = await send({ ...plain, ...(ctx.body.reasoning_effort !== undefined ? { reasoning_effort: ctx.body.reasoning_effort } : {}), ...(ctx.body.reasoning !== undefined ? { reasoning: ctx.body.reasoning } : {}) });
    }
  }
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

/**
 * Add the turn's effort in the upstream's own spelling, unless the client already asked for one (the
 * client's choice wins). An upstream whose spelling is unknown gets none: an unexpected field can be a 400.
 */
/**
 * Providers where a per-turn effort change is known not to bust the prompt cache. xAI matches the cache on
 * the messages array and `reasoning_effort` is not part of it (measured on grok-4.7). Claude's newer models
 * take effort as output config. OpenAI's top-level `reasoning.effort` rewrites the hidden system instructions,
 * so it is off unless the account says otherwise. See docs/research/prompt-cache-and-effort.md.
 */
export function effortCacheSafe(account) {
  if (typeof account.effortCacheSafe === "boolean") return account.effortCacheSafe;
  return account.kind === "claude-code" || account.provider === "xai";
}

export function withEffort(account, body, effort) {
  if (!effort || !effortCacheSafe(account) || body.reasoning_effort !== undefined || body.reasoning !== undefined) return body;
  const param = account.effortParam ?? { openrouter: "reasoning", xai: "reasoning_effort", openai: "reasoning_effort" }[account.provider ?? ""] ?? "none";
  if (param === "none") return body;
  if (effort === "off") return param === "reasoning" ? { ...body, reasoning: { enabled: false } } : body;
  // xhigh and max are Claude-only levels; elsewhere the strongest common one is high.
  const level = effort === "xhigh" || effort === "max" ? "high" : effort;
  return param === "reasoning" ? { ...body, reasoning: { effort: level } } : { ...body, reasoning_effort: level };
}
