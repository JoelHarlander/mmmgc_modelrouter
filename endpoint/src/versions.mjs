/**
 * Model-id ordering shared by every "latest" decision. Mirrors `versionCompare` in the pi
 * extension (src/preference.ts) so the endpoint and the extension agree on which model is newest.
 */

/**
 * Numeric components up to the first date-like one (4+ digits), which is a snapshot, not a version. A component
 * after a dot is a decimal fraction (grok-4.20 is older than grok-4.7); after a dash it is a whole number.
 */
export function versionParts(id) {
  const s = String(id);
  const parts = [];
  for (const m of s.matchAll(/\d+/g)) {
    if (m[0].length >= 4) break;
    parts.push(s[(m.index ?? 0) - 1] === "." ? Number(`0.${m[0]}`) : Number(m[0]));
  }
  return parts;
}

/** Positive when `a` is a newer version than `b`. A missing trailing component loses to an explicit one. */
export function versionCompare(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? -1;
    const db = pb[i] ?? -1;
    if (da !== db) return da - db;
  }
  return 0;
}

/** Newest id first; a tie prefers the shorter id (`glm-5.3` over `glm-5.3-flash`, an alias over its dated snapshot). */
export function newestFirst(a, b) {
  return versionCompare(b, a) || a.length - b.length || a.localeCompare(b);
}

/** Minimal glob: only `*` is special. */
export function globMatch(pattern, value) {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`).test(value);
}
