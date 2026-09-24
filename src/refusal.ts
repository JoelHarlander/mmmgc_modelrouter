/**
 * Pure mapping from a harness refusal onto the window record assessment already reads.
 *
 * Model-scoped versus account-wide is a property of the window id plus the scope table in
 * config.ts, not of this mapping. Claude Code rate-limit types use the same ids as the poll
 * and the unified headers (docs/research/plan-quotas.md §1). A bridge rejection carries no
 * HTTP headers: `Claude rate limit (<rateLimitType>) — resets <local time>`, with `resetsAt`
 * as Unix seconds on the structured event. xAI names the model in the exhaustion body
 * (plan-quotas.md §3).
 */
export interface MappedWindow {
	/** Existing window id: `5h`, `7d`, `7d_oi`, `7d_opus`, `7d_sonnet`, `<model>:exhausted`, `weekly`, or a credential refusal id. */
	id: string;
	/** Epoch ms when the exclusion lifts. Absent only when the refusal named no instant. */
	resetAt?: number;
}

/** Claude Code `rate_limit_info.rateLimitType` → the window id the scope table already keys. */
const CLAUDE_WINDOW: Record<string, string> = {
	five_hour: "5h",
	seven_day: "7d",
	seven_day_overage_included: "7d_oi",
	seven_day_opus: "7d_opus",
	seven_day_sonnet: "7d_sonnet",
};

const BRIDGE_LIMIT = /Claude rate limit \(([a-z0-9_]+)\)/i;
const CLOCK = /resets\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i;
const XAI_MODEL = /for model ([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/i;

/**
 * Windows a single refusal establishes. Empty when the payload is not a documented
 * exhaustion: a probe failure and an ordinary error must not invent one.
 */
export function mapRefusalToWindows(refusal: unknown, now: number, headers: Record<string, string> = {}): MappedWindow[] {
	const rec = coerce(refusal);
	if (!rec) return [];
	const claude = claudeWindow(rec, now, headers);
	if (claude) return [claude];
	const xai = xaiWindow(rec, now, headers);
	if (xai) return [xai];
	const gateway = gatewayWindow(rec, now, headers);
	if (gateway) return [gateway];
	return [];
}

interface Rec {
	rateLimitType?: string;
	resetsAt?: unknown;
	resetAt?: unknown;
	resets_at?: unknown;
	reset_at?: unknown;
	code?: string;
	error?: unknown;
	model?: string;
	text?: string;
	type?: string;
	message?: string;
	metadata?: { limit_source?: string };
}

function coerce(refusal: unknown): Rec | undefined {
	if (typeof refusal === "string") {
		const trimmed = refusal.trim();
		if (trimmed.startsWith("{")) {
			try {
				return coerce(JSON.parse(trimmed) as unknown);
			} catch {
				return { text: refusal };
			}
		}
		return trimmed === "" ? undefined : { text: refusal };
	}
	if (typeof refusal !== "object" || refusal === null || Array.isArray(refusal)) return undefined;
	const root = refusal as Rec & { error?: unknown };
	const nested = asRec(root.error);
	// A transport envelope `{ error: { type, message, metadata } }` and a flat event both count.
	if (nested && (nested.type || nested.metadata || nested.code || nested.message)) {
		return {
			...root,
			...nested,
			text: typeof root.error === "string" ? root.error : root.text,
			error: root.error,
		};
	}
	return root;
}

function asRec(v: unknown): Rec | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : undefined;
}

function claudeWindow(rec: Rec, now: number, headers: Record<string, string>): MappedWindow | undefined {
	const fromText = rec.text ? BRIDGE_LIMIT.exec(rec.text) : undefined;
	const type = rec.rateLimitType ?? fromText?.[1];
	if (!type) return undefined;
	const id = CLAUDE_WINDOW[type];
	if (!id) return undefined;
	return { id, resetAt: namedReset(rec, now, headers) };
}

function xaiWindow(rec: Rec, now: number, headers: Record<string, string>): MappedWindow | undefined {
	const code = rec.code ?? "";
	const text = `${typeof rec.error === "string" ? rec.error : ""} ${rec.text ?? ""} ${rec.message ?? ""}`;
	const free = code === "subscription:free-usage-exhausted" || /free-usage-exhausted/.test(text);
	const weekly = /weekly/i.test(code) || /weekly usage pool|weekly pool/i.test(text);
	if (!free && !weekly) return undefined;
	const model = rec.model ?? XAI_MODEL.exec(text)?.[1];
	// A free-tier exhaustion that names no model is not evidence about the rest of the account.
	if (!model && !weekly) return undefined;
	let resetAt = namedReset(rec, now, headers);
	if (resetAt === undefined && /24-hour/.test(text)) resetAt = now + 24 * 60 * 60 * 1000;
	return { id: model ? `${model}:exhausted` : "weekly", resetAt };
}

function gatewayWindow(rec: Rec, now: number, headers: Record<string, string>): MappedWindow | undefined {
	const type = rec.type ?? "";
	const source = rec.metadata?.limit_source ?? "";
	let id: string | undefined;
	if (type === "quota_for_entity_exceeded" || source === "openrouter_key_limit" || source === "openrouter_credits") id = "budget-exhausted";
	else if (type === "rate_limit_exceeded" || source === "openrouter_in_flight_budget") id = "rate-limited";
	if (!id) return undefined;
	return { id, resetAt: namedReset(rec, now, headers) };
}

/** Explicit epoch wins; otherwise Retry-After, otherwise a clock time in the bridge sentence. */
function namedReset(rec: Rec, now: number, headers: Record<string, string>): number | undefined {
	const explicit = epochMs(rec.resetsAt ?? rec.resetAt ?? rec.resets_at ?? rec.reset_at);
	if (explicit !== undefined) return explicit;
	const retry = headerNum(headers, "retry-after");
	if (retry !== undefined) return now + retry * 1000;
	const text = rec.text ?? (typeof rec.error === "string" ? rec.error : undefined);
	return text ? clockToReset(text, now) : undefined;
}

function clockToReset(text: string, now: number): number | undefined {
	const m = CLOCK.exec(text);
	if (!m) return undefined;
	let h = Number(m[1]);
	const min = Number(m[2]);
	const s = m[3] ? Number(m[3]) : 0;
	const ap = m[4]?.toUpperCase();
	if (ap === "PM" && h < 12) h += 12;
	if (ap === "AM" && h === 12) h = 0;
	if (h > 23 || min > 59 || s > 59) return undefined;
	const d = new Date(now);
	d.setHours(h, min, s, 0);
	if (d.getTime() <= now) d.setDate(d.getDate() + 1);
	return d.getTime();
}

/** Unix seconds or milliseconds, matching the poll parser's scale rule. */
function epochMs(v: unknown): number | undefined {
	const n = typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : undefined;
	if (n === undefined || !Number.isFinite(n)) return undefined;
	return n > 1e12 ? n : n * 1000;
}

function headerNum(headers: Record<string, string>, name: string): number | undefined {
	const raw = headers[name] ?? headers[name.toLowerCase()];
	if (raw === undefined || raw === "") return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}
