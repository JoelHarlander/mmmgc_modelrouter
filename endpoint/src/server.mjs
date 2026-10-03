import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleAdmin } from "./admin.mjs";
import { createBreakers, warmLaya } from "./classifier.mjs";
import { HttpError, fail, json, readJson } from "./http.mjs";
import { createLogger } from "./log.mjs";
import { respond, routeHeaders } from "./respond.mjs";
import { defaultAuthPath, defaultStatePath, loadState, saveState } from "./store.mjs";
import { runTurn } from "./turn.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Build the server. Nothing listens until the caller does, so tests can bind port 0.
 * Options: `state`, `statePath`, `authPath`, `fetchImpl`, `spawnImpl`, `typesafeUrl`,
 * `persist: false` (keep state in memory), `log` (a logger; silent by default here).
 */
export function createApp(options = {}) {
  const statePath = options.statePath ?? defaultStatePath();
  const state = options.state ?? loadState(statePath);
  const ui = readFileSync(join(HERE, "ui.html"), "utf8");
  let saveTimer;

  function flush() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (options.persist !== false) saveState(statePath, state);
  }

  const app = {
    state,
    authPath: options.authPath ?? defaultAuthPath(),
    fetchImpl: options.fetchImpl ?? fetch,
    spawnImpl: options.spawnImpl,
    typesafeUrl: options.typesafeUrl,
    breakers: createBreakers(),
    log: options.log ?? createLogger({ enabled: false }),
    /** Writes coalesce: a busy minute is one write, not one per turn. `flush()` runs on shutdown. */
    persist() {
      if (options.persist === false || saveTimer) return;
      saveTimer = setTimeout(flush, 250);
      saveTimer.unref?.();
    },
    authorized(req) {
      const header = String(req.headers.authorization || req.headers["x-api-key"] || "");
      const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
      const want = Buffer.from(state.token);
      return given.length === want.length && timingSafeEqual(given, want);
    },
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const protocol = url.pathname === "/v1/messages" ? "anthropic" : "openai";
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(ui);
      }
      if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (url.pathname.startsWith("/api/")) return await handleAdmin(app, req, res, url);
      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (!app.authorized(req)) return json(res, 401, { error: "unauthorized" });
        return json(res, 200, { object: "list", data: [{ id: "auto", object: "model", owned_by: "router" }] });
      }
      if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/messages")) {
        if (!app.authorized(req)) return fail(res, protocol, 401, "unauthorized");
        const body = await readJson(req);
        if (!Array.isArray(body.messages) || body.messages.length === 0) throw new HttpError(400, "messages must be a non-empty array");
        const abort = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) abort.abort();
        });
        const result = await runTurn(app, protocol, body, abort.signal);
        if (!result.ok) return fail(res, protocol, result.status, result.error, routeHeaders(result.decision));
        return await respond(res, protocol, body, result);
      }
      throw new HttpError(404, "not found");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) app.log.error("request failed", { path: url.pathname, error: err.message });
      if (res.headersSent) return res.destroy();
      if (url.pathname.startsWith("/api/")) return json(res, status, { error: status === 500 ? "internal error" : err.message });
      return fail(res, protocol, status, status === 500 ? "internal error" : err.message);
    }
  });

  return { server, state, flush, app };
}

/** Listen, and flush state on SIGTERM/SIGINT so a stop or restart never loses a turn's bookkeeping. */
export function startServer(options = {}) {
  const log = options.log ?? createLogger();
  const { server, state, flush, app } = createApp({ ...options, log });
  server.listen(state.port, state.host, () => {
    log.info("listening", { url: `http://${state.host}:${state.port}`, accounts: state.accounts.length, laya: state.layaUrl || "off" });
    void warmLaya(state.layaUrl, { breakers: app.breakers }).then((ok) => state.layaUrl && log.info("laya", { warm: ok }));
  });
  const stop = (signal) => () => {
    log.info("stopping", { signal });
    flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", stop("SIGTERM"));
  process.on("SIGINT", stop("SIGINT"));
  return server;
}
