# What the eval says about the router

**Input to a decision, not a decision.** This harness measures the shipped router; it
changes nothing about how the router selects or adopts a model. Everything below is
evidence for whoever owns that change.

Reproduce any figure here with the command beside it. Round-by-round working is in
[`eval/results/log.md`](../../eval/results/log.md); how to read each metric is in
[`eval/README.md`](../../eval/README.md).

---

## Read this first: what this harness can and cannot settle

A paired bootstrap over the task pack (`npm run eval -- --sweep paired`) gives the
honest answer:

> **5 of 5 cost differences resolve at 95%. 0 of 5 quality differences do.**

Round 22 tripled the pack to 20 sessions / 175 turns to test whether more tasks would
fix that. They did not: the baseline rose, every quality effect shrank with it, and the
intervals still straddle zero. Resolving a 5pp quality difference would take **~211
tasks** of this shape.

So, throughout:

- **Cost claims are measured.** Treat them as findings.
- **Quality claims are directional.** They agree across every sweep and were arrived at
  honestly, but this harness cannot resolve them. Where a quality effect matters, it is
  stated as a **fraction of available headroom**, which is stable, rather than in points,
  which are not.

---

## 0. A bug: the router can route to a provider it knows is rate-limited

`npm run eval -- --start-model faux-plan-codex/gpt-6-astra` → **exit 1**,
`ineligibleChoices: 1`.

`chooseModel`'s low-confidence early return (`src/router.ts:66-75`) hands back the
current model **without consulting `ledger.isBlocked`**:

```ts
if (confidence < cfg.switching.minConfidence && current) {
    return { ..., model: current, switched: false,
             reason: `confidence ... < ...; keeping ${currentKey}` };
}
```

So when the classifier is unsure, the router keeps whatever model the session is on —
including one the ledger has just put in a 429 cooldown. The same applies to the final
`"no configured model is available; keeping current"` branch.

**It compounds with the Jev-outage fallback.** `heuristicTier` returns confidence
**0.34 or 0.4**, and `switching.minConfidence` defaults to **0.5** — so *every* heuristic
answer takes that branch. When Jev is unavailable the router cannot route at all, and
while it cannot route it also stops avoiding exhausted providers. The two fallbacks
cancel each other out: the one for "I don't know what this turn needs" disables the one
for "this provider is refusing requests".

The observed path: Jev fails → heuristic returns 0.34 → low-confidence branch keeps the
current model → that model's provider is in a 429 cooldown → the turn is sent to it
anyway.

**Recommendation.** Check `ledger.isBlocked` before keeping the current model, in both
branches; fall through to tier selection when it is blocked. Separately, `heuristicTier`
cannot clear its own bar, which is worth deciding deliberately rather than by accident.

*Found in round 26, by sweeping the starting model — a default that had gone unexamined
for twenty-five rounds. `ineligibleChoices` was built in round 1 to catch exactly this
and had read 0 in every profile until the session started on the provider that gets
rate-limited.*

---

## 1. Fix the tier table before anything else

`npm run eval -- --audit-config` — published list prices from
`docs/data/operational-stats.json`, capability from the AA Intelligence Index in
`docs/data/benchmarks.json`. **No simulation.**

| tier | the router prefers | warm turn (list) | AA Index |
| --- | --- | ---: | ---: |
| light | `ds4/deepseek-v4-flash` | $0.0040 | 34.33 |
| standard | `openai-codex/gpt-6-astra` | **$0.6375** | 52.67 |
| heavy | `claude-bridge/claude-fable-5-1` | **$0.2625** | 53.35 |

**The `standard` tier is dominated.** Heavy's preferred model is **2.4× cheaper** than
standard's *and* scores higher. There is no request for which routing to the shipped
`standard` tier is the right decision.

This one configuration fact is upstream of several other findings:

- **Escalation is unpenalised**, so over-routing costs nothing and a crude classifier
  can out-score a careful one.
- **The fan-out inherits it.** `pickParallelModels` takes `tiers.standard[0]`, which
  makes the shipped candidate set the only one of five whose flashiest member is not its
  strongest — and therefore the only one a style-biased judge reliably wrecks (round 9).

**Recommendation.** Make the tiers a cost ladder at list price, not at marginal price.
Re-running `--audit-config` after any tier edit is a one-second check, and exits `4` if
the ladder is still broken.

---

## 2. Cheapest-in-tier is the switcher's own weakness

The router ranks within a tier by marginal cost, so a subscription model prices at $0
and always wins. Two consequences, both measured:

- The **strongest model in the fleet is never chosen**, in any profile, in any round.
- **Quality depends on the user's billing arrangement, not on their work.** With
  `--billing all-on-demand` — identical config, identical tasks, a *perfect* classifier
  — session success falls **86.7% → 68.3%** because the standard tier's preference flips
  from `gpt-6-astra` (skill 74) to `glm-5.3` (62). Tier accuracy is 100% in both.

**Recommendation.** Rank within a tier by something other than marginal cost alone —
capability, or cost subject to a capability floor. A user losing their subscription
should not silently downgrade the work.

---

## 3. Switching is expensive, and this is the load-bearing result

`npm run eval -- --pack eval/tasks/swe-router-long-v1.json`

- **$39.17 of cold-start premium on a 175-turn run — 49% of routed-turn spend**, across
  90 switches. Money that bought nothing but re-reading context the model already had.
  **This share is the load-bearing number**: it has survived fleet-skill jitter, the
  traffic constants, compaction, operator pins, billing mode, the starting model, a
  tripled pack and a plan 429, always landing between 40% and 60%.
- **A thinking-level change flushes the cache on its own.** `src/index.ts:128-129`
  re-applies `cfg.thinking[tier]` every turn; a profile that never changes model still
  pays cold starts, all of them `thinking-change`. The cache-cost study found this by
  mining logs; the eval reproduces it from the shipped code on demand.
- **~98% of that spend is invisible to the ledger**, because subscription routes report
  $0. `planPointsUsed` converts it into the unit that actually runs out.

**A related claim that does *not* hold unconditionally, and was conflated with it until
round 27:** whether routing spends more *in total* than never routing depends on which
models routing still has. With the fleet intact it spends **49% more** ($143.52 against
$96.47). With the Codex plan 429'd it spends **18% less** ($78.79) — because it is forced
onto a cheap on-demand model, and it pays 10.8pp of session success for the privilege.
That is a downgrade, not a saving, and it is the round-2 finding (cheapest-in-tier)
arriving by a different door.

**Recommendation.** Price a switch against what it buys. The estimator in
`src/router.ts:140-143` cannot do this today — the cache-cost study showed it
double-counts, prices a write at `input` rather than `cacheWrite`, and skips plan routes
entirely, which is 100% of the default configuration's traffic.

---

## 4. The two knobs that are set wrong

`--sweep confidence`, `--sweep pin`

**`switching.minConfidence: 0.5` is nearly inert and the next notch is free.** One turn
in 175 falls below the shipped bar. At **0.60** landing accuracy rises (88.0% → 88.6%),
six switches disappear and **$7.40** with them, at no cost to outcome. Do not go higher:
the bar is a *stickiness* mechanism, not a safety one — at 0.80 the session freezes on
whatever model it last picked and turn success collapses.

**`switching.manualPinTurns: 3` is not a free convenience.** It holds 15 of 175 turns and
**9 of those run in the wrong tier** — served by a model the operator chose for a
different question. It costs 4.0pp of tier accuracy and 3.4pp of session success to save
$9.17. Worse, a pin to a small-context model **forces pi to compact**: three of the
pack's compactions are pin-induced, discarding a 200k conversation down to 22k to answer
"show me the diff".

**Recommendation.** `minConfidence: 0.6`. `manualPinTurns: 1` — respect the operator's
choice for the turn they made it on. If a pin must persist, exempt turns whose context
would not fit the pinned model's window.

---

## 5. The fan-out: the idea is good, the implementation is the worst of five

`--sweep policy`, `--sweep strategy`, `--sweep bias`

**The idea works.** Running several candidates and adopting the judge's pick is the
largest quality effect measured anywhere in this work. Stated durably: **the judge
captures ~83–97% of the headroom** between the routed model and the best candidate, and
that fraction survived tripling the pack (89.5% → 89.3%) and a 6× change in how much
headroom exists, while the raw lift moved 7×.

**The shipped candidate set is the worst of five compared.** At n=3:

| candidate set | lift | fan-out $ | added wall-clock | with a 20-pt biased judge |
| --- | ---: | ---: | ---: | --- |
| **`shipped`** | +12.8pp | $356.96 | **+70%** | **collapses to +1.4pp**, 14.8 regressions |
| `tier-top` | **+16.0pp** | **$140.58** | **+25%** | **unmoved: +16.0pp**, 0 regressions |
| `spread` | **+19.0pp** | $359.87 | +69% | +15.8pp, 0 regressions |

`tier-top` — the model the router itself prefers in each tier — is better, **2.5×
cheaper**, **2.8× less added wall-clock**, and immune to a bias that costs the shipped
set almost all of its lift. The shipped set is slowest because `tiers.standard[0]` is
`gpt-6-astra`, which has the worst time-to-first-token in the fleet; a fan-out waits on
its slowest member, since `src/parallel.ts` runs candidates in parallel.

**On whether `/duo` should ever be a default:** fanning out with the shipped set makes a
session **70% longer**; with `tier-top`, **25% longer**. Money scales with the number of
candidates and time does not — but time scales with the worst one.

**Fan out to learn, not to pay.** `--explore-turns 3` (fan out for three turns, then
commit to the judge's favourite) reaches the same quality as fanning out every turn for
**a fraction of the spend**, because you pay for 3 fan-outs per session instead of 10 and
committing also stops the router switching.

**Two warnings.**

1. **The confidence gate is not a defence.** `src/parallel.ts` only auto-adopts above
   `switching.minConfidence`. At the shipped 0.5 that costs 3.0pp of lift when the judge
   is good and recovers 0.3pp when it is badly biased — because a biased judge is
   *confidently* wrong (mean confidence when wrong: 0.33 at bias 0, 0.94 at bias 40).
2. **Commitment amplifies bias.** Exploration is the best shape of the idea with a clean
   judge and the worst with a biased one: one wrong verdict stops being a per-turn tax
   and governs the rest of the session.

---

## 6. The measurement that decides §5, and has not been taken

Everything in §5 is a bet on Jev's judging being unbiased, and **nobody has measured
it**. `--sweep assumptions` makes the stakes explicit: with fan-out off, no judge
assumption moves the outcome at all; turn fan-out on and **judge bias becomes the single
loudest input (±26.7pp)**, while the starting model and the fleet's declared competence
fall to ±1.7pp each. Running several candidates absorbs a bad starting point and a wrong
guess about who is good at what — and replaces both with a bet on the judge.

```bash
ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge
```

36 Jev calls, **no model inference**, under a cent. It shows Jev 18 pairs of written
answers whose true quality is declared and whose presentation is deliberately opposed,
in both label orders, and reports the bias in the same units `--sweep bias` prices. The
probe is calibrated: it recovers an injected bias to within 8 points.

Read the answer against `--sweep bias`:

| Jev probes at | what §5 is worth |
| --- | --- |
| ≤10 points | the full effect above |
| ~20 points | roughly zero, and the fan-out bill is pure loss |
| ≥40 points | **negative** — worse than not fanning out |

The companion, `ROUTER_EVAL_LIVE=1 npm run eval -- --classifier live --record`, replaces
the hand-written classifier answers in the task packs with what Jev actually says, which
removes the standing asterisk on every `scripted` number.

---

## What would make the quality half measurable

Not a bigger fixture — round 22 tested that. It needs real tasks executed by real models:
the oracle's declared `skill` replaced by what a model actually did. That is a different
and much larger harness, and this one is built so its pieces (the router loop, the
ledger accounting, the cache and compaction model, the judge probe, the sweeps, the
paired bootstrap) would carry over to it.
