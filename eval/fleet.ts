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

export function loadFleet(path: string, options: { unauthed?: string[]; configPatch?: Partial<RouterConfig> } = {}): LoadedFleet {
	const fleet = JSON.parse(readFileSync(path, "utf8")) as Fleet;
	if (fleet.version !== 1) throw new Error(`${path}: unsupported fleet version ${fleet.version}`);
	return buildFleet(fleet, options);
}

export function buildFleet(fleet: Fleet, options: { unauthed?: string[]; configPatch?: Partial<RouterConfig> } = {}): LoadedFleet {
	const unauthed = new Set(options.unauthed ?? []);
	const byKey = new Map<string, FleetModel>();
	const models: Model<Api>[] = [];
	const overrides: Record<string, ModelOverride> = {};

	for (const spec of fleet.models) {
		byKey.set(spec.key, spec);
		models.push(toPiModel(spec));
		overrides[spec.key] = { billing: spec.billing, capability: spec.capability ?? spec.skill };
	}

	const config = mergeConfig(DEFAULT_CONFIG, {
		tiers: fleet.tiers,
		// Replace the shipped globs entirely: a fleet key must never inherit a real provider's billing.
		models: overrides,
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
