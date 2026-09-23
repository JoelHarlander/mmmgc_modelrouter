/**
 * Router configuration: defaults <- ~/.pi/agent/modelrouter.json <- <cwd>/.pi/modelrouter.json
 *
 * Model ids are always "provider/modelId" as pi knows them (see `pi --list-models`).
 *
 * The project-local layer arrives with whatever repository is open, so nothing in it is trusted
 * unless `PROJECT_SETTABLE` names the key: routing preferences it may state, safeguards it may
 * only tighten, and everything else — endpoints, credentials, spend policy, quota scopes, and
 * every key added later — comes from the global layer.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type Tier = "light" | "standard" | "heavy";
export const TIERS: readonly Tier[] = ["light", "standard", "heavy"] as const;

/** plan = flat-rate subscription (OAuth), on-demand = pay per token, free = local/zero-cost */
export type Billing = "plan" | "on-demand" | "free";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** How a provider's live entitlement/usage endpoint is shaped. See docs/research/plan-quotas.md. */
export type EntitlementKind = "anthropic-oauth-usage" | "codex-wham-usage" | "openrouter-key" | "vercel-credits";

export interface EntitlementSource {
	kind: EntitlementKind;
	/** Read-only usage/entitlement endpoint. Never an inference endpoint. */
	url: string;
	/**
	 * pi provider whose credential this one claims to route on, when it differs. A claim worth
	 * testing, not a fact: only where pi resolves the same credential for both does one probe
	 * cover them and quota evidence seen through either id belong to both.
	 */
	authProvider?: string;
	/** Extra request headers the endpoint requires (e.g. Anthropic's OAuth beta flag). */
	headers?: Record<string, string>;
}

export interface ModelOverride {
	billing?: Billing;
	/** 0..100 relative capability. Only used to break ties inside a tier. */
	capability?: number;
}

export interface RouterConfig {
	enabled: boolean;
	notifyOnSwitch: boolean;
	jev: {
		/** auto = direct TypeSafe key if present, else Vercel AI Gateway key (pi's vercel-ai-gateway auth or env). */
		transport: "auto" | "typesafe" | "gateway";
		model: string;
		baseUrl: string;
		apiKeyEnv: string;
		apiKey?: string;
		gatewayModel: string;
		gatewayBaseUrl: string;
		gatewayApiKeyEnv: string;
		gatewayApiKey?: string;
		timeoutMs: number;
		maxStateChars: number;
		recentMessages: number;
		maxCharsPerMessage: number;
	};
	tiers: Record<Tier, string[]>;
	thinking: Partial<Record<Tier, ThinkingLevel>>;
	models: Record<string, ModelOverride>;
	plan: {
		/** Above this utilization (0..1) a plan provider is treated as exhausted. */
		utilizationCeiling: number;
		cooldownMinutesOn429: number;
	};
	billing: {
		/** Model-key globs allowed to spend extra billed usage once their subscription window is exhausted. */
		allowExtraBilled: string[];
		/**
		 * Model-key globs allowed to bill per token (gateways, API keys). Deliberately not `["*"]`:
		 * a route that bills money is reachable only where it was named. Naming one orders it last,
		 * behind included usage and the account's own credits - it does not promote it.
		 */
		allowPayPerToken: string[];
		/** Entitlement evidence older than this counts as stale, not verified. */
		evidenceMaxAgeMinutes: number;
		probe: {
			enabled: boolean;
			timeoutMs: number;
			/** Never re-probe a provider more often than this. */
			minIntervalMinutes: number;
		};
	};
	/** Read-only entitlement endpoints keyed by pi provider id. */
	entitlement: Record<string, EntitlementSource>;
	/**
	 * Model-scoped limit windows: `"<providerGlob>:<windowId>"` -> model-key globs the window governs.
	 * A window listed here excludes only its own models; the provider stays usable for other models.
	 */
	scopes: Record<string, string[]>;
	switching: {
		/** Below this Jev confidence the router keeps the current model. */
		minConfidence: number;
		/** Charge the context re-read when leaving a model with a warm cache. */
		cacheSwitchPenalty: boolean;
		/** Turns to respect a manual /model choice before routing again. */
		manualPinTurns: number;
		expectedOutputTokens: number;
	};
	parallel: {
		defaultN: number;
		/** Fixed list, kept in this order; empty = pick current model + best authed model of each tier. */
		models: string[];
		judge: "jev" | "none";
		autoAdopt: boolean;
		switchToWinner: boolean;
		timeoutMs: number;
		maxResponseCharsForJudge: number;
	};
}

export const DEFAULT_CONFIG: RouterConfig = {
	enabled: true,
	notifyOnSwitch: true,
	jev: {
		transport: "auto",
		model: "jev-latest",
		baseUrl: "https://api.typesafe.ai/v1",
		apiKeyEnv: "TYPESAFE_API_KEY",
		gatewayModel: "typesafe-ai/jev",
		gatewayBaseUrl: "https://ai-gateway.vercel.sh/typesafe/v1",
		gatewayApiKeyEnv: "AI_GATEWAY_API_KEY",
		timeoutMs: 4000,
		maxStateChars: 12000,
		recentMessages: 6,
		maxCharsPerMessage: 600,
	},
	tiers: {
		light: ["openrouter/z-ai/glm-5.3-flash", "vercel-ai-gateway/deepseek/deepseek-v4.1-flash", "ds4/deepseek-v4-flash"],
		standard: ["openai-codex/gpt-6-astra", "openrouter/z-ai/glm-5.3", "xai/grok-4.6"],
		heavy: ["claude-bridge/claude-fable-5-1", "anthropic/claude-opus-5", "claude-bridge/claude-opus-5", "openai-codex/gpt-6-astra"],
	},
	thinking: { light: "low", standard: "medium", heavy: "high" },
	models: {
		// The OAuth-backed subscription routes. `anthropic/*` and `xai/*` carry no label: whether
		// they are a plan or an API key is pi's own auth evidence to answer, not this file's - and
		// only pi resolving one and the same credential for `anthropic` and `claude-bridge` lets
		// them share quota, so an API key there is never excluded by a subscription it does not bill.
		"claude-bridge/*": { billing: "plan" },
		"openai-codex/*": { billing: "plan" },
		"openrouter/*": { billing: "on-demand" },
		"vercel-ai-gateway/*": { billing: "on-demand" },
		"ds4/*": { billing: "free" },
	},
	plan: { utilizationCeiling: 0.85, cooldownMinutesOn429: 30 },
	billing: {
		// Extra credits exist on the ChatGPT plan only, and are only ever spent on verified credits.
		allowExtraBilled: ["openai-codex/*"],
		// The pay-per-token routes the default tiers name, and no others. Paid Anthropic and xAI are
		// reachable here but rank last, so they are the overflow rather than the first choice:
		// "not a ban btw - just priority. if all is used i expect payg on oai as a preference".
		allowPayPerToken: ["openrouter/*", "vercel-ai-gateway/*", "ds4/*", "anthropic/*", "xai/*"],
		evidenceMaxAgeMinutes: 30,
		probe: { enabled: true, timeoutMs: 4000, minIntervalMinutes: 30 },
	},
	entitlement: {
		anthropic: { kind: "anthropic-oauth-usage", url: "https://api.anthropic.com/api/oauth/usage", headers: { "anthropic-beta": "oauth-2025-04-20" } },
		"claude-bridge": {
			kind: "anthropic-oauth-usage",
			url: "https://api.anthropic.com/api/oauth/usage",
			authProvider: "anthropic",
			headers: { "anthropic-beta": "oauth-2025-04-20" },
		},
		"openai-codex": { kind: "codex-wham-usage", url: "https://chatgpt.com/backend-api/wham/usage" },
		openrouter: { kind: "openrouter-key", url: "https://openrouter.ai/api/v1/key" },
		"vercel-ai-gateway": { kind: "vercel-credits", url: "https://ai-gateway.vercel.sh/v1/credits" },
	},
	scopes: {
		// Anthropic's model-scoped weekly buckets (docs/research/plan-quotas.md §1). Keyed by the
		// credential, so `claude-bridge` - which routes on the same account - needs no second entry.
		"anthropic:7d_oi": ["*/claude-fable-*"],
		"anthropic:7d_opus": ["*/claude-opus-*"],
		"anthropic:7d_sonnet": ["*/claude-sonnet-*"],
		// OpenRouter's daily allowance meters its `:free` variants only; the key's own cap is account-wide.
		"openrouter:free_daily": ["*:free"],
	},
	switching: { minConfidence: 0.5, cacheSwitchPenalty: true, manualPinTurns: 3, expectedOutputTokens: 1500 },
	parallel: {
		defaultN: 2,
		models: [],
		judge: "jev",
		autoAdopt: false,
		switchToWinner: false,
		timeoutMs: 180_000,
		maxResponseCharsForJudge: 6000,
	},
};

/** Minimal glob: only `*` is special. */
export function globMatch(pattern: string, value: string): boolean {
	const re = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
	return re.test(value);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function overrideFor(cfg: RouterConfig, modelKey: string): ModelOverride {
	let out: ModelOverride = {};
	for (const [pattern, override] of Object.entries(cfg.models)) {
		if (globMatch(pattern, modelKey)) out = { ...out, ...override };
	}
	return out;
}

export function configPaths(cwd: string): { global: string; project: string } {
	return {
		global: join(getAgentDir(), "modelrouter.json"),
		project: join(cwd, CONFIG_DIR_NAME, "modelrouter.json"),
	};
}

export function loadConfig(cwd: string): { config: RouterConfig; sources: string[]; errors: string[] } {
	const paths = configPaths(cwd);
	const sources: string[] = [];
	const errors: string[] = [];
	let cfg: RouterConfig = structuredClone(DEFAULT_CONFIG);
	for (const file of [paths.global, paths.project]) {
		if (!existsSync(file)) continue;
		try {
			const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<RouterConfig>;
			cfg = mergeConfig(cfg, raw, file === paths.project ? "project" : "global");
			sources.push(file);
		} catch (err) {
			errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { config: cfg, sources, errors };
}

/** Which layer a patch came from. Only the global layer may name an endpoint or a credential. */
export type ConfigScope = "global" | "project";

/** How a project-local value may be taken: as given, or only towards off. */
type ProjectRule = "set" | "off";

/**
 * Every key a project-local `.pi/modelrouter.json` may speak for, and how. Anything absent here
 * — a whole section such as `jev`, `entitlement`, `plan`, `models` or `scopes`, a single key such
 * as `billing.allowPayPerToken`, and every key added in future — comes from the global layer
 * alone. So a repository can pick which models it prefers and make the router stricter, and it
 * can never name an endpoint, assert what pays for a model, or loosen a spend safeguard.
 */
export const PROJECT_SETTABLE: Readonly<Record<string, ProjectRule>> = {
	enabled: "off",
	notifyOnSwitch: "set",
	tiers: "set",
	thinking: "set",
	"switching.minConfidence": "set",
	"switching.cacheSwitchPenalty": "set",
	"switching.manualPinTurns": "set",
	"switching.expectedOutputTokens": "set",
	"parallel.defaultN": "set",
	"parallel.models": "set",
	"parallel.judge": "set",
	"parallel.autoAdopt": "set",
	"parallel.switchToWinner": "set",
	"parallel.timeoutMs": "set",
	"parallel.maxResponseCharsForJudge": "set",
	"billing.probe.enabled": "off",
};

/** Section-level merge. `tiers` and `parallel.models` replace wholesale when given. */
export function mergeConfig(base: RouterConfig, rawPatch: Partial<RouterConfig>, scope: ConfigScope = "global"): RouterConfig {
	const patch = scope === "project" ? projectPatch(base, rawPatch) : rawPatch;
	return {
		enabled: patch.enabled ?? base.enabled,
		notifyOnSwitch: patch.notifyOnSwitch ?? base.notifyOnSwitch,
		jev: { ...base.jev, ...(patch.jev ?? {}) },
		tiers: patch.tiers ? { ...base.tiers, ...patch.tiers } : base.tiers,
		thinking: { ...base.thinking, ...(patch.thinking ?? {}) },
		models: { ...base.models, ...(patch.models ?? {}) },
		plan: { ...base.plan, ...(patch.plan ?? {}) },
		billing: { ...base.billing, ...(patch.billing ?? {}), probe: { ...base.billing.probe, ...(patch.billing?.probe ?? {}) } },
		entitlement: { ...base.entitlement, ...(patch.entitlement ?? {}) },
		scopes: { ...base.scopes, ...(patch.scopes ?? {}) },
		switching: { ...base.switching, ...(patch.switching ?? {}) },
		parallel: { ...base.parallel, ...(patch.parallel ?? {}) },
	};
}

/** Keeps only what a project-local config may say, each value already taken the safe way. */
function projectPatch(base: RouterConfig, patch: Partial<RouterConfig>): Partial<RouterConfig> {
	return (settable(base as unknown, patch, "") ?? {}) as Partial<RouterConfig>;
}

function settable(base: unknown, patch: unknown, path: string): unknown {
	const rule = PROJECT_SETTABLE[path];
	if (rule) return projectValue(base, patch, rule);
	if (!isRecord(patch)) return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(patch)) {
		const kept = settable(isRecord(base) ? base[key] : undefined, value, path ? `${path}.${key}` : key);
		if (kept !== undefined) out[key] = kept;
	}
	return Object.keys(out).length > 0 || path === "" ? out : undefined;
}

/** A value of the wrong shape, like a safeguard moved the wrong way, keeps the global one. */
function projectValue(base: unknown, patch: unknown, rule: ProjectRule): unknown {
	switch (rule) {
		case "set":
			return patch;
		case "off":
			return typeof patch === "boolean" ? base === true && patch : base;
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}


/**
 * The credential a provider id claims to route on, as the config declares it with
 * `entitlement.<id>.authProvider`. This is intent, never proof: it says which pair of ids is worth
 * testing for identity (`refreshEntitlements`) and it is the name `cfg.scopes` keys are written
 * in, but nothing shares an account on its word alone.
 */
export function credentialOf(cfg: RouterConfig, provider: string): string {
	return cfg.entitlement[provider]?.authProvider ?? provider;
}

/** Every model key the router can actually route to, from the tiers and the fan-out list. */
export function routableModels(cfg: RouterConfig): string[] {
	return [...new Set([...Object.values(cfg.tiers).flat(), ...cfg.parallel.models])];
}

/** True when any glob in `patterns` matches `modelKey`. */
export function anyGlobMatch(patterns: readonly string[], modelKey: string): boolean {
	return patterns.some((p) => globMatch(p, modelKey));
}

export function modelKey(m: { provider: string; id: string }): string {
	return `${m.provider}/${m.id}`;
}
