/**
 * Audit the *shipped* tier configuration against published data.
 *
 * Every finding so far about the tier ladder was measured on `eval/tasks/fleet.json` —
 * a fixture, with prices I typed in and competence I declared. That is fine for scoring
 * routing policy, and useless as a claim about the product.
 *
 * This audit takes `DEFAULT_CONFIG.tiers` exactly as it ships, prices each entry from
 * `docs/data/operational-stats.json` (published list prices, retrieved 2026-09-20) and
 * ranks it by `docs/data/benchmarks.json` (AA Intelligence Index, the one benchmark in
 * that set populated for all 17 models), then asks two questions:
 *
 *   1. Is the tier ladder a **cost** ladder — does heavier cost more?
 *   2. Is it a **capability** ladder — is heavier actually stronger?
 *
 * Nothing here is simulated. Anything it cannot resolve is reported as unresolved
 * rather than guessed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Billing, overrideFor, type RouterConfig, type Tier, TIERS } from "../src/config.ts";

export interface CatalogueEntry {
	model: string;
	gatewayId?: string;
	openrouterId?: string;
	inputUsd: number;
	outputUsd: number;
	cacheReadUsd: number;
	contextWindow?: number;
}

export interface AuditedModel {
	key: string;
	billing: Billing;
	catalogue?: CatalogueEntry;
	/** AA Intelligence Index, from docs/data/benchmarks.json. */
	intelligence?: number;
	/** List cost of one warm turn at the reference context; undefined when unresolved. */
	warmTurnUsd?: number;
	/** What the router charges itself: 0 for plan and free routes. */
	marginalTurnUsd?: number;
	unresolved?: string;
}

export interface TierAudit {
	tier: Tier;
	models: AuditedModel[];
	/** The entry the router would prefer: lowest marginal cost, config order breaking ties. */
	preferred?: AuditedModel;
}

export interface ConfigAudit {
	label: string;
	referenceTokens: number;
	tiers: TierAudit[];
	priceInversions: string[];
	capabilityInversions: string[];
	/**
	 * A tier is dominated when a *heavier* tier's preferred model is both cheaper and at
	 * least as capable. There is then no request for which choosing the lighter tier is
	 * the right call, which is a stronger and more actionable statement than an inversion.
	 */
	dominatedTiers: string[];
	/**
	 * Set when two or more tiers resolve to the same preferred model. Routing can then
	 * change nothing but the thinking level - which still discards the prompt cache, so
	 * the router pays full cold starts for a decision that changes no model.
	 */
	collapsedTiers?: string;
	unresolved: string[];
	source: { prices: string; benchmarks: string; benchmark: string };
}

const REFERENCE_TOKENS = 100_000;
const CALLS = 5;
const OUTPUT_TOKENS = 2750;
const BENCHMARK = "AA Intelligence Index";

/** Aggressive normalisation: ids differ by punctuation across catalogues (5.1 vs 5-1). */
function norm(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function loadCatalogue(docsDir: string): { entries: CatalogueEntry[]; intelligence: Map<string, number> } {
	const raw = JSON.parse(readFileSync(join(docsDir, "data", "operational-stats.json"), "utf8")) as Record<string, unknown>[];
	const entries: CatalogueEntry[] = raw.map((r) => ({
		model: String(r.model),
		gatewayId: typeof r.gateway_id === "string" ? r.gateway_id : undefined,
		openrouterId: typeof r.openrouter_id === "string" ? r.openrouter_id : undefined,
		inputUsd: Number(r.input_price_per_mtok),
		outputUsd: Number(r.output_price_per_mtok),
		cacheReadUsd: Number(r.cache_read_price_per_mtok),
		contextWindow: typeof r.context_window === "number" ? r.context_window : undefined,
	}));

	const benchmarks = JSON.parse(readFileSync(join(docsDir, "data", "benchmarks.json"), "utf8")) as {
		model: string;
		benchmark: string;
		score: number | null;
	}[];
	const intelligence = new Map<string, number>();
	for (const row of benchmarks) {
		if (row.benchmark !== BENCHMARK || row.score === null) continue;
		intelligence.set(norm(row.model), row.score);
		const tail = row.model.split("/").pop();
		if (tail) intelligence.set(norm(tail), row.score);
	}
	return { entries, intelligence };
}

/**
 * Resolve a pi `provider/modelId` key against the catalogue. pi keys carry a provider
 * prefix the catalogue does not use, and the same model appears under different
 * punctuation, so match on the normalised remainder and then on its last segment.
 */
export function resolveCatalogue(key: string, entries: CatalogueEntry[]): CatalogueEntry | undefined {
	const remainder = key.slice(key.indexOf("/") + 1);
	const candidates = [norm(remainder), norm(remainder.split("/").pop() ?? "")];
	for (const entry of entries) {
		const ids = [entry.gatewayId, entry.openrouterId].filter((v): v is string => typeof v === "string");
		const forms = new Set<string>();
		for (const id of ids) {
			forms.add(norm(id));
			const tail = id.split("/").pop();
			if (tail) forms.add(norm(tail));
		}
		if (candidates.some((c) => c.length > 0 && forms.has(c))) return entry;
	}
	return undefined;
}

export function auditConfig(cfg: RouterConfig, docsDir: string, label = "shipped DEFAULT_CONFIG tiers"): ConfigAudit {
	const { entries, intelligence } = loadCatalogue(docsDir);
	const unresolved: string[] = [];

	const tiers: TierAudit[] = TIERS.map((tier) => {
		const models: AuditedModel[] = (cfg.tiers[tier] ?? []).map((key) => {
			const billing = overrideFor(cfg, key).billing ?? "on-demand";
			const catalogue = resolveCatalogue(key, entries);
			if (!catalogue) {
				unresolved.push(key);
				return { key, billing, unresolved: "not in docs/data/operational-stats.json" };
			}
			const warmTurnUsd = warmTurn(catalogue);
			const name = catalogue.gatewayId ?? catalogue.model;
			return {
				key,
				billing,
				catalogue,
				intelligence: intelligence.get(norm(name)) ?? intelligence.get(norm(name.split("/").pop() ?? "")),
				warmTurnUsd,
				// A plan or free route costs the router nothing at the margin, which is the
				// number its comparator actually sorts on.
				marginalTurnUsd: billing === "on-demand" ? warmTurnUsd : 0,
			};
		});
		const usable = models.filter((m) => m.marginalTurnUsd !== undefined);
		// Config order is the tie-break, matching the stable sort in src/router.ts.
		const preferred = usable.length === 0 ? undefined : usable.reduce((a, b) => (b.marginalTurnUsd! < a.marginalTurnUsd! - 1e-9 ? b : a));
		return { tier, models, preferred };
	});

	const priceInversions: string[] = [];
	const capabilityInversions: string[] = [];
	for (let i = 1; i < tiers.length; i++) {
		const prev = tiers[i - 1]!;
		const cur = tiers[i]!;
		if (prev.preferred?.warmTurnUsd !== undefined && cur.preferred?.warmTurnUsd !== undefined) {
			if (cur.preferred.warmTurnUsd < prev.preferred.warmTurnUsd) {
				priceInversions.push(
					`${cur.tier}'s preferred ${cur.preferred.key} ($${cur.preferred.warmTurnUsd.toFixed(4)}/warm turn) is cheaper at list than ` +
						`${prev.tier}'s ${prev.preferred.key} ($${prev.preferred.warmTurnUsd.toFixed(4)})`,
				);
			}
		}
		if (prev.preferred?.intelligence !== undefined && cur.preferred?.intelligence !== undefined) {
			if (cur.preferred.intelligence < prev.preferred.intelligence) {
				capabilityInversions.push(
					`${cur.tier}'s preferred ${cur.preferred.key} (${BENCHMARK} ${cur.preferred.intelligence}) scores below ` +
						`${prev.tier}'s ${prev.preferred.key} (${prev.preferred.intelligence})`,
				);
			}
		}
	}

	const dominatedTiers: string[] = [];
	for (let i = 0; i < tiers.length; i++) {
		const lighter = tiers[i]!.preferred;
		if (!lighter?.warmTurnUsd || lighter.intelligence === undefined) continue;
		for (let j = i + 1; j < tiers.length; j++) {
			const heavier = tiers[j]!.preferred;
			if (!heavier?.warmTurnUsd || heavier.intelligence === undefined) continue;
			if (heavier.warmTurnUsd < lighter.warmTurnUsd && heavier.intelligence >= lighter.intelligence) {
				dominatedTiers.push(
					`${tiers[i]!.tier} is dominated by ${tiers[j]!.tier}: ${heavier.key} costs $${heavier.warmTurnUsd.toFixed(4)} per warm turn against ` +
						`${lighter.key}'s $${lighter.warmTurnUsd.toFixed(4)} and scores ${heavier.intelligence} against ${lighter.intelligence}, ` +
						"so no request exists for which the lighter tier is the right choice",
				);
			}
		}
	}

	const preferredKeys = tiers.map((t) => t.preferred?.key).filter((k): k is string => k !== undefined);
	const collapsedTiers =
		preferredKeys.length > 1 && new Set(preferredKeys).size < preferredKeys.length
			? `${preferredKeys.length} tiers resolve to ${new Set(preferredKeys).size} distinct model(s) (${[...new Set(preferredKeys)].join(", ")}): ` +
				"routing can only change the thinking level, which discards the prompt cache on its own"
			: undefined;

	return {
		label,
		referenceTokens: REFERENCE_TOKENS,
		tiers,
		priceInversions,
		capabilityInversions,
		dominatedTiers,
		collapsedTiers,
		unresolved,
		source: { prices: "docs/data/operational-stats.json", benchmarks: "docs/data/benchmarks.json", benchmark: BENCHMARK },
	};
}

/** Same shape as eval/simulate.ts: a warm turn reads the prefix on each of `CALLS` calls. */
function warmTurn(entry: CatalogueEntry): number {
	const reads = REFERENCE_TOKENS * CALLS;
	return (reads * entry.cacheReadUsd) / 1_000_000 + (OUTPUT_TOKENS * entry.outputUsd) / 1_000_000;
}

export function renderAudit(audit: ConfigAudit): string {
	const out: string[] = ["", `config audit — ${audit.label}`, ""];
	out.push(`  prices: ${audit.source.prices}    capability: ${audit.source.benchmark} (${audit.source.benchmarks})`);
	out.push(`  warm turn = ${audit.referenceTokens / 1000}k context re-read on each of ${CALLS} calls + ${OUTPUT_TOKENS} output tokens`);
	out.push("");
	for (const tier of audit.tiers) {
		out.push(`  ${tier.tier}`);
		for (const m of tier.models) {
			const mark = m === tier.preferred ? " <- router prefers" : "";
			if (m.unresolved) {
				out.push(`    ${m.key.padEnd(44)} ${m.billing.padEnd(10)} ${m.unresolved}`);
				continue;
			}
			out.push(
				`    ${m.key.padEnd(44)} ${m.billing.padEnd(10)} warm $${m.warmTurnUsd!.toFixed(4).padStart(8)}   ` +
					`marginal $${m.marginalTurnUsd!.toFixed(4).padStart(8)}   ${audit.source.benchmark.split(" ")[1] ?? "idx"} ${String(m.intelligence ?? "?").padStart(5)}${mark}`,
			);
		}
	}
	out.push("");
	const ladder = (get: (m: AuditedModel) => number | undefined, fmt: (n: number) => string) =>
		audit.tiers.map((t) => `${t.tier} ${t.preferred && get(t.preferred) !== undefined ? fmt(get(t.preferred)!) : "?"}`).join("  ->  ");
	out.push(`  cost ladder (list):       ${ladder((m) => m.warmTurnUsd, (n) => `$${n.toFixed(4)}`)}`);
	out.push(`  capability ladder:        ${ladder((m) => m.intelligence, (n) => String(n))}`);
	out.push("");
	for (const problem of audit.priceInversions) out.push(`  PRICE INVERSION       ${problem}`);
	for (const problem of audit.capabilityInversions) out.push(`  CAPABILITY INVERSION  ${problem}`);
	for (const problem of audit.dominatedTiers) out.push(`  DOMINATED TIER        ${problem}`);
	if (audit.collapsedTiers) out.push(`  COLLAPSED TIERS       ${audit.collapsedTiers}`);
	if (audit.unresolved.length > 0) out.push(`  unresolved            ${audit.unresolved.join(", ")}`);
	if (audit.priceInversions.length === 0 && audit.capabilityInversions.length === 0 && audit.dominatedTiers.length === 0 && !audit.collapsedTiers) {
		out.push("  tiers form both a cost ladder and a capability ladder");
	}
	out.push("");
	return `${out.join("\n")}\n`;
}
