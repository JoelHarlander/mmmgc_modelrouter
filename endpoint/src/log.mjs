/**
 * One line per event on stdout, for journald or a log file: `time level event key=value ...`.
 * It records which account and model answered and why, never a prompt, a response or a credential.
 * `ROUTER_LOG=0` silences it; tests pass `enabled: false`.
 */
export function createLogger({ out = process.stdout, enabled = process.env.ROUTER_LOG !== "0", now = () => new Date() } = {}) {
  const fmt = (v) => {
    if (v === undefined || v === null || v === "") return undefined;
    const raw = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
    const s = raw.slice(0, 300);
    return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
  };
  const emit = (level) => (event, fields = {}) => {
    if (!enabled) return;
    const rest = Object.entries(fields)
      .map(([k, v]) => [k, fmt(v)])
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`);
    out.write(`${now().toISOString()} ${level} ${event}${rest.length ? ` ${rest.join(" ")}` : ""}\n`);
  };
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}
