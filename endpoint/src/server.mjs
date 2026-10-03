import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dispatch } from "./dispatch.mjs";
import { classify, layaHealth, typesafeKey, warmLaya } from "./laya.mjs";
import { resolveModel } from "./models.mjs";
import {
  anthropicEventsOf,
  anthropicMessage,
  anthropicStream,
  hasTools,
  lastUserText,
  openaiCompletion,
  openaiReplyToAnthropic,
  openaiStream,
} from "./protocol.mjs";
import { coolAccount, pickAccount } from "./select.mjs";
import { defaultAuthPath, defaultStatePath, loadState, normalize, normalizeGates, remember, saveState } from "./store.mjs";
import { utilization } from "./usage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** A failure that is not a quota refusal still sidelines the account briefly, so one broken login is not retried on every turn. */
const TRANSIENT_COOLDOWN_MS = 30_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp(options = {}) {
  const statePath = options.statePath ?? defaultStatePath();
  const authPath = options.authPath ?? defaultAuthPath();
  const fetchImpl = options.fetchImpl ?? fetch;
  const state = options.state ?? loadState(statePath);
  const ui = readFileSync(join(HERE, "ui.html"), "utf8");
  let saveTimer;

  /** Writes coalesce: a busy minute is one write, not one per turn. `flush()` runs on shutdown. */
  function persist() {
    if (options.persist === false || saveTimer) return;
    saveTimer = setTimeout(flush, 250);
    saveTimer.unref?.();
  }
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (options.persist !== false) saveState(statePath, state);
  }

  const authorized = (req) => {
    const header = String(req.headers.authorization || req.headers["x-api-key"] || "");
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(state.token);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "request body is not valid JSON");
    }
  }

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const fail = (res, protocol, status, message, headers) =>
    json(res, status, protocol === "anthropic" ? { type: "error", error: { type: "api_error", message } } : { error: { message, type: "server_error" } }, headers);

  /** Pick, call and fail over until an account answers. */
  async function runTurn(protocol, body, signal) {
    const classified = await classify(lastUserText(body), { layaUrl: state.layaUrl, authPath, typesafeUrl: options.typesafeUrl });
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
        resolved = await resolveModel(account, series, { fetchImpl, authPath });
      } catch (err) {
        exclude.add(account.id);
        account.lastError = err instanceof Error ? err.message : String(err);
        attempts.push({ id: account.id, series, ok: false, error: account.lastError });
        continue;
      }
      const result = await dispatch(account, {
        protocol,
        body,
        series,
        model: resolved.model,
        tier: classified.tier,
        signal,
        fetchImpl,
        authPath,
        spawnImpl: options.spawnImpl,
      });
      attempts.push({ id: account.id, series, model: resolved.model, ok: result.ok, status: result.status, error: result.error });
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
        persist();
        return { ...result, decision };
      }
      const seriesOnly = result.quota && result.scope === "series";
      exclude.add(seriesOnly ? `${account.id}:${series}` : account.id);
      if (signal?.aborted) break;
      const cool = result.quota ? (result.cooldownMs ?? state.cooldownFallbackMs) : TRANSIENT_COOLDOWN_MS;
      coolAccount(account, Date.now(), Math.min(cool, 24 * 60 * 60 * 1000), result.error || "failed", seriesOnly ? series : undefined);
    }
    const decision = { tier: classified.tier, via: classified.via, error: "no account available", attempts };
    remember(state, decision);
    persist();
    const quotaOnly = attempts.length > 0 && attempts.every((a) => a.status === 429);
    return { ok: false, status: quotaOnly ? 429 : 503, error: attempts.length ? `no account could answer: ${attempts.map((a) => `${a.id}: ${a.error}`).join("; ")}` : "no account available for this request", decision };
  }

  const routeHeaders = (d) => ({
    "x-router-account": d?.account ?? "",
    "x-router-model": d?.model ?? "",
    "x-router-tier": d?.tier ?? "",
    "x-router-via": d?.via ?? "",
    // open, gate:<from>><to>, soft, or backup: the last is the one that costs money.
    "x-router-route": d?.route ?? "",
  });

  /** Send an answered turn to the client in the protocol it asked in. */
  async function respond(res, protocol, body, result) {
    const headers = routeHeaders(result.decision);
    const stream = Boolean(body.stream);
    if (result.kind === "http") {
      const upstream = result.res;
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json", ...(stream ? { "cache-control": "no-cache" } : {}), ...headers });
      if (!upstream.body) return res.end();
      const readable = Readable.fromWeb(upstream.body);
      readable.on("error", () => res.destroy());
      readable.pipe(res);
      return undefined;
    }
    if (result.kind === "buffered") {
      const message = openaiReplyToAnthropic(result.json, "auto");
      if (!stream) return json(res, 200, message, headers);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers });
      return res.end(anthropicEventsOf(message));
    }
    // kind: "events" — text pieces from the Claude CLI (or the echo stand-in)
    const renderer = protocol === "anthropic" ? anthropicStream("auto") : openaiStream("auto");
    if (!stream) {
      let text = "";
      let usage;
      let failed;
      for await (const e of result.events) {
        if (e.text) text += e.text;
        if (e.done) {
          usage = e.usage;
          failed = e.isError ? e.error : undefined;
        }
      }
      if (failed) return fail(res, protocol, 502, failed, headers);
      return json(res, 200, protocol === "anthropic" ? anthropicMessage(text, "auto", { usage }) : openaiCompletion(text, "auto", { usage }), headers);
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers });
    res.write(renderer.start());
    let usage;
    for await (const e of result.events) {
      if (e.text) res.write(renderer.delta(e.text));
      if (e.done) {
        usage = e.usage;
        if (e.isError) res.write(`data: ${JSON.stringify({ error: { message: e.error, type: "upstream_error" } })}\n\n`);
      }
    }
    return res.end(renderer.end(usage));
  }

  // ---- admin API (bearer token) ---------------------------------------------

  function publicAccount(a, now = Date.now()) {
    const { apiKey, usage, ...rest } = a;
    const used = {};
    for (const series of a.series ?? []) used[series] = utilization(a, series, now);
    return { ...rest, hasApiKey: Boolean(apiKey), usage: usage?.windows, utilization: used };
  }

  async function status() {
    const laya = await layaHealth(state.layaUrl);
    return {
      model: "auto",
      baseUrl: `http://${state.host}:${state.port}/v1`,
      laya,
      layaUrl: state.layaUrl,
      jev: { key: Boolean(typesafeKey(authPath)) },
      preference: state.preference,
      gates: state.gates,
      tiers: state.tiers,
      accounts: state.accounts.map((a) => publicAccount(a)),
      decisions: state.decisions,
    };
  }

  function upsertAccount(body) {
    const id = String(body.id || "").trim();
    if (!/^[A-Za-z0-9._-]{1,48}$/.test(id)) throw new HttpError(400, "id must be 1-48 letters, digits, dot, dash or underscore");
    const kind = body.kind || "claude-code";
    if (!["claude-code", "pi-auth", "openai", "echo"].includes(kind)) throw new HttpError(400, `unknown kind ${kind}`);
    const previous = state.accounts.find((a) => a.id === id);
    const account = {
      ...(previous ?? {}),
      id,
      kind,
      enabled: body.enabled !== false,
      series: Array.isArray(body.series) ? body.series.map(String).filter(Boolean) : previous?.series ?? [],
      models: body.models && typeof body.models === "object" ? body.models : previous?.models ?? {},
      backup: body.backup === true,
      latest: body.latest === false ? false : undefined,
      planUsd: Number.isFinite(Number(body.planUsd)) ? Number(body.planUsd) : previous?.planUsd,
      configDir: body.configDir || previous?.configDir,
      baseUrl: body.baseUrl || previous?.baseUrl,
      provider: body.provider || previous?.provider,
      modelGlob: body.modelGlob || previous?.modelGlob,
      apiKey: body.apiKey || previous?.apiKey,
      note: body.note ?? previous?.note ?? "",
      served: previous?.served ?? 0,
    };
    if (kind === "claude-code" && !account.configDir) throw new HttpError(400, "a claude-code account needs configDir (its CLAUDE_CONFIG_DIR)");
    if (kind === "pi-auth" && !account.provider) throw new HttpError(400, "a pi-auth account needs provider (a key in pi's auth.json)");
    if (account.backup) account.series = ["backup"];
    else if (account.series.length === 0) throw new HttpError(400, "series required (for example opus, sonnet), or mark the account as the backup");
    state.accounts = state.accounts.filter((a) => a.id !== id).concat(account);
    return account;
  }

  async function admin(req, res, url) {
    if (!authorized(req)) return json(res, 401, { error: "unauthorized: send the router token as a bearer token" });
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/status") return json(res, 200, await status());
    const body = req.method === "POST" ? await readJson(req) : {};
    if (route === "POST /api/accounts") {
      const account = upsertAccount(body);
      persist();
      return json(res, 200, { account: publicAccount(account) });
    }
    if (route === "POST /api/accounts/update") {
      const account = state.accounts.find((a) => a.id === body.id);
      if (!account) throw new HttpError(404, "unknown account");
      if (body.enabled !== undefined) account.enabled = Boolean(body.enabled);
      if (body.clearCooldown) {
        account.cooldownUntil = 0;
        account.coolSeries = undefined;
        account.lastError = undefined;
      }
      persist();
      return json(res, 200, { account: publicAccount(account) });
    }
    if (route === "POST /api/accounts/delete") {
      const before = state.accounts.length;
      state.accounts = state.accounts.filter((a) => a.id !== body.id);
      if (state.accounts.length === before) throw new HttpError(404, "unknown account");
      persist();
      return json(res, 200, { ok: true });
    }
    if (route === "POST /api/policy") {
      const next = {};
      if (body.preference !== undefined) {
        if (!Array.isArray(body.preference) || body.preference.length === 0 || body.preference.some((s) => typeof s !== "string" || !s.trim())) {
          throw new HttpError(400, "preference must be a non-empty list of series names");
        }
        next.preference = body.preference.map((s) => s.trim());
      }
      if (body.gates !== undefined) {
        const gates = normalizeGates(body.gates);
        if (gates.length !== (Array.isArray(body.gates) ? body.gates.length : 0)) throw new HttpError(400, "each gate needs series and at in (0, 1]; then is optional");
        next.gates = gates;
      }
      if (body.tiers !== undefined) {
        if (!body.tiers || typeof body.tiers !== "object" || Array.isArray(body.tiers)) throw new HttpError(400, "tiers must map light/standard/heavy to series lists");
        next.tiers = body.tiers;
      }
      Object.assign(state, next);
      normalize(state);
      persist();
      return json(res, 200, { preference: state.preference, gates: state.gates, tiers: state.tiers });
    }
    throw new HttpError(404, "not found");
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const protocol = url.pathname === "/v1/messages" ? "anthropic" : "openai";
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(ui);
      }
      if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (url.pathname.startsWith("/api/")) return await admin(req, res, url);
      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
        return json(res, 200, { object: "list", data: [{ id: "auto", object: "model", owned_by: "router" }] });
      }
      if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/messages")) {
        if (!authorized(req)) return fail(res, protocol, 401, "unauthorized");
        const body = await readJson(req);
        if (!Array.isArray(body.messages) || body.messages.length === 0) throw new HttpError(400, "messages must be a non-empty array");
        const abort = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) abort.abort();
        });
        const result = await runTurn(protocol, body, abort.signal);
        if (!result.ok) return fail(res, protocol, result.status, result.error, routeHeaders(result.decision));
        return await respond(res, protocol, body, result);
      }
      throw new HttpError(404, "not found");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (res.headersSent) return res.destroy();
      if (url.pathname.startsWith("/api/")) return json(res, status, { error: err.message });
      return fail(res, protocol, status, status === 500 ? "internal error" : err.message);
    }
  });

  return { server, state, flush };
}

/** Listen, and flush state on SIGTERM/SIGINT so a stop or restart never loses a turn's bookkeeping. */
export function startServer(options = {}) {
  const { server, state, flush } = createApp(options);
  server.listen(state.port, state.host, () => {
    console.log(`router-endpoint listening on http://${state.host}:${state.port}  model: auto  api: /v1`);
    void warmLaya(state.layaUrl);
  });
  const stop = () => {
    flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return server;
}
