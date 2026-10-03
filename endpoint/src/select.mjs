import { utilization } from "./usage.mjs";

/**
 * Choosing an account for one turn. Pure: it reads the state and the clock and returns a pick.
 *
 * The preference list is an order of series. A usage gate is a threshold on a series: once an
 * account has used `at` of the highest window bounding it, that account is skipped for the series
 * and the gate's `then` (or the next preference entry) is tried. Gates are soft: after the gated
 * pass finds nothing, any usable subscription account is used before the pay-per-token backup.
 *
 *   pass 1  accounts under their gate, series in order, following `then`
 *   pass 2  any usable subscription account, gates ignored
 *   pass 3  the backup account, if one is configured
 *
 * Accounts that serve the same series share its turns round-robin, so several cheap plans
 * absorb a burst. A cooling or disabled account is never a candidate.
 */

export const DEFAULT_PREFERENCE = ["opus", "sonnet"];

/** Whether an account can answer a request that carries tool definitions. A Claude CLI account cannot. */
export function supportsTools(account) {
  return account.tools ?? account.kind !== "claude-code";
}

/**
 * Whether an account may take this turn: enabled, not already tried (`exclude` holds account ids,
 * or `id:series` for a refusal that was one series'), not cooling account-wide, and not cooling for
 * `series` (a model entitlement refusal cools one series, not the account).
 */
export function accountUsable(account, now, { exclude = new Set(), series, needsTools = false } = {}) {
  if (!account || account.enabled === false || exclude.has(account.id) || exclude.has(`${account.id}:${series}`)) return false;
  if (needsTools && !supportsTools(account)) return false;
  if (account.cooldownUntil && account.cooldownUntil > now) return false;
  return !(series && account.coolSeries?.[series] > now);
}

export function gateFor(state, series) {
  return (state.gates ?? []).find((g) => g.series === series);
}

/** The gate an account has tripped on `series`, with the utilization that tripped it. */
export function gateTrip(state, account, series, now) {
  const gate = gateFor(state, series);
  if (!gate) return undefined;
  const used = utilization(account, series, now);
  return used !== undefined && used >= gate.at ? { gate, used } : undefined;
}

export function preferenceFor(state, tier) {
  const forTier = state.tiers?.[tier];
  if (Array.isArray(forTier) && forTier.length > 0) return forTier;
  return state.preference?.length ? state.preference : DEFAULT_PREFERENCE;
}

function subscriptionAccounts(state, series, now, opts) {
  return (state.accounts ?? []).filter((a) => !a.backup && a.series?.includes(series) && accountUsable(a, now, { ...opts, series }));
}

/** Next account in line for `series`, advancing that series' cursor only when one is chosen. */
function takeTurn(state, series, candidates) {
  const cursor = state.rr?.[series] ?? 0;
  state.rr = { ...(state.rr ?? {}), [series]: cursor + 1 };
  return candidates[cursor % candidates.length];
}

function resolveGated(state, series, now, opts, seen) {
  const all = subscriptionAccounts(state, series, now, opts);
  if (all.length === 0) return undefined;
  const open = all.filter((a) => !gateTrip(state, a, series, now));
  if (open.length > 0) return { account: takeTurn(state, series, open), series, via: "open" };
  const gate = gateFor(state, series);
  if (!gate?.then || seen.has(series)) return undefined;
  seen.add(series);
  const next = resolveGated(state, gate.then, now, opts, seen);
  return next ? { ...next, via: `gate:${series}>${gate.then}` } : undefined;
}

/**
 * Next account for a turn of `tier`. `exclude` holds accounts that already failed this request.
 * Returns `{ account, series, via }`, or undefined when nothing can serve it.
 */
export function pickAccount(state, { tier, now = Date.now(), exclude = new Set(), needsTools = false } = {}) {
  const order = preferenceFor(state, tier);
  const opts = { exclude, needsTools };
  for (const series of order) {
    const pick = resolveGated(state, series, now, opts, new Set());
    if (pick) return pick;
  }
  for (const series of order) {
    const all = subscriptionAccounts(state, series, now, opts);
    if (all.length === 0) continue;
    // Least-used first: the soft pass exists because every candidate is past its gate.
    const least = [...all].sort((a, b) => (utilization(a, series, now) ?? 0) - (utilization(b, series, now) ?? 0))[0];
    return { account: least, series, via: "soft" };
  }
  const backups = (state.accounts ?? []).filter((a) => a.backup && accountUsable(a, now, { ...opts, series: "backup" }));
  if (backups.length > 0) return { account: takeTurn(state, "backup", backups), series: "backup", via: "backup" };
  return undefined;
}

/** Cool the whole account, or only `series` on it when the refusal was that model's. */
export function coolAccount(account, now, ms, reason, series) {
  if (series) account.coolSeries = { ...(account.coolSeries ?? {}), [series]: now + ms };
  else account.cooldownUntil = now + ms;
  account.lastError = reason.slice(0, 300);
}

/** "retry-after: 120" or "resets at 11:00:00" -> ms to wait, else the fallback. Capped at a day. */
export function cooldownMs(text, fallbackMs, now = Date.now()) {
  const retry = /retry-after:\s*(\d+)/i.exec(text);
  if (retry) return Math.min(Number(retry[1]) * 1000, 24 * 60 * 60 * 1000);
  const clock = /resets(?: at| in)?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/i.exec(text);
  if (!clock) return fallbackMs;
  const target = new Date(now);
  target.setHours(Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0), 0);
  if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  return Math.min(target.getTime() - now, 24 * 60 * 60 * 1000);
}

export function isQuotaFailure(status, text) {
  if (status === 429 || status === 402) return true;
  return /rate limit|usage credits|no_providers_available|insufficient_quota|overloaded/i.test(text);
}

/** Classifier used when Laya and Jev are both unavailable. Low confidence on purpose. */
export function heuristicTier(prompt) {
  const p = String(prompt ?? "").trim();
  const words = p ? p.split(/\s+/).length : 0;
  if (/\b(architect|design|refactor|migrate|debug|why does|race|deadlock|security|review|audit|investigate|root cause)\b/i.test(p)) {
    return { tier: "heavy", confidence: 0.4, via: "heuristic" };
  }
  if (words <= 12 && !p.includes("```")) return { tier: "light", confidence: 0.4, via: "heuristic" };
  return { tier: "standard", confidence: 0.34, via: "heuristic" };
}

export function routingQuestions() {
  return {
    tier: {
      type: "choice",
      instructions: {
        question: "Which model tier should handle this turn for a terminal coding agent?",
        note: "Judge the difficulty of the requested work, not the length of the message.",
      },
      criteria: {
        light: "A small, well-specified step, a greeting, or a factual answer. A fast model will do this correctly.",
        standard: "Ordinary coding work in one or two files, a clear bug, or tests for known behavior.",
        heavy: "Design, multi-file refactors, unclear debugging, security, or anything where a wrong answer is expensive.",
      },
    },
    needs_tools: {
      type: "noul",
      instructions: "Will fulfilling the request require editing files or running commands, rather than only answering in text?",
    },
    stakes: {
      type: "score",
      instructions: "How costly would a wrong or sloppy answer be?",
      criteria: ["Harmless", "Moderate", "Severe"],
    },
  };
}
