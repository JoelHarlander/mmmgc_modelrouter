/**
 * The offline model fleet: turns eval/tasks/fleet.json into the two things the
 * router needs — a ModelRegistry it can query and a RouterConfig that lists the
 * fleet in tiers. No network, no credentials, no provider ever contacted.
 */
import { readFileSync } from "node:fs";
import type { Api, Model, ModelCost } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, mergeConfig, type ModelOverride, type RouterConfig } from "../src/config.ts";
import type { Fleet, FleetModel } from "./types.ts";

export interface LoadedFleet {
	fleet: Fleet;
	registry: ModelRegistry;
	config: RouterConfig;
	byKey: Map<string, FleetModel>;
	models: Model<Api>[];
	/** Keys the run should treat as unavailable, e.g. --no-auth faux-or/glm-5.3. */
	unauthed: Set<string>;
}

export function splitKey(key: string): { provider: string; id: string } {
	const slash = key.indexOf("/");
	return { provider: key.slice(0, slash), id: key.slice(slash + 1) };
}

export interface LoadFleetOptions {
	unauthed?: string[];
	configPatch?: Partial<RouterConfig>;
	/**
	 * Rewrite every model's billing before building. `all-on-demand` is the "no
	 * subscription" world: nothing prices at $0 at the margin, so escalating a tier
	 * finally costs something. It isolates the billing variable exactly - same models,
	 * same prices, same declared competence, one thing changed.
	 */
	billing?: "as-configured" | "all-on-demand" | "all-plan";
	/**
	 * Whether the modelled user has allowed per-token spend on this fleet's billed models.
	 *
	 * Billing became a routing input, and a per-token route is excluded unless
	 * `billing.allowPayPerToken` names it. The fleet is the statement of what this user
	 * can route to, so by default every model it declares `on-demand` or `free` is
	 * permitted — otherwise the shipped globs, which name real providers, would silently
	 * exclude every synthetic key and the eval would measure a router with no billed
	 * routes at all. Set `false` to model the opposite user: one who has allowed nothing.
	 */
	allowPayPerToken?: boolean;
}

export function loadFleet(path: string, options: LoadFleetOptions = {}): LoadedFleet {
	const fleet = JSON.parse(readFileSync(path, "utf8")) as Fleet;
	if (fleet.version !== 1) throw new Error(`${path}: unsupported fleet version ${fleet.version}`);
	return buildFleet(fleet, options);
}

/** Same fleet, different billing. Prices, skills and tiers are untouched. */
export function rebill(fleet: Fleet, billing: NonNullable<LoadFleetOptions["billing"]>): Fleet {
	if (billing === "as-configured") return fleet;
	const target = billing === "all-on-demand" ? ("on-demand" as const) : ("plan" as const);
	return { ...fleet, models: fleet.models.map((m) => ({ ...m, billing: target, oauth: target === "plan" })) };
}

export function buildFleet(input: Fleet, options: LoadFleetOptions = {}): LoadedFleet {
	const fleet = rebill(input, options.billing ?? "as-configured");
	const unauthed = new Set(options.unauthed ?? []);
	const byKey = new Map<string, FleetModel>();
	const models: Model<Api>[] = [];
	const overrides: Record<string, ModelOverride> = {};

	for (const spec of fleet.models) {
		byKey.set(spec.key, spec);
		models.push(toPiModel(spec));
		overrides[spec.key] = { billing: spec.billing, capability: spec.capability ?? spec.skill };
	}

	// Same principle as `models` below: a fleet key must never inherit a real provider's
	// billing permissions, nor be excluded by failing to match them.
	const billed = fleet.models.filter((m) => m.billing !== "plan").map((m) => m.key);
	const config = mergeConfig(DEFAULT_CONFIG, {
		tiers: fleet.tiers,
		// Replace the shipped globs entirely: a fleet key must never inherit a real provider's billing.
		models: overrides,
		billing: { ...DEFAULT_CONFIG.billing, allowPayPerToken: options.allowPayPerToken === false ? [] : billed },
		...(options.configPatch ?? {}),
	});
	// mergeConfig merges `models` over the defaults, so drop the shipped globs explicitly.
	config.models = overrides;

	return { fleet, registry: fakeRegistry(models, fleet, unauthed), config, byKey, models, unauthed };
}

function toPiModel(spec: FleetModel): Model<Api> {
	const { provider, id } = splitKey(spec.key);
	const cost: ModelCost = { ...spec.cost };
	return {
		id,
		name: spec.name,
		api: "openai-completions",
		provider,
		baseUrl: "http://offline.invalid",
		reasoning: true,
		input: ["text"],
		cost,
		contextWindow: spec.contextWindow ?? 200_000,
		maxTokens: 8192,
	} as Model<Api>;
}

/**
 * The slice of ModelRegistry the router actually uses (find / hasConfiguredAuth /
 * isUsingOAuth). Anything else throws loudly rather than silently returning undefined.
 */
function fakeRegistry(models: Model<Api>[], fleet: Fleet, unauthed: Set<string>): ModelRegistry {
	const oauth = new Set(fleet.models.filter((m) => m.oauth).map((m) => m.key));
	const key = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
	const registry = {
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (m: Model<Api>) => !unauthed.has(key(m)),
		isUsingOAuth: (m: Model<Api>) => oauth.has(key(m)),
		getAll: () => models,
		getAvailable: () => models.filter((m) => !unauthed.has(key(m))),
		complete: () => {
			throw new Error("offline eval fleet: complete() is never called; the harness simulates responses");
		},
	};
	return registry as unknown as ModelRegistry;
}
