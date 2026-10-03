import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export function defaultStatePath() {
  return process.env.ROUTER_STATE || join(homedir(), ".pi", "agent", "router-endpoint.json");
}

export function defaultAuthPath() {
  return process.env.ROUTER_AUTH || join(homedir(), ".pi", "agent", "auth.json");
}

export function freshState() {
  return {
    host: process.env.ROUTER_HOST || "127.0.0.1",
    port: Number(process.env.ROUTER_PORT || process.env.PORT || 8788),
    token: process.env.ROUTER_TOKEN || randomBytes(24).toString("hex"),
    layaUrl: process.env.LAYA_URL ?? "http://127.0.0.1:8787",
    preference: ["opus", "sonnet"],
    gates: [],
    tiers: {},
    cooldownFallbackMs: 30 * 60 * 1000,
    accounts: [],
    rr: {},
    decisions: [],
  };
}

/**
 * The state file, created on first run. A file that exists but cannot be read is an error, never
 * a reason to start over: it holds the accounts and the token, and clobbering it would be silent loss.
 */
export function loadState(path = defaultStatePath()) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`cannot read ${path}: ${err.message}`);
    const state = freshState();
    saveState(path, state);
    return state;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${err.message}); fix or move it, it will not be overwritten`);
  }
  return normalize({ ...freshState(), ...parsed, token: process.env.ROUTER_TOKEN || parsed.token || freshState().token });
}

/** Shape guards for a hand-edited file: wrong types fall back to the default rather than crash a turn. */
export function normalize(state) {
  const list = (v, d = []) => (Array.isArray(v) ? v : d);
  state.accounts = list(state.accounts).filter((a) => a && typeof a.id === "string" && a.id);
  state.preference = list(state.preference).filter((s) => typeof s === "string" && s);
  if (state.preference.length === 0) state.preference = ["opus", "sonnet"];
  state.gates = normalizeGates(state.gates);
  state.tiers = state.tiers && typeof state.tiers === "object" && !Array.isArray(state.tiers) ? state.tiers : {};
  state.decisions = list(state.decisions).slice(0, 40);
  state.rr = state.rr && typeof state.rr === "object" ? state.rr : {};
  return state;
}

/** `{ series, at in (0, 1], then? }` entries only. Same rule as the pi extension's `gates`. */
export function normalizeGates(gates) {
  if (!Array.isArray(gates)) return [];
  const out = [];
  for (const g of gates) {
    if (!g || typeof g.series !== "string" || !g.series.trim()) continue;
    if (typeof g.at !== "number" || !Number.isFinite(g.at) || g.at <= 0 || g.at > 1) continue;
    const gate = { series: g.series.trim(), at: g.at };
    if (typeof g.then === "string" && g.then.trim()) gate.then = g.then.trim();
    out.push(gate);
  }
  return out;
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function remember(state, decision) {
  state.decisions = [{ ...decision, at: Date.now() }, ...(state.decisions ?? [])].slice(0, 40);
}
