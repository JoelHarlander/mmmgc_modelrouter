import { readFileSync } from "node:fs";
import { heuristicTier, routingQuestions } from "./select.mjs";

const TYPESAFE_BASE = "https://api.typesafe.ai/v1";

/**
 * Key for pi's `typesafe` provider: TYPESAFE_API_KEY, else its entry in pi's auth.json.
 * Never logged and never returned to the UI.
 */
export function typesafeKey(authPath) {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    const cred = JSON.parse(readFileSync(authPath, "utf8")).typesafe;
    return cred?.key || cred?.access || undefined;
  } catch {
    return undefined;
  }
}

/** Both services serve the Jev wire at `<base>/v1/systemone`; accept a bare host or a `/v1` base. */
export function systemOneUrl(baseUrl) {
  const base = baseUrl.replace(/\/+$/, "");
  return `${/\/v1$/.test(base) ? base : `${base}/v1`}/systemone`;
}

/**
 * One System One call (the Jev wire: Laya and TypeSafe both speak it) asking the routing questions.
 * @returns {Promise<Omit<import("./types.js").Classification, "via" | "errors">>}
 */
async function systemOne(baseUrl, key, model, prompt, timeoutMs) {
  const res = await fetch(systemOneUrl(baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ state: { request: String(prompt ?? "").slice(0, 6000) }, model, questions: routingQuestions() }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`);
  /** @type {any} */
  const json = await res.json();
  const tier = json.answers?.tier?.choice;
  if (tier !== "light" && tier !== "standard" && tier !== "heavy") throw new Error("no tier answer");
  const stakes = json.answers?.stakes?.score;
  return {
    tier: stakes >= 1.5 && tier === "light" ? "standard" : tier,
    confidence: Number(json.answers?.tier?.confidence ?? 0.5),
    model: json.model,
    needsTools: json.answers?.needs_tools?.noul,
    stakes,
  };
}

/** How long a classifier that failed is left alone, so a dead one costs one failure, not one per turn. */
const BREAKER_MS = { laya: 30_000, jev: 60_000 };

/** Per-process memory of which classifiers are currently failing. One per app, so tests do not share it. */
/** @returns {import("./types.js").Breakers} */
export function createBreakers() {
  return { laya: 0, jev: 0 };
}

const message = (err) => (err instanceof Error ? err.message : String(err));

/**
 * Classify one turn. Laya first (local, free); if it is down, TypeSafe's hosted Jev
 * (`typesafe/jev-latest`); if that has no key or fails, the heuristic. `via` says which
 * answered and `errors` says why the earlier ones did not, so the UI never hides a fallback.
 *
 * A classifier that failed is skipped for a while (`BREAKER_MS`): with Laya stopped and the hosted
 * Jev slow, trying both on every turn would add several seconds to each one.
 *
 * @param {string} prompt
 * @param {{ layaUrl?: string, authPath?: string, typesafeUrl?: string, breakers?: import("./types.js").Breakers, now?: () => number,
 *           layaTimeoutMs?: number, jevTimeoutMs?: number }} [opts]
 * @returns {Promise<import("./types.js").Classification>}
 */
export async function classify(prompt, opts = {}) {
  const errors = [];
  const now = (opts.now ?? Date.now)();
  const breakers = opts.breakers ?? createBreakers();

  if (opts.layaUrl) {
    if (now < breakers.laya) {
      errors.push(`laya: skipped, failed recently (retry in ${Math.ceil((breakers.laya - now) / 1000)}s)`);
    } else {
      try {
        const answer = await systemOne(opts.layaUrl, "local", "laya", prompt, opts.layaTimeoutMs ?? 1500);
        breakers.laya = 0;
        return { ...answer, via: "laya", errors };
      } catch (err) {
        breakers.laya = now + BREAKER_MS.laya;
        errors.push(`laya: ${message(err)}`);
      }
    }
  }

  const key = typesafeKey(opts.authPath);
  if (!key) {
    errors.push("typesafe:jev: no TYPESAFE_API_KEY or typesafe entry in pi auth");
  } else if (now < breakers.jev) {
    errors.push(`typesafe:jev: skipped, failed recently (retry in ${Math.ceil((breakers.jev - now) / 1000)}s)`);
  } else {
    try {
      const answer = await systemOne(opts.typesafeUrl ?? TYPESAFE_BASE, key, "jev-latest", prompt, opts.jevTimeoutMs ?? 4000);
      breakers.jev = 0;
      return { ...answer, via: "typesafe:jev", errors };
    } catch (err) {
      breakers.jev = now + BREAKER_MS.jev;
      errors.push(`typesafe:jev: ${message(err)}`);
    }
  }
  return { ...heuristicTier(prompt), errors };
}

/**
 * Warm a local Laya in the background: its first prediction pays for CUDA and kernel setup, which
 * would otherwise land on the first real turn and push it to the hosted fallback. Both services start
 * together at boot, so it retries until Laya answers. Never touches the hosted Jev; never throws.
 * @param {string} layaUrl
 * @param {{ attempts?: number, delayMs?: number, timeoutMs?: number, breakers?: import("./types.js").Breakers }} [opts]
 */
export async function warmLaya(layaUrl, { attempts = 12, delayMs = 5000, timeoutMs = 30_000, breakers } = {}) {
  if (!layaUrl) return false;
  for (let i = 0; i < attempts; i++) {
    try {
      await systemOne(layaUrl, "local", "laya", "warm up", timeoutMs);
      if (breakers) breakers.laya = 0;
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs).unref?.());
    }
  }
  return false;
}

export async function layaHealth(layaUrl) {
  if (!layaUrl) return { up: false, error: "no url" };
  try {
    const res = await fetch(`${layaUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return { up: false, error: `health ${res.status}` };
    return { up: true };
  } catch (err) {
    return { up: false, error: err instanceof Error ? err.message : String(err) };
  }
}
