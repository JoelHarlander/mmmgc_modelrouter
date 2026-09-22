/**
 * Router configuration: defaults <- ~/.pi/agent/modelrouter.json <- <cwd>/.pi/modelrouter.json
 *
 * Model ids are always "provider/modelId" as pi knows them (see `pi --list-models`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type Tier = "light" | "standard" | "heavy";
export const TIERS: readonly Tier[] = ["light", "standard", "heavy"] as const;

/** plan = flat-rate subscription (OAuth), on-demand = pay per token, free = local/zero-cost */
export type Billing = "plan" | "on-demand" | "free";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
		/** Fixed list; empty = pick current model + best authed model of each tier. */
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
		"anthropic/*": { billing: "plan" },
		"claude-bridge/*": { billing: "plan" },
		"openai-codex/*": { billing: "plan" },
		"xai/*": { billing: "plan" },
		"openrouter/*": { billing: "on-demand" },
		"vercel-ai-gateway/*": { billing: "on-demand" },
		"ds4/*": { billing: "free" },
	},
	plan: { utilizationCeiling: 0.85, cooldownMinutesOn429: 30 },
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
			cfg = mergeConfig(cfg, raw);
			sources.push(file);
		} catch (err) {
			errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { config: cfg, sources, errors };
}

/** Section-level merge. `tiers` and `parallel.models` replace wholesale when given. */
export function mergeConfig(base: RouterConfig, patch: Partial<RouterConfig>): RouterConfig {
	return {
		enabled: patch.enabled ?? base.enabled,
		notifyOnSwitch: patch.notifyOnSwitch ?? base.notifyOnSwitch,
		jev: { ...base.jev, ...(patch.jev ?? {}) },
		tiers: patch.tiers ? { ...base.tiers, ...patch.tiers } : base.tiers,
		thinking: { ...base.thinking, ...(patch.thinking ?? {}) },
		models: { ...base.models, ...(patch.models ?? {}) },
		plan: { ...base.plan, ...(patch.plan ?? {}) },
		switching: { ...base.switching, ...(patch.switching ?? {}) },
		parallel: { ...base.parallel, ...(patch.parallel ?? {}) },
	};
}

export function modelKey(m: { provider: string; id: string }): string {
	return `${m.provider}/${m.id}`;
}
