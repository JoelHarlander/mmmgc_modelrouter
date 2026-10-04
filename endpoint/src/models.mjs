import { knownBaseUrl, piToken } from "./auth.mjs";
import { seriesPattern as matcherFor } from "./policy.mjs";
import { globMatch, newestFirst } from "./policy.mjs";

const TTL_MS = 60 * 60 * 1000;
/** Model ids by account, listed once an hour. A failure is cached too, so a dead listing is not retried per turn. */
const listings = new Map();

export function forgetListings() {
  listings.clear();
}

/**
 * Where an OpenAI-compatible account lives and the credential it sends, refreshing a pi OAuth login that
 * is about to expire. Throws with a reason.
 * @param {import("./types.js").Account} account
 * @param {string} [authPath]
 * @returns {Promise<{ base: string, token?: string }>}
 */
export async function upstreamOf(account, authPath) {
  if (account.kind === "pi-auth") {
    if (account.provider === "openai-codex") {
      throw new Error("openai-codex stays on pi's own provider: its subscription protocol is not chat-completions");
    }
    const base = account.baseUrl || knownBaseUrl(account.provider);
    if (!base) throw new Error(`${account.id}: no baseUrl for provider ${account.provider}`);
    return { base: base.replace(/\/$/, ""), token: (await piToken(authPath ?? "", account.provider ?? "")).token };
  }
  if (!account.baseUrl) throw new Error(`${account.id} has no baseUrl`);
  return { base: account.baseUrl.replace(/\/$/, ""), token: account.apiKey };
}

/**
 * Ids an OpenAI-compatible account lists, or none when it cannot. Never throws.
 * @param {import("./types.js").Account} account
 * @param {{ fetchImpl?: typeof fetch, authPath?: string, now?: number }} [opts]
 * @returns {Promise<string[]>}
 */
export async function listModels(account, { fetchImpl = fetch, authPath, now = Date.now() } = {}) {
  const hit = listings.get(account.id);
  if (hit && now - hit.at < TTL_MS) return hit.ids;
  let ids = [];
  try {
    const { base, token } = await upstreamOf(account, authPath);
    const res = await fetchImpl(`${base}/models`, {
      headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) ids = /** @type {any} */ (await res.json()).data.map((/** @type {{ id: string }} */ m) => m.id);
  } catch {
    ids = [];
  }
  listings.set(account.id, { at: now, ids });
  return ids;
}

/**
 * The model one account serves for one series (or the backup). In order:
 *   pinned   `account.models[series]`: exactly that model, nothing newer, ever
 *   alias    a Claude subscription account: the series name, which the CLI maps to the newest model
 *   latest   the newest listed id matching the series, or `account.modelGlob` when set; `:variant` ids are skipped
 * `account.latest: false` forbids the last two, so an account with no pin is an error rather than a guess.
 * @param {import("./types.js").Account} account
 * @param {string} series
 * @param {{ fetchImpl?: typeof fetch, authPath?: string }} [opts]
 * @returns {Promise<{ model: string, how: "pinned" | "alias" | "latest" }>}
 */
export async function resolveModel(account, series, opts = {}) {
  const pinned = account.models?.[series];
  if (pinned) return { model: pinned, how: "pinned" };
  if (account.latest === false) throw new Error(`${account.id}: latest is off and no model is pinned for ${series}`);
  if (account.kind === "claude-code") return { model: series, how: "alias" };
  const ids = await listModels(account, opts);
  const glob = account.modelGlob;
  const wanted = glob ? (id) => globMatch(glob, id) : (id) => matcherFor(series).test(id);
  // `:batch`, `:free`, `:thinking` and the like are routes to a model, not a newer model: skip them unless asked for.
  const asked = (account.modelGlob ?? "").includes(":");
  const best = ids.filter((id) => wanted(id) && (asked || !id.includes(":"))).sort(newestFirst)[0];
  if (best) return { model: best, how: "latest" };
  throw new Error(`${account.id}: no listed model matches ${account.modelGlob || series}; pin one in models.${series}`);
}
