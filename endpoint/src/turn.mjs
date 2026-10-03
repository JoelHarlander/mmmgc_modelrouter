import { classify } from "./classifier.mjs";
import { dispatch } from "./dispatch.mjs";
import { resolveModel } from "./models.mjs";
import { hasTools, lastUserText } from "./protocol.mjs";
import { coolAccount, pickAccount } from "./select.mjs";
import { remember } from "./store.mjs";

/** A failure that is not a quota refusal still sidelines the account briefly, so one broken login is not retried on every turn. */
const TRANSIENT_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Run one turn: classify it, pick an account, call it, and fail over until one answers.
 * `app` carries the shared pieces (`state`, `authPath`, `fetchImpl`, `spawnImpl`, `typesafeUrl`,
 * `breakers`, `persist`, `log`). Returns `{ ok: true, kind, ..., decision }` or
 * `{ ok: false, status, error, decision }`; nothing has been sent to the client either way.
 * @param {import("./types.js").App} app
 * @param {import("./types.js").Protocol} protocol
 * @param {any} body
 * @param {AbortSignal} [signal]
 * @returns {Promise<import("./types.js").TurnResult>}
 */
export async function runTurn(app, protocol, body, signal) {
  const { state, log } = app;
  const started = Date.now();
  const classified = await classify(lastUserText(body), {
    layaUrl: state.layaUrl,
    authPath: app.authPath,
    typesafeUrl: app.typesafeUrl,
    breakers: app.breakers,
  });
  const needsTools = hasTools(body);
  const exclude = new Set();
  const attempts = [];
  // Each account can fail once per series it serves, so that bounds the attempts.
  const budget = state.accounts.filter((a) => a.enabled !== false).reduce((n, a) => n + Math.max(1, a.series?.length ?? 1), 0);

  for (let n = 0; n < budget; n++) {
    const pick = pickAccount(state, { tier: classified.tier, exclude, needsTools });
    if (!pick) break;
    const { account, series } = pick;

    let resolved;
    try {
      resolved = await resolveModel(account, series, { fetchImpl: app.fetchImpl, authPath: app.authPath });
    } catch (err) {
      exclude.add(account.id);
      account.lastError = err instanceof Error ? err.message : String(err);
      attempts.push({ id: account.id, series, ok: false, error: account.lastError });
      log.warn("model", { account: account.id, series, error: account.lastError });
      continue;
    }

    const result = await dispatch(account, {
      protocol,
      body,
      series,
      model: resolved.model,
      tier: classified.tier,
      signal,
      fetchImpl: app.fetchImpl,
      authPath: app.authPath,
      spawnImpl: app.spawnImpl,
    });
    attempts.push({ id: account.id, series, model: resolved.model, ok: result.ok, status: result.ok ? 200 : result.status, error: result.ok ? undefined : result.error });

    if (result.ok) {
      account.served = (account.served ?? 0) + 1;
      account.lastOkAt = Date.now();
      account.lastError = undefined;
      const decision = {
        account: account.id,
        series,
        model: resolved.model,
        how: resolved.how,
        route: pick.via,
        tier: classified.tier,
        via: classified.via,
        confidence: classified.confidence,
        classifierErrors: classified.errors?.length ? classified.errors : undefined,
        attempts: attempts.length > 1 ? attempts : undefined,
      };
      remember(state, decision);
      app.persist();
      log.info("turn", { account: account.id, series, model: resolved.model, route: pick.via, tier: classified.tier, via: classified.via, tools: needsTools || undefined, attempts: attempts.length > 1 ? attempts.length : undefined, ms: Date.now() - started });
      return { ...result, decision };
    }

    const seriesOnly = result.quota && result.scope === "series";
    exclude.add(seriesOnly ? `${account.id}:${series}` : account.id);
    if (signal?.aborted) break;
    const cool = result.quota ? (result.cooldownMs ?? state.cooldownFallbackMs) : TRANSIENT_COOLDOWN_MS;
    coolAccount(account, Date.now(), Math.min(cool, MAX_COOLDOWN_MS), result.error || "failed", seriesOnly ? series : undefined);
    log.warn("refused", { account: account.id, series, status: result.status, quota: result.quota || undefined, scope: result.quota ? result.scope : undefined, cool_s: Math.round(Math.min(cool, MAX_COOLDOWN_MS) / 1000), error: result.error });
  }

  const decision = { tier: classified.tier, via: classified.via, error: "no account available", attempts };
  remember(state, decision);
  app.persist();
  const quotaOnly = attempts.length > 0 && attempts.every((a) => a.status === 429);
  const error = attempts.length ? `no account could answer: ${attempts.map((a) => `${a.id}: ${a.error}`).join("; ")}` : "no account available for this request";
  log.warn("unserved", { tier: classified.tier, tools: needsTools || undefined, tried: attempts.length, ms: Date.now() - started });
  return { ok: false, status: quotaOnly ? 429 : 503, error, decision };
}
