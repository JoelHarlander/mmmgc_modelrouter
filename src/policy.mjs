/**
 * The ordering and matching rules the pi extension and the endpoint must agree on. One copy, so a
 * fix lands once: the grok-4.20 bug was this logic written twice and wrong in both places.
 *
 * No I/O and no pi types. Callers that hold a model object compare its id through these functions.
 * Plain JavaScript: the endpoint service runs under plain node, which cannot load TypeScript.
 */

/**
 * Numeric components up to the first date-like one (4+ digits: `0709`, `20250514`), which is a snapshot, not a
 * version. A component after a dot is a decimal fraction: xAI's grok-4.20 came before grok-4.3 and grok-4.7, as
 * glm-5.3 follows glm-5.2. Components after a dash stay whole numbers (claude-opus-5-5).
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

/** Positive when `a` is a newer version than `b`. A missing trailing component loses to an explicit one (`5` < `5-1`). */
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

/** Minimal glob: only `*` is special, so a dot in a model id is a dot. */
export function globMatch(pattern, value) {
	const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp(`^${escaped.join(".*")}$`).test(value);
}

/**
 * Whether a model id belongs to a series. A built-in series by its own pattern; any other name by whole tokens,
 * so `glm` is glm-5.3 and `sol` is not solar. Regex characters in a name are literal.
 */
export function seriesPattern(series) {
	const builtin = SERIES_ID[series.toLowerCase()];
	if (builtin) return builtin;
	const token = series.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "i");
}

export function idMatches(id, series) {
	return seriesPattern(series).test(id);
}

/** Model-id test for each built-in series. The provider is a separate tie-break, owned by the caller. */
const SERIES_ID = {
	fable: /fable/i,
	grok: /grok/i,
	opus: /opus/i,
	sonnet: /sonnet/i,
	haiku: /haiku/i,
	astra: /astra/i,
	// A whole token: `sol` is gpt-6.1-sol, not upstage/solar-pro-3.
	sol: /(^|[^a-z0-9])sol([^a-z0-9]|$)/i,
};
