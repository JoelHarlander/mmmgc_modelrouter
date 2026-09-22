/**
 * Billing eligibility: a first-class input to route selection.
 *
 * Every candidate route is assessed against live quota/entitlement evidence before it can be
 * chosen. The assessment answers three separate questions and keeps them separate on purpose:
 *
 *   basis        - what would pay for this turn: included subscription usage, extra billed
 *                  usage (credits on top of an exhausted subscription), ordinary pay-per-token,
 *                  or a zero-cost model.
 *   verification - whether live evidence actually established that basis, or whether it is an
 *                  assumption from a configured label or an OAuth heuristic.
 *   eligibility  - whether the configuration permits using the route on that footing.
 *
 * A route is `preferred` only when it is subscription-backed *and* verified. Unverified
 * subscriptions and extra billed usage stay reachable only where the configuration says so, and
 * the reason is always carried into routing explanations rather than silently applied.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { anyGlobMatch, type Billing, modelKey, overrideFor, type RouterConfig } from "./config.ts";
import { type CreditState, describeCredits, type Ledger, type QuotaAssessment, windowExhausted } from "./ledger.ts";

/** What pays for this turn. */
export type BillingBasis = "free" | "subscription" | "extra-credits" | "pay-per-token" | "unknown";

/** How well the basis is established. Only `verified` rests on live provider evidence. */
export type Verification = "verified" | "stale" | "assumed" | "unverified";

export type Eligibility = "preferred" | "allowed" | "excluded";

export interface BillingAssessment {
	basis: BillingBasis;
	verification: Verification;
	eligibility: Eligibility;
	/** Why the eligibility came out this way. Always meaningful, required reading when excluded. */
	reason: string;
	/** Facts the verdict rests on. Never contains a secret value. */
	evidence: string[];
	/** What is still not established. Empty only for a fully verified basis. */
	uncertainty: string[];
	/** The coarse legacy label, kept for cost estimation and existing config semantics. */
	billing: Billing;
	/** Preference rank used for ordering; lower is better. */
	rank: number;
}

/** Ranks: verified-subscription and free first, then assumed plans, then anything billed. */
const RANK = { verifiedSubscription: 0, free: 0, assumedSubscription: 1, payPerToken: 2, extraCredits: 3, excluded: 9 } as const;

export interface AssessArgs {
	model: Model<Api>;
	cfg: RouterConfig;
	registry: ModelRegistry;
	ledger: Ledger;
	now?: number;
}

/** The coarse label, and whether configuration asserted it or the registry implied it. */
export function billingLabel(model: Model<Api>, cfg: RouterConfig, registry: ModelRegistry): { billing: Billing; fromConfig: boolean } {
	const override = overrideFor(cfg, modelKey(model)).billing;
	if (override) return { billing: override, fromConfig: true };
	const c = model.cost;
	if (c.input === 0 && c.output === 0) return { billing: "free", fromConfig: false };
	return { billing: registry.isUsingOAuth(model) ? "plan" : "on-demand", fromConfig: false };
}

/**
 * Bases that spend money per token, so the catalog price is a real estimate rather than $0.
 * `unknown` counts: it is only reached when a catalog price contradicts a free label, and an
 * unresolved basis with a non-zero price is money until something proves otherwise.
 */
export function billsPerToken(basis: BillingBasis): boolean {
	return basis === "pay-per-token" || basis === "extra-credits" || basis === "unknown";
}

export function assessBilling(args: AssessArgs): BillingAssessment {
	const { model, cfg, registry, ledger } = args;
	const now = args.now ?? Date.now();
	const key = modelKey(model);
	const { billing, fromConfig } = billingLabel(model, cfg, registry);
	const quota = ledger.assess(model.provider, key, cfg, now);
	const evidence: string[] = [];
	const uncertainty: string[] = [];

	const freshness = evidenceFreshness(quota, cfg, now);
	if (quota.lastEvidenceAt !== undefined) {
		evidence.push(`${quota.sources.join("+")} evidence ${ageLabel(now - quota.lastEvidenceAt)} old for ${model.provider}`);
	}
	if (quota.plan) evidence.push(`provider reports plan "${quota.plan}"`);

	// A cooldown or a spent model-scoped window excludes the route whatever the basis is.
	if (quota.cooldown) {
		return excluded(labelBasis(billing), billing, freshness, `${quota.cooldown.reason} until ${new Date(quota.cooldown.until).toLocaleTimeString()}`, evidence, uncertainty);
	}
	if (quota.exhaustedScoped.length > 0) {
		const w = quota.exhaustedScoped[0]!;
		evidence.push(`model-scoped window ${w.reason}`);
		return excluded(labelBasis(billing), billing, freshness, `model-scoped quota exhausted (${w.reason}); ${model.provider} stays usable for other models`, evidence, uncertainty);
	}

	if (billing === "plan") return assessSubscription(key, cfg, quota, freshness, fromConfig, evidence, uncertainty, now);

	// Account-wide exhaustion and a spent credit balance are facts about the credential, not about
	// the basis: they disqualify a free or pay-per-token route as surely as a subscription one.
	// Only the subscription path goes on, because there extra billed usage may still be permitted.
	if (quota.exhaustedAccount.length > 0) {
		const spent = quota.exhaustedAccount.map((w) => w.reason).join(", ");
		evidence.push(`account window exhausted (${spent})`);
		return excluded(labelBasis(billing), billing, freshness, `${model.provider} account quota exhausted (${spent})`, evidence, uncertainty);
	}
	if (quota.credits && creditsSpent(quota.credits)) {
		const state = describeCredits(quota.credits);
		evidence.push(state);
		return excluded(labelBasis(billing), billing, freshness, `${model.provider} account cannot pay for this route (${state})`, evidence, uncertainty);
	}

	if (billing === "free") return assessFree(model, key, cfg, fromConfig, evidence, uncertainty);
	return assessPayPerToken(key, cfg, evidence, uncertainty);
}

function assessFree(
	model: Model<Api>,
	key: string,
	cfg: RouterConfig,
	fromConfig: boolean,
	evidence: string[],
	uncertainty: string[],
): BillingAssessment {
	const zeroCost = model.cost.input === 0 && model.cost.output === 0;
	if (zeroCost) evidence.push("catalog list price is zero");
	else uncertainty.push(`configuration labels ${key} free, but its catalog price is not zero`);
	if (fromConfig && !zeroCost) {
		return {
			basis: "unknown",
			verification: "assumed",
			eligibility: cfg.billing.allowPayPerToken.length && anyGlobMatch(cfg.billing.allowPayPerToken, key) ? "allowed" : "excluded",
			reason: `free label is a configuration assertion contradicted by the catalog price`,
			evidence,
			uncertainty,
			billing: "free",
			rank: RANK.payPerToken,
		};
	}
	return {
		basis: "free",
		verification: "verified",
		eligibility: "preferred",
		reason: "zero-cost model: no subscription or billed usage consumed",
		evidence,
		uncertainty,
		billing: "free",
		rank: RANK.free,
	};
}

function assessSubscription(
	key: string,
	cfg: RouterConfig,
	quota: QuotaAssessment,
	freshness: Verification,
	fromConfig: boolean,
	evidence: string[],
	uncertainty: string[],
	now: number,
): BillingAssessment {
	const denied = anyGlobMatch(cfg.billing.denyPaid, key);

	if (quota.exhaustedAccount.length > 0) {
		// Subscription is spent. Anything further is extra billed usage, which needs its own permission.
		const spent = quota.exhaustedAccount.map((w) => w.reason).join(", ");
		evidence.push(`subscription window exhausted (${spent})`);
		return assessExtraCredits(key, cfg, quota, freshness, evidence, uncertainty, spent, now);
	}

	// Subscription-metered quota windows are only served to subscription-billed traffic, so a
	// fresh account window is what turns the configured label into an established fact.
	if (freshness === "verified" && quota.accountWindows.length > 0) {
		evidence.push(`live subscription windows ${quota.accountWindows.join(", ")}`);
		if (quota.accountUtilization !== undefined) evidence.push(`subscription ${Math.round(quota.accountUtilization * 100)}% used`);
		return {
			basis: "subscription",
			verification: "verified",
			eligibility: "preferred",
			reason: "verified subscription usage with quota remaining",
			evidence,
			uncertainty,
			billing: "plan",
			rank: RANK.verifiedSubscription,
		};
	}

	if (fromConfig) {
		uncertainty.push(`"plan" label for ${key} comes from configuration, not from an entitlement check`);
	} else {
		uncertainty.push(`"plan" inferred from the provider using OAuth, which does not prove subscription billing`);
	}
	if (freshness === "stale") uncertainty.push(`last quota evidence is older than ${cfg.billing.evidenceMaxAgeMinutes}m`);
	else if (quota.accountWindows.length === 0) uncertainty.push("provider reported no subscription quota window");
	else uncertainty.push("no quota or entitlement evidence seen for this provider yet");

	if (denied) {
		return excluded("subscription", "plan", freshness, `paid fallback denied for ${key} and its subscription backing is not verified`, evidence, uncertainty);
	}
	if (!cfg.billing.allowUnverifiedSubscription) {
		return excluded("subscription", "plan", freshness, "subscription backing is not verified and billing.allowUnverifiedSubscription is false", evidence, uncertainty);
	}
	return {
		basis: "subscription",
		verification: freshness === "verified" ? "assumed" : freshness,
		eligibility: "allowed",
		reason: "assumed subscription usage: allowed by billing.allowUnverifiedSubscription, not verified",
		evidence,
		uncertainty,
		billing: "plan",
		rank: RANK.assumedSubscription,
	};
}

function assessExtraCredits(
	key: string,
	cfg: RouterConfig,
	quota: QuotaAssessment,
	freshness: Verification,
	evidence: string[],
	uncertainty: string[],
	spent: string,
	now: number,
): BillingAssessment {
	const credits = quota.credits;
	if (credits) evidence.push(describeCredits(credits));
	if (quota.overage) {
		const bits = [quota.overage.status, quota.overage.utilization !== undefined ? `${Math.round(quota.overage.utilization * 100)}% used` : undefined];
		const described = bits.filter((b) => b !== undefined).join(" ");
		if (described) evidence.push(`overage window ${described}`);
	}

	if (anyGlobMatch(cfg.billing.denyPaid, key)) {
		return excluded("extra-credits", "plan", freshness, `subscription exhausted (${spent}) and paid fallback is denied for ${key}`, evidence, uncertainty);
	}
	if (!anyGlobMatch(cfg.billing.allowExtraBilled, key)) {
		return excluded("extra-credits", "plan", freshness, `subscription exhausted (${spent}); ${key} is not in billing.allowExtraBilled`, evidence, uncertainty);
	}
	if (credits?.disabledReason) {
		return excluded("extra-credits", "plan", freshness, `subscription exhausted (${spent}) and extra usage is off on the account`, evidence, uncertainty);
	}
	const overageSpent = quota.overage ? windowExhausted(quota.overage, cfg, now) : undefined;
	if (overageSpent) {
		return excluded("extra-credits", "plan", freshness, `subscription exhausted (${spent}) and the extra-usage window is ${overageSpent}`, evidence, uncertainty);
	}
	const creditsFresh = credits !== undefined && now - credits.lastSeen <= cfg.billing.evidenceMaxAgeMinutes * 60_000;
	const haveCredits = credits?.unlimited === true || credits?.hasCredits === true;
	if (cfg.billing.requireVerifiedExtraBilled && !(creditsFresh && haveCredits)) {
		uncertainty.push(credits ? "credit evidence is stale or says no credits" : "no live credit evidence for this account");
		return excluded(
			"extra-credits",
			"plan",
			freshness,
			`subscription exhausted (${spent}); extra billed usage needs verified credits (billing.requireVerifiedExtraBilled)`,
			evidence,
			uncertainty,
		);
	}
	if (!haveCredits) uncertainty.push("credit availability not confirmed by the provider");
	uncertainty.push("this turn bills extra usage on top of the subscription, not included usage");
	return {
		basis: "extra-credits",
		verification: creditsFresh && haveCredits ? "verified" : freshness,
		eligibility: "allowed",
		reason: `subscription exhausted (${spent}); allowed to spend extra billed credits`,
		evidence,
		uncertainty,
		billing: "plan",
		rank: RANK.extraCredits,
	};
}

function assessPayPerToken(key: string, cfg: RouterConfig, evidence: string[], uncertainty: string[]): BillingAssessment {
	if (anyGlobMatch(cfg.billing.denyPaid, key)) {
		return excluded("pay-per-token", "on-demand", "verified", `paid inference denied for ${key} by billing.denyPaid`, evidence, uncertainty);
	}
	if (!anyGlobMatch(cfg.billing.allowPayPerToken, key)) {
		return excluded("pay-per-token", "on-demand", "verified", `${key} is not in billing.allowPayPerToken`, evidence, uncertainty);
	}
	evidence.push("billed per token at catalog list price");
	uncertainty.push("list-price estimate, not a charge receipt");
	return {
		basis: "pay-per-token",
		verification: "verified",
		eligibility: "allowed",
		reason: "pay-per-token usage allowed by billing.allowPayPerToken",
		evidence,
		uncertainty,
		billing: "on-demand",
		rank: RANK.payPerToken,
	};
}

/** An excluded verdict still reports the basis it was excluded *on*, so the reason stays legible. */
function excluded(
	basis: BillingBasis,
	billing: Billing,
	verification: Verification,
	reason: string,
	evidence: string[],
	uncertainty: string[],
): BillingAssessment {
	return { basis, verification, eligibility: "excluded", reason, evidence, uncertainty, billing, rank: RANK.excluded };
}

/** Credit evidence that positively says the credential cannot pay. Unknown is never "spent". */
function creditsSpent(credits: CreditState): boolean {
	if (credits.unlimited === true) return false;
	return credits.disabledReason !== undefined || credits.hasCredits === false;
}

/** The basis a coarse label implies, for verdicts reached before the basis is resolved. */
function labelBasis(billing: Billing): BillingBasis {
	return billing === "plan" ? "subscription" : billing === "free" ? "free" : "pay-per-token";
}

/** How fresh the provider's quota evidence is, in verification terms. */
function evidenceFreshness(quota: QuotaAssessment, cfg: RouterConfig, now: number): Verification {
	if (quota.lastEvidenceAt === undefined) return "unverified";
	return now - quota.lastEvidenceAt <= cfg.billing.evidenceMaxAgeMinutes * 60_000 ? "verified" : "stale";
}

/** One-line billing summary for status cards and routing reasons. */
export function describeBasis(a: BillingAssessment): string {
	const base = `${a.basis} (${a.verification})`;
	return a.eligibility === "excluded" ? `${base} excluded` : a.eligibility === "preferred" ? `${base} preferred` : base;
}

function ageLabel(ms: number): string {
	if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	return `${Math.round(ms / 3_600_000)}h`;
}
