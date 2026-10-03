import { WINDOWS_FOR } from "./series.mjs";

/**
 * Subscription usage for a Claude account. The only source is what the official CLI reports in
 * its own `rate_limit_event` on every call (see claude-cli.mjs), so there is no separate poll and
 * no OAuth token used outside Claude Code. The cost: an account that has not answered yet has no
 * numbers, and a gate acts on evidence only, so it learns on the account's first turn.
 */

export function emptyUsage() {
  return { windows: {} };
}

/** Fold `{ id: { u, reset } }` (u is 0..1) into the account's usage record. */
export function applyWindows(account, windows, now = Date.now()) {
  account.usage ??= emptyUsage();
  for (const [id, w] of Object.entries(windows)) account.usage.windows[id] = { ...account.usage.windows[id], ...w };
  account.usage.at = now;
}

/**
 * Highest live utilization (0..1) among the windows that bound `series`, or undefined when
 * nothing is known. A window past its reset says nothing.
 */
export function utilization(account, series, now = Date.now()) {
  const windows = account.usage?.windows;
  if (!windows) return undefined;
  let peak;
  for (const id of WINDOWS_FOR[series] ?? ["5h", "7d"]) {
    const w = windows[id];
    if (!w || w.u === undefined || (w.reset !== undefined && w.reset <= now)) continue;
    peak = Math.max(peak ?? 0, w.u);
  }
  return peak;
}
