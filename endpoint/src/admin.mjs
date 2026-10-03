import { layaHealth, typesafeKey } from "./classifier.mjs";
import { HttpError, json, readJson } from "./http.mjs";
import { normalize, normalizeGates } from "./store.mjs";
import { utilization } from "./usage.mjs";

const KINDS = ["claude-code", "pi-auth", "openai", "echo"];
const TIERS = ["light", "standard", "heavy"];

/** An account as the UI sees it: never the key, with utilization worked out per series. */
export function publicAccount(account, now = Date.now()) {
  const { apiKey, usage, ...rest } = account;
  const used = {};
  for (const series of account.series ?? []) used[series] = utilization(account, series, now);
  return { ...rest, hasApiKey: Boolean(apiKey), usage: usage?.windows, utilization: used };
}

async function status(app) {
  const { state } = app;
  return {
    model: "auto",
    baseUrl: `http://${state.host}:${state.port}/v1`,
    laya: await layaHealth(state.layaUrl),
    layaUrl: state.layaUrl,
    jev: { key: Boolean(typesafeKey(app.authPath)) },
    preference: state.preference,
    gates: state.gates,
    tiers: state.tiers,
    accounts: state.accounts.map((a) => publicAccount(a)),
    decisions: state.decisions,
  };
}

function upsertAccount(state, body) {
  const id = String(body.id || "").trim();
  if (!/^[A-Za-z0-9._-]{1,48}$/.test(id)) throw new HttpError(400, "id must be 1-48 letters, digits, dot, dash or underscore");
  const kind = body.kind || "claude-code";
  if (!KINDS.includes(kind)) throw new HttpError(400, `unknown kind ${kind}`);
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
    baseUrl: kind === "pi-auth" ? previous?.baseUrl : body.baseUrl || previous?.baseUrl,
    provider: body.provider || previous?.provider,
    modelGlob: body.modelGlob || previous?.modelGlob,
    apiKey: body.apiKey || previous?.apiKey,
    note: body.note ?? previous?.note ?? "",
    served: previous?.served ?? 0,
  };
  if (kind === "claude-code" && !account.configDir) throw new HttpError(400, "a claude-code account needs configDir (its CLAUDE_CONFIG_DIR)");
  if (kind === "pi-auth" && !account.provider) throw new HttpError(400, "a pi-auth account needs provider (a key in pi's auth.json)");
  // A pi-auth account sends pi's stored credential to its base URL. Letting the API name that URL would let
  // anyone holding the router token walk a provider's token off to a host of their choosing, so the URL is the
  // provider's own; a custom endpoint is an `openai` account with its own key, or a hand edit of the state file.
  if (kind === "pi-auth" && body.baseUrl) throw new HttpError(400, "a pi-auth account uses its provider's own URL; for a custom endpoint use kind openai with its own key");
  if (account.backup) account.series = ["backup"];
  else if (account.series.length === 0) throw new HttpError(400, "series required (for example opus, sonnet), or mark the account as the backup");
  state.accounts = state.accounts.filter((a) => a.id !== id).concat(account);
  return account;
}

/** `{ preference?, gates?, tiers? }` -> the validated fields. Throws HttpError on the first bad one. */
function parsePolicy(body) {
  const next = {};
  if (body.preference !== undefined) {
    const p = body.preference;
    if (!Array.isArray(p) || p.length === 0 || p.some((s) => typeof s !== "string" || !s.trim())) throw new HttpError(400, "preference must be a non-empty list of series names");
    next.preference = p.map((s) => s.trim());
  }
  if (body.gates !== undefined) {
    const gates = normalizeGates(body.gates);
    if (gates.length !== (Array.isArray(body.gates) ? body.gates.length : 0)) throw new HttpError(400, "each gate needs series and at in (0, 1]; then is optional");
    next.gates = gates;
  }
  if (body.tiers !== undefined) {
    const t = body.tiers;
    const ok = t && typeof t === "object" && !Array.isArray(t) &&
      Object.entries(t).every(([tier, list]) => TIERS.includes(tier) && Array.isArray(list) && list.length > 0 && list.every((s) => typeof s === "string" && s.trim()));
    if (!ok) throw new HttpError(400, "tiers must map light, standard or heavy to a non-empty list of series names");
    next.tiers = Object.fromEntries(Object.entries(t).map(([tier, list]) => [tier, list.map((s) => s.trim())]));
  }
  return next;
}

/** `/api/*`: status and edits. Every route needs the bearer token. */
export async function handleAdmin(app, req, res, url) {
  const { state, persist } = app;
  if (!app.authorized(req)) return json(res, 401, { error: "unauthorized: send the router token as a bearer token" });
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/status") return json(res, 200, await status(app));
  const body = req.method === "POST" ? await readJson(req) : {};

  switch (route) {
    case "POST /api/accounts": {
      const account = upsertAccount(state, body);
      persist();
      app.log.info("account saved", { id: account.id, kind: account.kind, backup: account.backup || undefined });
      return json(res, 200, { account: publicAccount(account) });
    }
    case "POST /api/accounts/update": {
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
    case "POST /api/accounts/delete": {
      const before = state.accounts.length;
      state.accounts = state.accounts.filter((a) => a.id !== body.id);
      if (state.accounts.length === before) throw new HttpError(404, "unknown account");
      persist();
      app.log.info("account deleted", { id: body.id });
      return json(res, 200, { ok: true });
    }
    case "POST /api/policy": {
      Object.assign(state, parsePolicy(body));
      normalize(state);
      persist();
      app.log.info("policy saved", { preference: state.preference.join(","), gates: state.gates.length });
      return json(res, 200, { preference: state.preference, gates: state.gates, tiers: state.tiers });
    }
    default:
      throw new HttpError(404, "not found");
  }
}
