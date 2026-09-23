/**
 * pi-modelrouter — route each turn to the right-sized model, cheaply.
 *
 * Per turn: build a compact state -> one Jev call (tier / needs_tools / stakes)
 * -> pick the cheapest billing-eligible model in that tier (billing basis + plan quota +
 * cache-switch aware, see billing.ts) -> pi.setModel before the agent loop starts.
 *
 * Commands: /router [status|on|off|reload|explain|billing|models|update], /duo <prompt>, /trio <prompt>, /par [N] <prompt>
 */
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { assessBilling, billsPerToken, describeBasis } from "./billing.ts";
import { loadConfig, modelKey, type RouterConfig, type Tier, TIERS } from "./config.ts";
import { refreshEntitlements } from "./entitlement.ts";
import { type JevChoiceAnswer, JevClient, type JevNoulAnswer, type JevScoreAnswer } from "./jev.ts";
import { Ledger, ledgerPath } from "./ledger.ts";
import { factsCache, offeredModels, reportLines, reportTiers } from "./models.ts";
import { PARALLEL_ENTRY_TYPE, type ParallelEntryData, renderParallelEntry, runParallel } from "./parallel.ts";
import { runModelsCommand } from "./picker.ts";
import { checkRemote, readReleaseInfo, releaseLine, type ReleaseInfo, updateLines } from "./release.ts";
import { chooseModel, type Decision, heuristicTier } from "./router.ts";
import { buildRoutingState, routingQuestions, STAKES_QUESTION_KEY, TIER_QUESTION_KEY, TOOLS_QUESTION_KEY } from "./state.ts";

const STATUS_KEY = "modelrouter";

export default function modelRouter(pi: ExtensionAPI) {
	let cfg: RouterConfig = loadConfig(process.cwd()).config;
	let jev = new JevClient(cfg.jev);
	// Shared with every other pi session on this agent dir; Ledger.save() locks and merges.
	const ledger = new Ledger(ledgerPath(join(getAgentDir(), "modelrouter")));

	let turn = 0;
	let pinnedUntilTurn = 0;
	let selfSwitching = false;
	let lastDecision: Decision | undefined;
	let enabled = cfg.enabled;
	// Local file reads, resolved once on first use: the running build is a fact about this process,
	// so it cannot change under it, and the remote is asked about by /router update alone.
	let release: ReleaseInfo | undefined;

	const reload = (cwd: string) => {
		const loaded = loadConfig(cwd);
		cfg = loaded.config;
		jev = new JevClient(cfg.jev);
		enabled = cfg.enabled;
		return loaded;
	};

	pi.registerEntryRenderer<ParallelEntryData>(PARALLEL_ENTRY_TYPE, (entry, { expanded }, theme) =>
		renderParallelEntry(entry.data, expanded, theme),
	);

	// ---- routing -------------------------------------------------------------

	const refreshGatewayKey = async (ctx: ExtensionContext) => {
		try {
			jev.setStoredGatewayKey(await ctx.modelRegistry.getApiKeyForProvider("vercel-ai-gateway"));
		} catch {
			jev.setStoredGatewayKey(undefined);
		}
	};

	/**
	 * Read-only entitlement refresh. Never sends inference. It runs before the routing decision,
	 * so a turn whose probe interval has elapsed waits for it (bounded by billing.probe.timeoutMs);
	 * probing off the turn's critical path would route on older evidence and is a follow-up.
	 */
	const refreshBilling = async (ctx: ExtensionContext) => {
		try {
			await refreshEntitlements({ cfg, registry: ctx.modelRegistry, ledger });
		} catch {
			// probe failures are recorded per provider; routing continues on an unverified basis
		}
	};

	/** `/router reload`, also run after `/router models` saves, so a change applies without a restart. */
	const reloadRouter = async (ctx: ExtensionCommandContext) => {
		const loaded = reload(ctx.cwd);
		await refreshGatewayKey(ctx);
		await refreshBilling(ctx);
		ctx.ui.notify(`router: reloaded (${loaded.sources.length ? loaded.sources.join(", ") : "defaults"})${loaded.errors.length ? `; errors: ${loaded.errors.join("; ")}` : ""}`, loaded.errors.length ? "warning" : "info");
		return cfg;
	};

	pi.on("session_start", async (event, ctx) => {
		reload(ctx.cwd);
		await refreshGatewayKey(ctx);
		turn = 0;
		pinnedUntilTurn = 0;
		await refreshBilling(ctx);
		updateStatus(ctx);
		if (event.reason === "startup") warnTierProblems(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		turn += 1;
		if (!enabled || !ctx.model) return;
		if (turn <= pinnedUntilTurn) {
			// A manual /model choice is honoured, but never without saying what pays for it.
			await refreshBilling(ctx);
			const pinned = assessBilling({ model: ctx.model, cfg, registry: ctx.modelRegistry, ledger });
			setStatus(ctx, `pinned ${modelKey(ctx.model)} (${pinnedUntilTurn - turn + 1} more turn${pinnedUntilTurn - turn === 0 ? "" : "s"}, ${describeBasis(pinned)})`);
			if (pinned.eligibility === "excluded" && ctx.hasUI) {
				ctx.ui.notify(`router: pinned ${modelKey(ctx.model)} is not billing-eligible: ${pinned.reason}`, "warning");
			}
			return;
		}
		const started = Date.now();
		let tier: Tier;
		let confidence: number;
		let jevMs: number | undefined;
		let jevModel: string | undefined;
		let needsTools: number | undefined;
		let stakes: number | undefined;

		if (jev.available()) {
			try {
				const state = buildRoutingState(event.prompt, ctx, cfg, turn);
				const res = await jev.ask(state, routingQuestions(), ctx.signal);
				const t = res.answers[TIER_QUESTION_KEY] as JevChoiceAnswer | undefined;
				if (!t || !TIERS.includes(t.choice as Tier)) throw new Error("no tier answer");
				tier = t.choice as Tier;
				confidence = t.confidence;
				needsTools = (res.answers[TOOLS_QUESTION_KEY] as JevNoulAnswer | undefined)?.noul;
				stakes = (res.answers[STAKES_QUESTION_KEY] as JevScoreAnswer | undefined)?.score;
				// High stakes with a confident "light" call is the one place we override Jev.
				if (stakes !== undefined && stakes >= 1.5 && tier === "light") tier = "standard";
				jevMs = res.ms;
				jevModel = res.model;
				ledger.recordJev(res.transport, res.model, res.usage.input_tokens, res.usage.output_tokens, res.costUsd);
			} catch (err) {
				const h = heuristicTier(event.prompt);
				tier = h.tier;
				confidence = h.confidence;
				if (ctx.hasUI) ctx.ui.notify(`router: Jev failed (${err instanceof Error ? err.message : String(err)}); heuristic tier ${tier}`, "warning");
			}
		} else {
			const h = heuristicTier(event.prompt);
			tier = h.tier;
			confidence = h.confidence;
		}

		await refreshBilling(ctx);
		const choice = chooseModel({
			tier,
			confidence,
			current: ctx.model,
			registry: ctx.modelRegistry,
			cfg,
			ledger,
			contextTokens: ctx.getContextUsage()?.tokens ?? 0,
		});
		lastDecision = { ...choice, jevMs, jevModel, needsTools, stakes, at: started };

		if (choice.model && choice.switched) {
			selfSwitching = true;
			const ok = await pi.setModel(choice.model);
			selfSwitching = false;
			if (!ok) {
				lastDecision.reason += " (setModel refused: no auth)";
				lastDecision.switched = false;
			} else if (cfg.notifyOnSwitch && ctx.hasUI) {
				const basis = choice.billing ? describeBasis(choice.billing) : "billing unknown";
				const spend = choice.billing && billsPerToken(choice.billing.basis) ? `, ~$${estimatedSpend(choice).toFixed(4)} this turn` : "";
				ctx.ui.notify(`router: ${tier} -> ${modelKey(choice.model)} (${(confidence * 100).toFixed(0)}%, ${basis}${spend})`, "info");
			}
		}
		// Staying on a model the billing gate would refuse is worth saying out loud.
		if (choice.ineligibleCurrent && ctx.hasUI) {
			ctx.ui.notify(`router: no billing-eligible model; staying on ${modelKey(ctx.model)} which is itself ${choice.ineligibleCurrent}`, "warning");
		}
		const level = cfg.thinking[choice.tier];
		if (level && choice.model?.reasoning) pi.setThinkingLevel(level);
		updateStatus(ctx);
	});

	pi.on("model_select", async (event) => {
		if (selfSwitching) return;
		if (event.source === "set" || event.source === "cycle") {
			pinnedUntilTurn = turn + cfg.switching.manualPinTurns;
		}
	});

	pi.on("message_end", async (event) => {
		const m = event.message as { role?: string; provider?: string; model?: string; usage?: Parameters<Ledger["record"]>[2] };
		if (m.role !== "assistant" || !m.provider || !m.model) return;
		ledger.record(m.provider, m.model, m.usage);
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (!ctx.model) return;
		ledger.observeResponse(ctx.model.provider, event.status, event.headers ?? {}, cfg);
	});

	pi.on("session_shutdown", async () => {
		ledger.save();
	});

	// ---- commands ------------------------------------------------------------

	pi.registerCommand("router", {
		description: "Model router: status | on | off | reload | explain | billing | models | update",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().split(/\s+/)[0] ?? "";
			switch (sub) {
				case "on":
					enabled = true;
					ctx.ui.notify("router: enabled", "info");
					break;
				case "off":
					enabled = false;
					ctx.ui.notify("router: disabled (model stays as is)", "info");
					break;
				case "billing":
					await refreshBilling(ctx);
					showBilling(ctx);
					break;
				case "reload":
					await reloadRouter(ctx);
					break;
				case "models":
					await refreshBilling(ctx);
					await runModelsCommand({ ctx, cfg, ledger, reload: () => reloadRouter(ctx), showCard: (title, lines) => showCard(ctx, title, lines) });
					break;
				case "explain":
					showExplain(ctx);
					break;
				case "update":
					await showUpdate(ctx);
					break;
				default:
					showStatus(ctx);
			}
			updateStatus(ctx);
		},
	});

	const parallelCommand = (fixedN?: number) => async (args: string, ctx: ExtensionCommandContext) => {
		let rest = (args ?? "").trim();
		let n = fixedN ?? cfg.parallel.defaultN;
		if (!fixedN) {
			const m = rest.match(/^(\d+)\s+([\s\S]*)$/);
			if (m) {
				n = Math.max(2, Math.min(8, Number(m[1])));
				rest = m[2]!.trim();
			}
		}
		if (!rest) {
			const typed = await ctx.ui.editor("Prompt for the parallel run", "");
			if (!typed?.trim()) return;
			rest = typed.trim();
		}
		await runParallel({ pi, ctx, prompt: rest, n, cfg, ledger, jev, routerEnabled: enabled });
	};
	pi.registerCommand("duo", { description: "Ask 2 models the same prompt in parallel", handler: parallelCommand(2) });
	pi.registerCommand("trio", { description: "Ask 3 models the same prompt in parallel", handler: parallelCommand(3) });
	pi.registerCommand("par", { description: "Ask N models in parallel: /par [N] <prompt>", handler: parallelCommand() });

	// ---- helpers -------------------------------------------------------------

	/** What the chosen route is estimated to bill this turn, so moving onto paid usage is visible. */
	function estimatedSpend(choice: Pick<Decision, "model" | "candidates">): number {
		const key = choice.model ? modelKey(choice.model) : undefined;
		const chosen = choice.candidates.find((c) => c.key === key);
		return (chosen?.costUsd ?? 0) + (chosen?.switchPenaltyUsd ?? 0);
	}

	/** Local, cached for the process: package.json, the checkout's HEAD and pi's settings entry. */
	function releaseInfo(ctx: { cwd: string }): ReleaseInfo {
		const agentDir = getAgentDir();
		release ??= readReleaseInfo({
			agentDir,
			settingsFiles: [
				{ path: join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"), scope: "project", baseDir: ctx.cwd },
				{ path: join(agentDir, "settings.json"), scope: "user", baseDir: agentDir },
			],
		});
		return release;
	}

	function setStatus(ctx: ExtensionContext, text: string) {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `${text}${channelMark(ctx)}`);
	}

	/** The one place the channel is always on screen; stable adds nothing, dev is worth a word. */
	function channelMark(ctx: ExtensionContext): string {
		try {
			const ch = releaseInfo(ctx).channel;
			return ch === "stable" ? "" : ` ·${ch}`;
		} catch {
			return "";
		}
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!enabled) return setStatus(ctx, "router off");
		if (!lastDecision) return setStatus(ctx, jev.available() ? `router ready (${jev.transport()})` : "router (no Jev credential: heuristic)");
		const d = lastDecision;
		const bits = [`${d.tier}${d.tier !== d.requestedTier ? `←${d.requestedTier}` : ""}`, `${(d.confidence * 100).toFixed(0)}%`];
		if (d.jevMs !== undefined) bits.push(`${d.jevMs}ms`);
		setStatus(ctx, `router ${bits.join(" ")}${d.switched ? " ⇄" : ""}`);
	}

	/** Channel, version and commit, then — only because it was asked for — the tip of that ref. */
	async function showUpdate(ctx: ExtensionCommandContext) {
		const info = releaseInfo(ctx);
		const remote = await checkRemote(info);
		showCard(ctx, "router update", updateLines(info, remote));
	}

	function showStatus(ctx: ExtensionCommandContext) {
		const lines: string[] = [];
		lines.push(releaseLine(releaseInfo(ctx)));
		lines.push(`enabled: ${enabled}   jev: ${jev.describe()}   pinned: ${pinnedUntilTurn > turn ? `${pinnedUntilTurn - turn} turns` : "no"}`);
		if (ctx.model) lines.push(`current: ${modelKey(ctx.model)} (${basisOf(ctx, ctx.model)})`);
		for (const tier of TIERS) {
			const items = (cfg.tiers[tier] ?? []).map((key) => {
				const slash = key.indexOf("/");
				const m = ctx.modelRegistry.find(key.slice(0, slash), key.slice(slash + 1));
				if (!m) return `${key}✗`;
				if (!ctx.modelRegistry.hasConfiguredAuth(m)) return `${key}(no auth)`;
				const a = assessBilling({ model: m, cfg, registry: ctx.modelRegistry, ledger });
				return a.eligibility === "excluded" ? `${key}(excluded: ${a.reason})` : `${key}(${describeBasis(a)})`;
			});
			lines.push(`${tier}: ${items.join(", ") || "-"}`);
		}
		// Unusable entries are marked inline above; what the tiers leave out is not, so say it here.
		const report = tierReport(ctx);
		const untiered = reportLines({ ...report, unusable: [] });
		lines.push(...untiered);
		if (untiered.length > 0 || report.unusable.length > 0) lines.push("/router models to choose tiers");
		lines.push(...ledger.summaryLines());
		if (lastDecision) lines.push(`last: ${lastDecision.reason}`);
		showCard(ctx, "router status", lines);
	}

	function tierReport(ctx: ExtensionContext) {
		return reportTiers(cfg.tiers, offeredModels(ctx.scopedModels, ctx.modelRegistry), factsCache({ cfg, registry: ctx.modelRegistry, ledger }));
	}

	/**
	 * Once per launch: a tier naming a model pi cannot route to, or an eligible model no tier
	 * names, is a configuration mistake that otherwise stays silent. Billing exclusions are left
	 * to the turn that meets them, since quota comes and goes.
	 */
	function warnTierProblems(ctx: ExtensionContext) {
		if (!ctx.hasUI || !enabled) return;
		const report = tierReport(ctx);
		const unusable = report.unusable.filter((u) => u.state !== "excluded");
		const lines = reportLines({ ...report, unusable, untieredQuiet: 0 });
		if (lines.length === 0) return;
		const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
		const some = (keys: string[]) => {
			const unique = [...new Set(keys)];
			return unique.length > 4 ? `${unique.slice(0, 4).join(", ")} +${unique.length - 4} more` : unique.join(", ");
		};
		const summary =
			lines.length <= 2
				? lines.join("; ")
				: [
						unusable.length ? `${plural(unusable.length, "tier entry", "tier entries")} pi cannot route to (${some(unusable.map((u) => u.key))})` : "",
						report.empty.length ? `empty: ${report.empty.join(", ")}` : "",
						report.untiered.length ? `in no tier: ${some(report.untiered.map((f) => f.key))}` : "",
					]
						.filter(Boolean)
						.join("; ");
		ctx.ui.notify(`router: ${summary} (/router models)`, "warning");
	}

	function showExplain(ctx: ExtensionCommandContext) {
		if (!lastDecision) {
			ctx.ui.notify("router: no decision yet this session", "info");
			return;
		}
		const d = lastDecision;
		const lines = [
			`tier ${d.tier} (asked ${d.requestedTier}) confidence ${(d.confidence * 100).toFixed(0)}%` +
				(d.jevModel ? ` via ${d.jevModel} in ${d.jevMs}ms` : " via heuristic"),
			`needs_tools ${d.needsTools?.toFixed(2) ?? "-"}   stakes ${d.stakes?.toFixed(2) ?? "-"}`,
			`chosen: ${d.model ? modelKey(d.model) : "-"}${d.switched ? " (switched)" : ""}`,
			`reason: ${d.reason}`,
		];
		if (d.billing) {
			lines.push(`billing: ${describeBasis(d.billing)} — ${d.billing.reason}`);
			for (const e of d.billing.evidence) lines.push(`  evidence: ${e}`);
			for (const u of d.billing.uncertainty) lines.push(`  uncertain: ${u}`);
			if (d.billing.uncertainty.length === 0) lines.push("  uncertain: none");
		}
		for (const c of d.candidates) {
			lines.push(
				c.skipped
					? `  ${c.key}: skipped (${c.skipped})`
					: `  ${c.key}: ${c.assessment ? describeBasis(c.assessment) : c.billing} ~$${c.costUsd.toFixed(4)}${c.switchPenaltyUsd ? ` +switch $${c.switchPenaltyUsd.toFixed(4)}` : ""} cap ${c.capability}`,
			);
		}
		showCard(ctx, "router explain", lines);
	}

	function basisOf(ctx: ExtensionCommandContext, model: NonNullable<ExtensionCommandContext["model"]>): string {
		return describeBasis(assessBilling({ model, cfg, registry: ctx.modelRegistry, ledger }));
	}

	/** Full billing picture: what pays for each configured route, and what is still unproven. */
	function showBilling(ctx: ExtensionCommandContext) {
		const lines: string[] = [];
		const seen = new Set<string>();
		for (const key of [...TIERS.flatMap((t) => cfg.tiers[t] ?? []), ...cfg.parallel.models]) {
			if (seen.has(key)) continue;
			seen.add(key);
			const slash = key.indexOf("/");
			const m = ctx.modelRegistry.find(key.slice(0, slash), key.slice(slash + 1));
			if (!m) {
				lines.push(`${key}: unknown model`);
				continue;
			}
			if (!ctx.modelRegistry.hasConfiguredAuth(m)) {
				lines.push(`${key}: no auth`);
				continue;
			}
			const a = assessBilling({ model: m, cfg, registry: ctx.modelRegistry, ledger });
			lines.push(`${key}: ${describeBasis(a)} — ${a.reason}`);
			for (const e of a.evidence) lines.push(`    evidence: ${e}`);
			for (const u of a.uncertainty) lines.push(`    uncertain: ${u}`);
		}
		lines.push(...ledger.summaryLines().filter((l) => l.startsWith("quota ")));
		showCard(ctx, "router billing", lines);
	}

	function showCard(ctx: ExtensionCommandContext, title: string, lines: string[]) {
		pi.appendEntry("modelrouter-card", { title, lines });
	}

	pi.registerEntryRenderer<{ title: string; lines: string[] }>("modelrouter-card", (entry, _opts, theme) => {
		const c = new Container();
		c.addChild(new Text(theme.fg("accent", `[${entry.data?.title ?? "router"}]`), 1, 0));
		for (const line of entry.data?.lines ?? []) c.addChild(new Text(line, 1, 0));
		return c;
	});
}
