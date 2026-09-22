/**
 * N-way parallel responses (/duo, /trio, /par N).
 *
 * Fans the same conversation + prompt out to N models in-process through
 * ctx.modelRegistry.complete (uses pi's own auth, no tools), optionally lets Jev
 * pick the best answer, then lets the user adopt one into the session.
 */
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import { authOf, assessBilling, describeBasis } from "./billing.ts";
import { modelKey, type RouterConfig, TIERS } from "./config.ts";
import type { JevChoiceAnswer, JevClient, JsonValue } from "./jev.ts";
import type { Ledger } from "./ledger.ts";
import { type Candidate, evaluateCandidate } from "./router.ts";
import { contentToText, truncate } from "./state.ts";

export const PARALLEL_ENTRY_TYPE = "modelrouter-parallel";
export const ADOPTED_MESSAGE_TYPE = "modelrouter-adopted";

export interface ParallelResult {
	label: string;
	key: string;
	text: string;
	ms: number;
	ok: boolean;
	error?: string;
	usage?: AssistantMessage["usage"];
	judgeProbability?: number;
	/** Billing basis this response was produced on, e.g. `subscription (verified)`. */
	basis?: string;
}

export interface ParallelEntryData {
	prompt: string;
	results: ParallelResult[];
	judge?: { pick: string; confidence: number; model: string; ms: number };
	adopted?: string;
	at: number;
}

export interface RunParallelArgs {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	prompt: string;
	n: number;
	cfg: RouterConfig;
	ledger: Ledger;
	jev: JevClient;
	/** Whether automatic routing is on. Off means the fan-out is refused, not merely unrouted. */
	routerEnabled: boolean;
}

export interface ParallelSelection {
	models: Model<Api>[];
	/** Candidates the billing gate or auth turned down, with the verdict's reason. */
	rejected: { key: string; reason: string }[];
	/** What the selection costs that a better-ranked eligible route would not have. */
	notes: string[];
}

export interface PickParallelArgs {
	ctx: ExtensionCommandContext;
	cfg: RouterConfig;
	n: number;
	ledger: Ledger;
	now?: number;
}

/**
 * Same gate *and* the same ordering as automatic routing: a candidate must pass auth and billing
 * eligibility before it can be fanned out to, and the slots the caller did not name go to the
 * best-ranked candidates. An explicit `parallel.models` list is the caller's own choice of what
 * to compare, so it is honoured in configured order and never reordered or dropped for a
 * better-ranked route - but when that choice bills while an eligible included-usage route waits,
 * the selection says so rather than quietly spending.
 */
export function pickParallelModels(args: PickParallelArgs): ParallelSelection {
	const { ctx, cfg, n, ledger } = args;
	const registry = ctx.modelRegistry;
	const eligible: Candidate[] = [];
	const rejected: { key: string; reason: string }[] = [];
	const seen = new Set<string>();
	const currentKey = ctx.model ? modelKey(ctx.model) : undefined;
	const chooseArgs = { tier: "standard" as const, confidence: 1, current: ctx.model ?? undefined, registry, cfg, ledger, contextTokens: 0, now: args.now };
	const consider = (key: string | undefined) => {
		if (!key || seen.has(key)) return;
		seen.add(key);
		const candidate = evaluateCandidate(key, chooseArgs, currentKey);
		if (candidate.skipped || !candidate.model) {
			rejected.push({ key, reason: candidate.skipped ?? "unknown model" });
			return;
		}
		eligible.push(candidate);
	};

	if (cfg.parallel.models.length > 0) {
		for (const key of cfg.parallel.models) consider(key);
		const taken = eligible.slice(0, n);
		return { models: taken.map((c) => c.model!), rejected, notes: unusedPreferredNotes(taken, eligible.slice(n)) };
	}
	consider(currentKey);
	// Strongest first, one per tier, then the remaining tier lists: that is the diversity order.
	for (const tier of [...TIERS].reverse()) consider(cfg.tiers[tier]?.[0]);
	for (const tier of [...TIERS].reverse()) {
		for (const key of cfg.tiers[tier] ?? []) consider(key);
	}
	const ranked = eligible
		.map((candidate, order) => ({ candidate, order }))
		.sort((a, b) => (a.candidate.assessment?.rank ?? 0) - (b.candidate.assessment?.rank ?? 0) || a.order - b.order);
	return { models: ranked.slice(0, n).map((r) => r.candidate.model!), rejected, notes: [] };
}

/** One note naming the best eligible route that went unused, and the slots it was passed over for. */
function unusedPreferredNotes(taken: Candidate[], passedOver: Candidate[]): string[] {
	const best = passedOver.reduce<Candidate | undefined>((a, c) => ((a?.assessment?.rank ?? 99) <= (c.assessment?.rank ?? 99) ? a : c), undefined);
	const bestRank = best?.assessment?.rank;
	if (best === undefined || bestRank === undefined) return [];
	const outranked = taken.filter((c) => c.assessment && c.assessment.rank > bestRank);
	if (outranked.length === 0) return [];
	const slots = outranked.map((c) => `${c.key} (${describeBasis(c.assessment!)})`).join(", ");
	return [
		`${best.key} (${describeBasis(best.assessment!)}) was eligible and went unused, passed over for ${slots}: parallel.models names what to compare, so it is honoured as written.`,
	];
}

export async function runParallel(args: RunParallelArgs): Promise<ParallelEntryData | undefined> {
	const { pi, ctx, prompt, n, cfg, ledger, jev } = args;
	if (!args.routerEnabled) {
		ctx.ui.notify("Parallel mode is off while the router is disabled (/router on to re-enable).", "error");
		return undefined;
	}
	const { models, rejected, notes } = pickParallelModels({ ctx, cfg, n, ledger });
	for (const note of notes) ctx.ui.notify(`router: ${note}`, "warning");
	if (models.length < 2) {
		const why = rejected.length ? ` Rejected: ${rejected.map((r) => `${r.key} (${r.reason})`).join("; ")}` : "";
		ctx.ui.notify(`Need at least 2 billing-eligible models for parallel mode (found ${models.length}).${why}`, "error");
		return undefined;
	}

	const history = ctx.sessionManager
		.getBranch()
		.filter((e): e is typeof e & { message: unknown } => (e as { type?: string }).type === "message")
		.map((e) => (e as { message: unknown }).message);
	const llmMessages: Message[] = convertToLlm(history as Parameters<typeof convertToLlm>[0]);
	const userMessage: Message = { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() };
	const context = { systemPrompt: ctx.getSystemPrompt(), messages: [...llmMessages, userMessage] };

	const labels = models.map((_, i) => String.fromCharCode(65 + i));
	const results: ParallelResult[] = models.map((m, i) => ({
		label: labels[i]!,
		key: modelKey(m),
		text: "",
		ms: 0,
		ok: false,
		basis: describeBasis(assessBilling({ model: m, cfg, registry: ctx.modelRegistry, ledger })),
	}));

	const outcome = await ctx.ui.custom<ParallelResult[] | null>((tui, theme, _kb, done) => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(new Error("timeout")), cfg.parallel.timeoutMs);
		const container = new Container() as Container & { handleInput?: (data: string) => void };
		const header = new Text(theme.fg("accent", `Parallel x${models.length}: `) + theme.fg("dim", truncate(prompt.replace(/\s+/g, " "), 80)), 1, 0);
		container.addChild(header);
		const lines = results.map((r) => new Text(`${theme.fg("muted", r.label)} ${r.key} ${theme.fg("dim", `[${r.basis}] running…`)}`, 1, 0));
		for (const l of lines) container.addChild(l);
		container.addChild(new Text(theme.fg("dim", "Esc to cancel"), 1, 0));
		container.handleInput = (data: string) => {
			if (matchesKey(data, "escape")) controller.abort(new Error("cancelled"));
		};

		const runOne = async (model: Model<Api>, i: number) => {
			const started = Date.now();
			const r = results[i]!;
			try {
				const response = await ctx.modelRegistry.complete(model, context, {
					signal: controller.signal,
					cacheRetention: "none",
					sessionId: uuidv7(),
					// A fan-out spends the same quota a routed turn does, so what the provider says
					// about that quota has to reach the ledger the same way.
					onResponse: (res: { status: number; headers: Record<string, string> }) =>
						ledger.observeResponse(model.provider, res.status, res.headers ?? {}, cfg, Date.now(), authOf(ctx.modelRegistry)),
				} as Parameters<typeof ctx.modelRegistry.complete>[2]);
				r.ms = Date.now() - started;
				r.usage = response.usage;
				ledger.record(model.provider, model.id, response.usage);
				if (response.stopReason === "error" || response.stopReason === "aborted") {
					r.error = response.errorMessage ?? response.stopReason;
				} else {
					r.text = contentToText(response.content);
					r.ok = r.text.trim().length > 0;
					if (!r.ok) r.error = "empty response";
				}
			} catch (err) {
				r.ms = Date.now() - started;
				r.error = err instanceof Error ? err.message : String(err);
			}
			const status = r.ok
				? theme.fg("success", `ok ${(r.ms / 1000).toFixed(1)}s, ${r.usage?.output ?? 0} tok, $${(r.usage?.cost.total ?? 0).toFixed(4)}`)
				: theme.fg("error", `failed: ${r.error}`);
			lines[i]!.setText(`${theme.fg("muted", r.label)} ${r.key} ${theme.fg("dim", `[${r.basis}]`)} ${status}`);
			tui.requestRender();
		};

		Promise.allSettled(models.map(runOne)).then(() => {
			clearTimeout(timeout);
			done(controller.signal.aborted && controller.signal.reason?.message === "cancelled" ? null : results);
		});
		return container;
	});

	if (outcome === null) {
		ctx.ui.notify("Parallel run cancelled", "info");
		return undefined;
	}

	const entry: ParallelEntryData = { prompt, results, at: Date.now() };
	const good = results.filter((r) => r.ok);
	if (good.length === 0) {
		pi.appendEntry<ParallelEntryData>(PARALLEL_ENTRY_TYPE, entry);
		ctx.ui.notify("All parallel responses failed", "error");
		return entry;
	}

	if (cfg.parallel.judge === "jev" && jev.available() && good.length >= 2) {
		try {
			const state: JsonValue = {
				request: prompt,
				responses: Object.fromEntries(good.map((r) => [r.label, truncate(r.text, cfg.parallel.maxResponseCharsForJudge)])),
			};
			const criteria = Object.fromEntries(good.map((r) => [r.label, `Response ${r.label} in \`responses\``]));
			const res = await jev.ask(state, {
				best: {
					type: "choice",
					instructions: {
						question: "Which of `responses` best answers `request` for a software engineer? Prefer correctness, then completeness, then concision.",
					},
					criteria,
				},
			});
			const best = res.answers.best as JevChoiceAnswer | undefined;
			if (best) {
				for (const r of good) r.judgeProbability = best.probabilities[r.label];
				entry.judge = { pick: best.choice, confidence: best.confidence, model: res.model, ms: res.ms };
			}
		} catch (err) {
			ctx.ui.notify(`Judge failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	}

	// Show everything durably in the transcript (not sent to the LLM).
	pi.appendEntry<ParallelEntryData>(PARALLEL_ENTRY_TYPE, entry);

	let adopt: ParallelResult | undefined;
	const judged = entry.judge ? good.find((r) => r.label === entry.judge!.pick) : undefined;
	if (cfg.parallel.autoAdopt && judged && entry.judge!.confidence >= cfg.switching.minConfidence) {
		adopt = judged;
	} else {
		const ordered = judged ? [judged, ...good.filter((r) => r !== judged)] : good;
		const options = ordered.map((r) => {
			const tag = entry.judge && r === judged ? ` [judge pick ${(entry.judge.confidence * 100).toFixed(0)}%]` : "";
			return `${r.label}: ${r.key}${tag}`;
		});
		const choice = await ctx.ui.select("Adopt which response into the conversation?", [...options, "None"]);
		if (choice && choice !== "None") adopt = ordered[options.indexOf(choice)];
	}

	if (adopt) {
		entry.adopted = adopt.label;
		pi.sendMessage(
			{
				customType: ADOPTED_MESSAGE_TYPE,
				content: `The user asked (via a parallel run):\n\n${prompt}\n\nAdopted answer from ${adopt.key}:\n\n${adopt.text}`,
				display: false,
				details: { key: adopt.key, label: adopt.label },
			},
			// Agent is idle here (command handler), so "steer" appends to the session immediately,
			// ahead of the user's next prompt. No triggerTurn: the user decides what happens next.
			{ deliverAs: "steer" },
		);
		const adoptedModel = models.find((m) => modelKey(m) === adopt!.key);
		if (cfg.parallel.switchToWinner && adoptedModel && ctx.model && modelKey(ctx.model) !== adopt.key) {
			await pi.setModel(adoptedModel);
		}
		ctx.ui.notify(`Adopted ${adopt.label} (${adopt.key})`, "info");
	}
	return entry;
}

/** Durable transcript rendering for a parallel run. */
export function renderParallelEntry(data: ParallelEntryData | undefined, expanded: boolean, theme: Theme): Container {
	const c = new Container();
	if (!data) {
		c.addChild(new Text(theme.fg("dim", "[parallel] no data"), 1, 0));
		return c;
	}
	const ok = data.results.filter((r) => r.ok).length;
	const judge = data.judge ? ` judge: ${data.judge.pick} (${(data.judge.confidence * 100).toFixed(0)}%)` : "";
	const adopted = data.adopted ? ` adopted: ${data.adopted}` : "";
	c.addChild(new Text(`${theme.fg("accent", `[parallel x${data.results.length}]`)} ${ok} ok${judge}${adopted}`, 1, 0));
	for (const r of data.results) {
		const meta =
			(r.basis ? `${r.basis}, ` : "") +
			(r.ok
				? `${(r.ms / 1000).toFixed(1)}s, ${r.usage?.output ?? 0} tok, $${(r.usage?.cost.total ?? 0).toFixed(4)}` +
					(r.judgeProbability !== undefined ? `, p=${r.judgeProbability.toFixed(2)}` : "")
				: `failed: ${r.error}`);
		c.addChild(new Text(`${theme.fg("muted", r.label)} ${r.key} ${theme.fg("dim", meta)}`, 1, 0));
		if (r.ok) {
			const body = expanded ? r.text : truncate(r.text.replace(/\s+/g, " "), 240);
			c.addChild(new Text(body, 3, 0));
		}
	}
	if (!expanded) c.addChild(new Text(theme.fg("dim", "(expand tool output to read full responses)"), 1, 0));
	return c;
}
