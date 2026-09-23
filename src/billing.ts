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
 * A route is `preferred` only when it is subscription-backed *and* verified, or zero-cost. Paid routes are not
 * refused for being paid - they are ranked below included usage, so that when subscription
 * capacity is genuinely used up the turn still has somewhere to go and the explanation says what
 * is paying. Only a route that cannot serve the turn - no auth, a cooldown, or a spent window or
 * balance with no paid path - is excluded.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { anyGlobMatch, type Billing, modelKey, overrideFor, type RouterConfig } from "./config.ts";
import { type CreditState, describeCredits, type Ledger, type QuotaAssessment, windowExhausted } from "./ledger.ts";

/** What pays for this turn. */
export type BillingBasis = "free" | "subscription" | "extra-credits" | "pay-per-token";

/** How well the basis is established. Only `verified` rests on live provider evidence. */
export type Verification = "verified" | "stale" | "unverified";

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

/**
 * The order routes are preferred in: included subscription usage and zero-cost routes first, then a
 * plan label nothing has verified, then - once subscription capacity really is used up - the
 * account's own extra credits, and last ordinary per-token billing. Evidence sorts the subscription
 * basis against itself (verified ahead of assumed) and never against another credential: a
 * subscription with no sign of being spent is still included usage, and spending money on a second
 * account's credits while it sits unused is the one thing this ordering exists to prevent. Paid
 * routes are ranked, never refused: only a route that cannot serve the turn at all is excluded.
 */
const RANK = { verifiedSubscription: 0, free: 0, assumedSubscription: 1, extraCredits: 2, payPerToken: 3, excluded: 9 } as const;

export interface AssessArgs {
	model: Model<Api>;
	cfg: RouterConfig;
	registry: ModelRegistry;
	ledger: Ledger;
	now?: number;
}

/**
 * The coarse label, and whether configuration asserted it or the registry implied it.
 *
 * One precedence, used on every path: a configured `models` label decides, whether it was
 * written for this model or for a glob over its provider. Only where no label claims the route
 * does the catalog price decide, because a catalog zero also means "price not published" — it is
 * never taken as proof that a route somebody labelled billed is free.
 */
export function billingLabel(model: Model<Api>, cfg: RouterConfig, registry: ModelRegistry): { billing: Billing; fromConfig: boolean } {
	const override = overrideFor(cfg, modelKey(model)).billing;
	if (override) return { billing: override, fromConfig: true };
	if (zeroCost(model)) return { billing: "free", fromConfig: false };
	return { billing: registry.isUsingOAuth(model) ? "plan" : "on-demand", fromConfig: false };
}

/** Bases that spend money per token, so the catalog price is a real estimate rather than $0. */
export function billsPerToken(basis: BillingBasis): boolean {
	return basis === "pay-per-token" || basis === "extra-credits";
}

export function assessBilling(args: AssessArgs): BillingAssessment {
	const { model, cfg, ledger } = args;
	const now = args.now ?? Date.now();
	const key = modelKey(model);
	const quota = ledger.assess(model.provider, key, cfg, now);
	return withUnattributed(assessRoute(args, key, quota, now), quota, model.provider);
}

function assessRoute(args: AssessArgs, key: string, quota: QuotaAssessment, now: number): BillingAssessment {
	const { model, cfg, registry } = args;
	const { billing, fromConfig } = billingLabel(model, cfg, registry);
	const evidence: string[] = [];
	const uncertainty: string[] = [];

	const freshness = freshnessOf(quota.lastEvidenceAt, cfg, now);
	if (quota.lastEvidenceAt !== undefined) {
		evidence.push(`${quota.sources.join("+")} evidence ${ageLabel(now - quota.lastEvidenceAt)} old for ${model.provider}`);
	}
	if (quota.plan) evidence.push(`provider reports plan "${quota.plan}"`);

	// The credential refused a call and said nothing about which window: it is out for every route
	// it backs, whatever the basis, and extra billed credits are not a way around its own refusal.
	if (quota.refused.length > 0) {
		const refused = quota.refused.map((w) => w.reason).join(", ");
		evidence.push(`credential refused (${refused})`);
		return excluded(labelBasis(billing), billing, freshness, `${model.provider} is refusing calls on this credential (${refused})`, evidence, uncertainty);
	}

	// A spent model-scoped window excludes the route whatever the basis is.
	if (quota.exhaustedScoped.length > 0) {
		const w = quota.exhaustedScoped[0]!;
		evidence.push(`model-scoped window ${w.reason}`);
		const alsoAccount = quota.exhaustedAccount.map((a) => a.reason).join(", ");
		const rest = alsoAccount ? `${model.provider} is spent account-wide too (${alsoAccount})` : `${model.provider} stays usable for other models`;
		return excluded(labelBasis(billing), billing, freshness, `model-scoped quota exhausted (${w.reason}); ${rest}`, evidence, uncertainty);
	}

	if (billing === "plan") {
		return assessSubscription(key, cfg, quota, freshnessOf(quota.accountWindowsAt, cfg, now), fromConfig, evidence, uncertainty, now);
	}

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
		if (freshnessOf(quota.credits.lastSeen, cfg, now) === "verified") {
			return excluded(labelBasis(billing), billing, freshness, `${model.provider} account cannot pay for this route (${state})`, evidence, uncertainty);
		}
		uncertainty.push(`the last word on ${model.provider} credit was "${state}", older than ${cfg.billing.evidenceMaxAgeMinutes}m`);
	}

	if (billing === "free") return assessFree(model, key, cfg, fromConfig, evidence, uncertainty);
	return assessPayPerToken(key, cfg, evidence, uncertainty);
}

/**
 * A spent meter this provider reports that names no route the config can reach. It says something
 * about the credential we cannot place, so it can neither be ignored nor read as the account being
 * spent: it travels with every verdict for that provider as uncertainty, and nothing claiming to
 * rest on that provider's evidence gets to call itself verified while it stands.
 */
function withUnattributed(verdict: BillingAssessment, quota: QuotaAssessment, provider: string): BillingAssessment {
	if (quota.unattributed.length === 0) return verdict;
	const spent = quota.unattributed.map((w) => w.reason).join(", ");
	return {
		...verdict,
		verification: verdict.verification === "verified" ? "unverified" : verdict.verification,
		eligibility: verdict.eligibility === "preferred" ? "allowed" : verdict.eligibility,
		// Ordering has to say the same thing the other two fields now say. A quota meter says
		// nothing about a catalog list price, so a zero-cost route keeps the rank it earned.
		rank: verdict.rank === RANK.verifiedSubscription && verdict.basis === "subscription" ? RANK.assumedSubscription : verdict.rank,
		uncertainty: [...verdict.uncertainty, `${provider} reports a spent meter no configured route answers to (${spent})`],
	};
}

function assessFree(
	model: Model<Api>,
	key: string,
	cfg: RouterConfig,
	fromConfig: boolean,
	evidence: string[],
	uncertainty: string[],
): BillingAssessment {
	const free = zeroCost(model);
	if (free) evidence.push("catalog list price is zero");
	else uncertainty.push(`configuration labels ${key} free, but its catalog price is not zero`);
	if (fromConfig && !free) return assessPayPerToken(key, cfg, evidence, uncertainty);
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
	if (quota.exhaustedAccount.length > 0) {
		// Subscription is spent. Anything further is extra billed usage, which needs its own permission.
		const spent = quota.exhaustedAccount.map((w) => w.reason).join(", ");
		evidence.push(`subscription window exhausted (${spent})`);
		return assessExtraCredits(key, cfg, quota, freshness, evidence, uncertainty, spent, now);
	}

	// Subscription-metered quota windows are only served to subscription-billed traffic, so a
	// fresh account window is what turns the configured label into an established fact.
	if (freshness === "verified" && quota.accountWindows.length > 0) {
		evidence.push(`live subscription windows ${quota.accountWindows.join(", ")} seen ${ageLabel(now - quota.accountWindowsAt!)} ago`);
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

	uncertainty.push(planLabelProvenance(key, fromConfig));
	if (freshness === "stale") uncertainty.push(`last quota evidence is older than ${cfg.billing.evidenceMaxAgeMinutes}m`);
	else if (quota.accountWindows.length === 0) uncertainty.push("provider reported no subscription quota window");
	else uncertainty.push("no quota or entitlement evidence seen for this provider yet");

	return {
		basis: "subscription",
		verification: freshness,
		eligibility: "allowed",
		reason: "assumed subscription usage: nothing has verified the plan behind this route",
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

	if (!anyGlobMatch(cfg.billing.allowExtraBilled, key)) {
		return excluded("extra-credits", "plan", freshness, `subscription exhausted (${spent}); ${key} is not in billing.allowExtraBilled`, evidence, uncertainty);
	}
	const creditFreshness = freshnessOf(credits?.lastSeen, cfg, now);
	if (credits?.disabledReason && creditFreshness === "verified") {
		return excluded("extra-credits", "plan", freshness, `subscription exhausted (${spent}) and extra usage is off on the account`, evidence, uncertainty);
	}
	const overageSpent = quota.overage ? windowExhausted(quota.overage, cfg, now) : undefined;
	if (overageSpent) {
		return excluded("extra-credits", "plan", freshness, `subscription exhausted (${spent}) and the extra-usage window is ${overageSpent}`, evidence, uncertainty);
	}
	const verifiedCredits = creditFreshness === "verified" && (credits?.unlimited === true || credits?.hasCredits === true);
	if (!verifiedCredits) {
		uncertainty.push(credits ? "credit evidence is stale or says no credits" : "no live credit evidence for this account");
		return excluded(
			"extra-credits",
			"plan",
			freshness,
			`subscription exhausted (${spent}); extra billed usage is only spent on verified credits`,
			evidence,
			uncertainty,
		);
	}
	uncertainty.push("this turn bills extra usage on top of the subscription, not included usage");
	return {
		basis: "extra-credits",
		verification: "verified",
		eligibility: "allowed",
		reason: `subscription exhausted (${spent}); allowed to spend extra billed credits`,
		evidence,
		uncertainty,
		billing: "plan",
		rank: RANK.extraCredits,
	};
}

function assessPayPerToken(key: string, cfg: RouterConfig, evidence: string[], uncertainty: string[]): BillingAssessment {
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

/** A route at a zero list price spends no balance, whatever the credential's own state is. */
function zeroCost(model: Model<Api>): boolean {
	return model.cost.input === 0 && model.cost.output === 0;
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

/** Where a "plan" label came from, which is never itself evidence of subscription billing. */
function planLabelProvenance(key: string, fromConfig: boolean): string {
	return fromConfig
		? `"plan" label for ${key} comes from configuration, not from an entitlement check`
		: `"plan" inferred from the provider using OAuth, which does not prove subscription billing`;
}

/** How fresh one piece of evidence is, in verification terms. Absent evidence verifies nothing. */
function freshnessOf(at: number | undefined, cfg: RouterConfig, now: number): Verification {
	if (at === undefined) return "unverified";
	return now - at <= cfg.billing.evidenceMaxAgeMinutes * 60_000 ? "verified" : "stale";
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
