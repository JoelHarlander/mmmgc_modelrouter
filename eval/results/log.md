# Router eval rounds

One entry per round: what it measured, what it changed, what the numbers did.
Runs are reproduced with `npm run eval -- <flags>`; the JSON for each is in this directory.
**For the distilled version, read [`docs/research/router-eval-findings.md`](../../docs/research/router-eval-findings.md).**

## Findings index

Jump to the round that established each claim, and what it rests on.

> **Read rounds 21–22 first.** A paired bootstrap over the pack's tasks shows that
> **5 of 5 cost differences resolve at 95% and 0 of 5 quality differences do** on the
> 20-task long pack. Cost claims below are supported by the pack; quality claims are
> **directional only** — they agree across sweeps and were arrived at honestly, but this
> harness cannot resolve them at any pack size that can be hand-authored (~211 tasks for
> 5pp, ~1300 for 2pp). The durable form of the fan-out result is not a point difference
> at all: **the judge captures ~83–97% of whatever headroom exists**, and the raw lift is
> that fraction times however much room the work leaves.

| Finding | Round | Robust to |
| --- | :---: | --- |
| ~~The router never picks an ineligible model~~ | 1 | **FALSIFIED in r26.** Start the session on the provider that gets 429'd and the low-confidence branch keeps it, cooldown and all. |
| **A Jev outage disables quota avoidance**: every `heuristicTier` confidence is below `minConfidence`, so the fallback always takes the branch that skips `isBlocked` | **26** | read from `src/router.ts` |
| `planHiddenUsd` is ~98% of spend: almost all of it is invisible to the ledger it spends by | 1 | everything swept |
| The default tiers are **not a cost ladder** — escalating a tier makes a turn *cheaper* | 2, **11** | **published list prices, no simulation** |
| The shipped **`standard` tier is dominated by `heavy`**: cheaper *and* more capable, so no request justifies it | **11** | published prices + AA Intelligence Index |
| Cheapest-in-tier means the strongest model is never chosen, in any profile | 2 | — |
| At realistic context, **switching costs ~half of a long session's spend** (50.2% of it; $24.94 after r16 corrected r4's $34.26) | 4, **16** | ±20pt fleet jitter (r7), traffic constants (r5) |
| A profile that never changes model still pays 14 cold starts, all `thinking-change` | 4 | — |
| ~~Never switching *also* wins on quality~~ | 4 | **WITHDRAWN in r19.** It was an artefact of starting the session on the strongest model. Averaged over starting points, routing wins 65.8% to 41.7%. |
| *(under-powered)* **Routing's value is insensitive to the starting model** (5pp spread across six starts); not routing varies by **45pp** and simply inherits whatever it began on | **19** | every fleet model as a start |
| Fan-out costs 2.9× more per extra solve at realistic context ($4.94 → $14.28) | 4 | traffic constants (r5) |
| **The judge captures ~83–97% of the headroom between the routed model and the best candidate** — invariant across a 6× change in headroom; the raw lift (+9pp to +62pp) is not | 3, 21, **22** | traffic constants (r5); start model (r22) |
| **~20 points of judge bias makes fan-out worse than not running it** | 3 | 5 seeds × 3 widths |
| Random judge error is far more forgiving than systematic bias; noise partly cancels bias | 3 | 5 seeds |
| The shipped **confidence gate does not defend against bias** — a biased judge is confidently wrong | 8 | 5 seeds × 3 bias levels |
| *(under-powered)* The **shipped candidate set is the worst of five**: `tier-top` gets +21.7pp for 40% of the spend and is bias-immune | 9 | 5 seeds; bias-immunity is model-dependent |
| The fan-out's fragility to bias is the **tier price inversion** (r2) propagating into `pickParallelModels` | 9 | fleet prices |
| ~~The shipped routing confidence bar (0.50) is nearly inert~~ | 12 | **REFUTED in r35.** That was my handwriting. Against Jev's own confidences it suppresses **30% of routed turns, 56% of them correct**. |
| **Jev is systematically under-confident by 13.1pp**, so a bar set on its raw confidence sits ~13 points too high — `minConfidence` should be **lowered**, not raised | **35** | live, 160 routed turns |
| **Jev under-routes "why / who else / walk me through" questions** that sit on hard work — it reads *needs no tools* as *is easy* | **35** | live, long pack |
| **Confirmed by controlled experiment: the same work worded as a question is rated ~0.83 tiers lighter**, 6–0 with no counter-example. Heavy work asked as a question is called *light* 4 times in 6, at mean confidence **0.87** | **36** | live, 12 paired prompts |
| ~~The cause is `needs_tools`~~ | 35, 36 | **REFUTED in r37.** Removing it from the request changes nothing. The cause is the `light` criterion's own words: *"answer a factual question, explain a snippet"*. |
| **The router cannot fix it**: the stakes override reaches **0 of 15** under-routed light turns, because Jev rates their stakes low too | **37** | live, 5 override variants |
| **Jev's judging noise is ≤5** (42/42 on non-tie probe items), so the candidate-set floor is insurance against a risk that is not present → **use `tier-top`** | **37** | live probe + 4 policies × 4 noise levels |
| A candidate rewrite of the `light` criterion **closes 30% of the phrasing gap** and lifts question accuracy 33.3% → 50.0%; a partial fix, not a fix | **38** | live, deterministic on 12 pairs |
| The §0 fix, simulated: **32 of 396 broken configurations → 0**, byte-identical where nothing is blocked | **38** | exact |
| Raising that bar is **stickiness, not safety**: at 0.80 the session freezes on one model for 51 of 60 turns | **12** | both packs |
| A perfect classifier still lands in the wrong tier, because a `/model` pin outlives the turn it was for | **12** | — |
| *(cost: resolved; quality: under-powered)* **Fan-out as *exploration* is ~20× more cost-effective than fanning out every turn**: +21.3pp for $0.81/solve vs $16.03 | **13** | 5 seeds |
| …but commitment **amplifies** judge bias: at 20 points, every explore depth is worse than not fanning out at all | **13** | 5 seeds |
| **The router's quality depends on your billing, not your work**: same config, same tasks, 86.7% → 68.3% when models stop being free | **14** | isolates one variable |
| On a plan, "never switch" is free and best; **off a plan it is the most expensive option** (2× the router's spend) | **14** | both packs |
| The shipped `manualPinTurns: 3` leaves **7 of 12 pinned turns in the wrong tier**, costing 10pp of session success | **15** | long pack |
| **A `/model` pin to a small-context model forces pi to compact**, discarding the conversation to serve a one-line request | **16** | pi's own `shouldCompact` |
| Every compaction in the pack was **avoidable by routing**: a roomier model was authed and available | **16** | fleet windows |
| Those avoidable compactions cost **5 turns of quality (8.3pp)** on top of their money and cache | **17** | penalty 6–40 pts |

**What the whole thing rests on** (round 20, `--sweep assumptions`, ordered by how far
each moves session success on the long pack):

| | routing only | with fan-out (n=3) |
| --- | ---: | ---: |
| routing confidence bar | **±25.0pp** | ±26.7pp |
| fleet skill (±20 jitter) | ±16.6pp | ±1.7pp |
| billing arrangement | ±15.0pp | ±10.0pp |
| `/model` pin length | ±11.7pp | ±5.0pp |
| starting model | ±3.3pp | ±1.7pp |
| **judge bias** | **0.0pp** | **±26.7pp** |
| judge error / gate / temperature | 0.0pp | ±15.0 / ±15.0 / ±11.7pp |
| calls per turn | 0.0pp *(but ±$74 and ±43.8pp of cold share)* | 0.0pp |

**Turning on fan-out moves the answer's dependency from the router to the judge** — and
the judge is the one thing this harness cannot measure offline.

**MEASURED, round 34 (2026-09-23).** Jev carries **no detectable presentation or length
bias**: 0.0% presentation-trap rate, 3.1% length-trap, **0 estimated bias points on both
axes**, dominant axis **none**, 95.8% accuracy over 48 presentations with a 100% aligned
control. Read as "below the probe's ~6-point resolution", which puts the candidate result
in its best band. **The $450 question resolves in favour of `tier-top`.** Cost of the
measurement: **$0.00** — the gateway serves Jev on system credentials at `cost: "0"`.

---

## Round 1 — 2026-09-22 — first measurement

**Measured.** The whole switcher on the 15-task, 31-turn `swe-router-v1` pack: which
model each turn was routed to, whether that model was eligible and affordable, what it
cost in money and cache, and whether the work got done. Four profiles.

| profile | resolve | turn | tier acc | under | over | in-tier miss | list $ | hidden $ | cold | cold prem |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `scripted` | 46.7% | 64.5% | 83.9% | 9.7% | 6.5% | 4 | $11.48 | $11.28 | 26/31 | $4.98 |
| `heuristic` | 86.7% | 87.1% | 58.1% | 29.0% | 12.9% | 3 | $9.78 | $9.74 | 27/31 | $4.55 |
| `oracle` | 53.3% | 67.7% | 100% | 0% | 0% | 5 | $9.72 | $9.50 | 21/31 | $3.46 |
| `scripted --candidates 3` | 46.7% | 64.5% | 83.9% | 9.7% | 6.5% | 4 | $31.23 | $30.78 | 26/31 | $4.98 |

Candidate selection, 3 responses per turn, offline judge at noise 10: baseline 64.5% →
judge **93.5%**, ceiling 93.5%, lift **+29.0pp**, recall 100%, 0 regressions,
$19.74 of fan-out at **$2.19 per extra turn solved**. At `--candidates 4` the ceiling
reaches 100% and the lift +35.5pp at $2.90 per extra solve.

**Changed.** Everything: this is the first round. `eval/` harness, `npm run eval`,
task pack, fleet, four classifier modes, candidate-selection mode, 19 behavioural
tests, results files and this log.

**What the numbers did — and the one that indicts the harness.** `heuristic` beats
both `scripted` and `oracle` on outcome (87.1% vs 64.5% and 67.7%) while classifying
*worse* than either (58.1% tier accuracy, 29% under-routed). That is not a finding
about the router; it is a defect in this pack's ground truth. `heuristicTier` sends
almost everything to `standard`, where the plan model has skill 72, whereas a correct
`light` classification lands on a light model with skill 34–38 — and several turns
labelled `goldTier: light` were given a `requiredSkill` of 44–46 that no light model
can reach. A correct classification is being punished for being correct.

Two more things the round exposes, both real:

1. **`ineligibleChoices` is 0 across every profile** — the router never picked an
   unauthed, blocked or unknown model, including after the plan 429. The mechanism is
   sound; the disagreements are all about which *eligible* model to prefer.
2. **`planHiddenUsd` is 98% of total spend** ($11.28 of $11.48). Almost everything
   this router spends is invisible to the ledger it spends by, exactly as the
   cache-cost study predicted. `faux-gw/claude-fable-5-1` — the strongest model in the
   fleet — is never chosen, in any profile: cheapest-in-tier always prefers the
   zero-marginal-cost plan model beside it.

**Next.** Fix the ground truth before trusting any quality number: `goldTier` must be
the cheapest tier that contains a model able to do the turn, and that invariant has to
be enforced by a test, not by my care in writing JSON.

<!-- notes appended by `npm run eval -- --note "..."` land below -->

---

## Round 2 — 2026-09-22 — fix the ground truth, then trust the numbers

**Measured.** Whether round 1's quality numbers meant anything. They did not: a pack
whose `goldTier` labels disagree with its own `requiredSkill` punishes a correct
classification, and round 1 shipped one.

**Changed.**

1. **`goldTier` is now derived, not declared.** The harness computes it as the cheapest
   tier holding a model that reaches the turn's `requiredSkill` — which tier can do a
   piece of work is a fact about the fleet, not about the task. The fixture still
   writes it down for readability and `npm run eval -- --validate` fails when the two
   disagree.
2. **A documented skill ladder** (`fleet.json` → `skillLadder`), whose three bands
   restate the tier criteria in `src/state.ts`, so `requiredSkill` and the tier Jev is
   asked to pick mean the same thing. Fleet skills and all 31 `requiredSkill` values
   were recalibrated onto it. Five `jev.stakes` values above 2 were also wrong — the
   `score` question in `src/state.ts` has three criteria, so it returns 0..2.
3. **`--validate`**, run automatically before every eval: 12 real defects on the round-1
   pack, 0 now, and four tests keep it that way.
4. **A tier price-inversion check** and **`planPointsUsed`** (see below).

**What the numbers did.**

| profile | resolve | turn | tier acc | under | over | under-fail | in-tier miss | list $ | plan pts | cold | cold prem |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `scripted` | 66.7% | 80.7% | 83.9% | 9.7% | 6.5% | 3 | 3 | $11.48 | 0.28 | 26/31 | $4.98 |
| `heuristic` | 86.7% | 93.5% | 58.1% | 29.0% | 12.9% | 0 | 2 | $9.78 | 0.25 | 27/31 | $4.55 |
| `oracle` | 73.3% | 87.1% | 100% | 0% | 0% | 0 | 4 | $9.72 | 0.24 | 21/31 | $3.46 |
| `scripted --candidates 3` | 66.7% | 80.7% | 83.9% | 9.7% | 6.5% | 3 | 3 | $31.23 | 0.78 | 26/31 | $4.98 |

`scripted` 64.5% → **80.7%** turn success and `oracle` 67.7% → **87.1%**; the ordering
scripted < oracle is now the right way round, and `underRouteFailures` falls to 0 for
both `oracle` and `heuristic`. Candidate selection at n=3 reads honestly for the first
time: baseline 80.7% → judge **93.5%** against a **96.8%** ceiling, lift **+12.9pp**,
recall 97%, **1 regression**, $19.74 of fan-out at **$4.94 per extra turn solved**. In
round 1 the judge looked perfect (100% recall, 0 regressions) only because the
mis-calibrated skill gaps were too wide to get wrong.

**`heuristic` still beats `oracle` on outcome — and that one is real.** Two findings
behind it, both about the router rather than the harness:

1. **The switcher picks the cheapest model in a tier, not a capable one.** `oracle`
   routes perfectly and still loses 4 turns to `inTierMisses`: right tier, wrong model
   inside it. `faux-gw/claude-fable-5-1`, the strongest model in the fleet, is chosen
   **zero** times in every profile.
2. **The default tiers are not a cost ladder.** `--validate` now names it: the router
   prefers `claude-opus-5` in *heavy* at $0.34 per warm turn over `gpt-6-astra` in
   *standard* at $0.68, because plan routes price at $0 and Astra's list price is
   twice Opus's. Escalating a tier makes the turn cheaper, so over-routing is not
   penalised — which is exactly how a crude classifier outscores a perfect one.

`planPointsUsed` makes the hidden half legible: the `scripted` run spends **0.28 of a
weekly Claude-plan point** while its ledger records $0.21. At `--candidates 3` that
rises to **0.78 points** for +12.9pp of turn success.

**Next.** The offline judge is the least trustworthy part of the candidate story — one
noise setting, one seed. Sweep it, and check whether the judge's lift survives a judge
that is worse than skill-minus-10.

---

## Round 3 — 2026-09-22 — stop trusting one judge setting

**Measured.** Whether round 2's headline candidate result — "+12.9pp for $4.94 per
extra solve" — was a property of the idea or of one knob at one seed. It was largely
the knob.

**Changed.** `--sweep judge` and `--sweep bias`: the pack run across candidate count ×
judge quality × five seeds, reporting the mean lift with its spread. Added
`--judge-bias`, a judge that hands the flashiest candidate free skill points
regardless of quality — the documented failure mode of preferring the flagship's house
style. Two tests pin the shape of both sweeps.

**What the numbers did.**

Random error degrades the lift gracefully (n=3, mean of 5 seeds):

| judge noise | judge | lift | spread | recall | regressions | $/extra solve |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 96.8% | +16.1pp | ±0.0 | 100% | 0.0 | $3.95 |
| 10 | 95.5% | +14.8pp | ±1.6 | 98.7% | 0.2 | $4.34 |
| 20 | 91.0% | +10.3pp | ±4.8 | 94.0% | 1.2 | $7.04 |
| 40 | 85.8% | +5.2pp | ±8.1 | 88.7% | 2.6 | $12.75 |
| 80 | 78.7% | **−1.9pp** | ±11.3 | 81.3% | 4.2 | — |

**Systematic bias is far more expensive than random error.** At noise 10 the same
judge goes from +14.8pp to **−9.7pp** as its preference for the flashy answer grows:

| bias (skill points) | n=3 lift @ noise 10 | regressions |
| ---: | ---: | ---: |
| 0 | +14.8pp | 0.2 |
| 10 | +8.4pp | 1.8 |
| 20 | −1.3pp | 3.8 |
| 40 | **−9.7pp** | 6.0 |

A bias of 20 points — a judge that reliably rates the flagship one band higher than it
deserves — is enough to make running three responses and judging them **worse than not
running them at all**, while still paying $19.74 of fan-out.

Two further readings:

- **Noise partially cancels bias.** At bias 40, going from noise 10 to noise 30
  *improves* the lift (−9.7pp → −3.9pp): random error breaks up a systematic
  preference. A judge that is merely unreliable is safer than one that is reliably
  wrong in one direction.
- **More candidates buys robustness, not just ceiling.** n=4 is the only width that
  reaches a 100% ceiling (it is the only one that includes `claude-fable-5-1`) and it
  still returns +14.2pp at noise 40, where n=3 returns +5.2pp. The fan-out's own
  candidate policy — inherited from `src/parallel.ts` — never includes the strongest
  model at n=2 or n=3, because `tiers.heavy[0]` is the plan model.

**The honest headline is therefore narrower than round 2's.** Candidate selection is
worth roughly **+15pp of turn success for ~$4 per extra solve when the judge is
good**, it is worth nothing once the judge carries ~20 points of systematic bias, and
the harness cannot currently tell which of those Jev is. That is the next thing to
measure, and it needs live Jev.

**Next.** Live mode reaches the classifier but not the judge, so the one number that
would settle this — Jev's own bias when picking between real responses — is still
unmeasured.

---

## Round 4 — 2026-09-22 — measure at the context sizes that actually occur

**Measured.** Whether the first three rounds measured the cache at all. They did not.
`swe-router-v1`'s sessions are 1–3 turns at 9k–80k of context; this machine's pi logs
put Opus context per call at **p50 235k, p90 370k**. At 20k a cold start is rounding
error. At 200k it is the largest line in the turn — so every cost conclusion so far
was taken in the regime where the thing being studied barely exists.

**Changed.** Added `swe-router-long-v1`: 6 SWE-bench-style issues worked over 8–12
turns each, 80k–256k of context, with hard turns interleaved with cheap follow-ups —
the shape that makes the router oscillate. 60 turns, ground truth validated by the
same invariant. The pack id is now part of the results profile so a long run is never
compared against a short one. Added `medianTaskTurnSuccess` / `worstTaskTurnSuccess`
(on a 10-turn session `taskResolveRate` saturates at 0) and `coldPremiumShare`. Four
new tests; also fixed a `NaN` delta when a metric was `Infinity` in both runs.

**What the numbers did.**

| profile | turn | median task | tier acc | in-tier miss | list $ | plan pts | switches | cold | cold prem | share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `v1-scripted` | 80.7% | 100% | 83.9% | 3 | $11.48 | 0.28 | 10 | 26/31 | $4.98 | 43% |
| `v1-oracle` | 87.1% | 100% | 100% | 4 | $9.72 | 0.24 | 5 | 21/31 | $3.46 | 36% |
| **`long-v1-scripted`** | 75.0% | 80.9% | 86.7% | 8 | **$69.27** | 1.72 | **34** | 40/60 | **$34.26** | **49%** |
| **`long-v1-heuristic`** | **96.7%** | 100% | 38.3% | 1 | **$50.05** | 1.26 | **0** | 20/60 | $17.44 | 35% |
| `long-v1-oracle` | 86.7% | 95.0% | 100% | 8 | $62.45 | 1.55 | 34 | 40/60 | $30.28 | 48% |

**Three things fall out, and none of them were visible before this round.**

1. **Half of what the router spends on a long session is cold starts.**
   `coldPremiumShare` is **49%** on `long-v1-scripted` — $34.26 of $69.27 bought
   nothing but re-reading context the model had already been given. 34 switches in 60
   turns: the router changes its mind on more than half of all turns.

2. **Not switching beats switching perfectly, on quality *and* on cost.**
   `long-v1-heuristic` sends everything to one model, makes **0 switches**, and
   reaches **96.7%** turn success for **$50.05**. `long-v1-oracle` classifies every
   turn correctly, makes **34 switches**, and reaches **86.7%** for $62.45. Perfect
   routing is 10pp worse and 25% more expensive than never routing at all. Two known
   causes compound: the tier price inversion from round 2 means escalating is free, and
   cheapest-in-tier means the tier the router lands on is served by its weakest member.

3. **The cache-cost study's headline reproduces as a measurement.**
   `long-v1-heuristic` never changes model and still pays **14 cold starts**, every one
   of them `thinking-change`: `src/index.ts:128-129` re-applies `cfg.thinking[tier]` on
   each turn, and a thinking-level change invalidates the message cache on its own. The
   study found this by mining session logs; the eval now produces it from the shipped
   code, on demand, offline.

**And the candidate answer changes with it.** At realistic context a fan-out candidate
pays the **full uncached input rate** for the whole prompt (`src/parallel.ts` passes
`cacheRetention: "none"`), so the price of the idea scales with context:

| pack | baseline | judge | lift | fan-out $ | **$ per extra solve** |
| --- | ---: | ---: | ---: | ---: | ---: |
| `swe-router-v1` | 80.7% | 93.5% | +12.9pp | $19.74 | **$4.94** |
| `swe-router-long-v1` | 75.0% | 93.3% | +18.3pp | $157.08 | **$14.28** |

The lift is *larger* on long sessions (+18.3pp) and each point of it costs **2.9×
more**. Any claim about what candidate selection is worth has to name the context size
it was measured at; rounds 1–3 quoted the cheap end without saying so.

**Next.** Every cost number now depends on `cacheRetention: "none"` staying true of the
shipped fan-out and on the ~5 calls / 650 growth / 550 output traffic profile. The
first is pinned by a test; the second is three constants nobody has varied. Find out
how much the conclusions move when they do.

---

## Round 5 — 2026-09-22 — find out which conclusions rest on the constants

**Measured.** How far round 4's cost findings move when the three numbers underneath
them move. `callsPerTurn = 5`, `cacheGrowthTokensPerCall = 650` and
`outputTokensPerCall = 550` are measurements from one machine's logs, quoted by every
dollar figure in this log, and until now nobody had varied them.

**Changed.** The three constants became a `TrafficProfile` that `runEval` takes,
`--calls-per-turn` overrides and `--sweep profile` varies. Two tests pin the
invariances below, so a future change to the cost model that breaks them fails loudly.

**What the numbers did** (`swe-router-long-v1`, scripted, `--candidates 3`):

| calls | growth | output | list $ | cold prem | share | fan-out $ | $/extra solve |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | 650 | 550 | $209.93 | **$34.26** | 64.8% | $157.08 | **$14.28** |
| 5 | 650 | 550 | $226.35 | **$34.26** | 49.5% | $157.08 | **$14.28** |
| 10 | 650 | 550 | $254.07 | **$34.26** | 35.3% | $157.08 | **$14.28** |
| 20 | 650 | 550 | $310.85 | **$34.26** | 22.3% | $157.08 | **$14.28** |
| 5 | 100 | 550 | $225.11 | $34.39 | 50.6% | $157.08 | $14.28 |
| 5 | 3000 | 550 | $231.64 | $33.70 | 45.2% | $157.08 | $14.28 |
| 5 | 650 | 150 | $222.98 | $34.26 | 52.0% | $157.08 | $14.28 |
| 5 | 650 | 2000 | $238.57 | $34.26 | 42.0% | $157.08 | $14.28 |

**Two conclusions are load-bearing and one is not.**

- **Robust: the cold-start bill.** $34.26 across a 10× range of calls per turn, and
  within 2% across a 30× range of cache growth. A cold start writes the prefix once,
  whatever the turn does afterwards, so the *dollars* the router loses to switching do
  not depend on the traffic profile at all.
- **Robust: the whole candidate-selection verdict.** `$14.28 per extra solve` is
  identical in every row. `src/parallel.ts` makes one uncached call per candidate and
  runs no tools, so the fan-out bill is a function of context alone. Rounds 3 and 4's
  candidate findings survive the constants entirely.
- **Not robust: "half of what a long session costs is cold starts."** That share runs
  from **64.8%** at 2 calls/turn to **22.3%** at 20. Round 4's "49%" is the measured
  median and should always be quoted with the profile it came from. The defensible
  form is the absolute one: *switching cost this run $34.26, between a fifth and two
  thirds of its spend depending on how tool-heavy the work is.*

**Next.** Everything measured so far is offline. The one number that would settle
round 3's open question — how much systematic bias Jev's own judging carries — needs a
live call, and live mode currently reaches the classifier but not the judge.

---

## Round 6 — 2026-09-22 — measure the judge instead of assuming it

**Measured.** The question rounds 3 and 5 both closed on: `--sweep bias` says what N
points of judge bias *cost*, but nothing said how many points a real judge *has*. That
gap is load-bearing — round 3 found 20 points is enough to make fan-out worse than not
running it, so "is candidate selection worth it?" cannot be answered without it.

**Changed.** Added `--probe` and `eval/tasks/judge-probe-v1.json`: 18 requests with two
written answers each, true quality declared and presentation deliberately opposed. On a
**trap** item the worse answer is the confident, well-formatted, thoroughly-hedged one;
on an **aligned** item it is the better one — a control for a judge that has merely
learned to distrust formatting. Every item is shown in both label orders, so position
bias cannot masquerade as presentation bias. `estimatedBiasPoints` converts the observed
trap rate into the units `--sweep bias` is denominated in, so a probe reading can be
priced directly against the sweep.

`--probe --live-judge` runs the same probe against **real Jev**. It is 36 Jev calls and
**no model inference at all** — under a cent — which makes the one outstanding
measurement cheap enough that nobody has an excuse not to take it.

**What the numbers did.** The probe was built, failed, and was fixed inside the round.
The first version had only obvious traps (45–55 point quality gaps) and was blind
exactly where it mattered:

| injected bias | v1 estimate | v2 estimate |
| ---: | ---: | ---: |
| 0 | 0 | 0 |
| 5 | — | 2 |
| 10 | — | 6 |
| 15 | — | 16 |
| **20** | **0** ❌ | **24** |
| 30 | — | 32 |
| 40 | 42 | 42 |
| 60 | 60 | 60 |

A 20-point bias — the one round 3 identified as the break-even — registered as **zero**,
because no trap in the pack had a gap narrow enough for 20 points to flip. Six
narrow-gap traps (8–34 points, subtly-worse answers rather than obviously-wrong ones)
fixed it: the probe now recovers injected bias across the whole range with a mean error
of about 3 points, and a test holds it to within 8.

The `alignedAccuracy` control stays at **100% at every bias level**, which is what makes
the trap rate readable: the probe is measuring a preference for presentation, not a
penalty on formatting. `positionBias` is 0% for the offline judge, as it must be.

**The state of the candidate question, stated honestly.** Everything needed to answer it
is now in place and one measurement is missing, by design rather than by oversight:

- If Jev probes at **≤10 points**: candidate selection is worth **+14.8pp** of turn
  success at **$4.94/extra solve** on short sessions, **$14.28** on long ones.
- If Jev probes at **~20 points**: the lift is roughly **zero** and the fan-out bill is
  pure loss.
- If Jev probes at **≥40 points**: fan-out plus judging is **−9.7pp**, actively worse
  than routing one model.

Which of those three is true is a `ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`
away, and this task is not authorised to spend on it.

**Next.** The harness now measures the router, the cache, the traffic model and the
judge. The remaining softness is the competence oracle itself — `skill` and
`skillByCategory` are declared, and no round has asked how much the conclusions move
when they are wrong.

---

## Round 7 — 2026-09-22 — find out which findings survive being wrong about the fleet

**Measured.** The harness's largest remaining assumption. `skill` and
`skillByCategory` in `fleet.json` are hand-declared, every quality number rests on
them, and six rounds had quoted those numbers without once asking what happens if they
are wrong.

**Changed.** `--sweep oracle` jitters every model's skill by up to ±N points — which
also moves the derived `goldTier` labels, exactly as it should, since the gold label is
a function of the fleet — and re-runs all three classifiers across five jittered
fleets. Two tests: one pins the jitter itself (deterministic, bounded, and it moves
competence without touching prices), one pins the conclusion below.

**What the numbers did** (`swe-router-long-v1`, turn success, mean of 5 fleets):

| jitter | scripted | heuristic | oracle | heuristic beats oracle | oracle costs more |
| ---: | ---: | ---: | ---: | ---: | ---: |
| ±0 | 75.0% ±0.0 | 96.7% | 86.7% ±0.0 | **5/5** | **5/5** |
| ±5 | 77.7% ±13.3 | 94.7% | 88.3% ±12.5 | 3/5 | **5/5** |
| ±10 | 75.7% ±15.8 | 91.3% | 89.0% ±10.0 | 3/5 | **5/5** |
| ±20 | 74.7% ±25.8 | 86.0% | 89.0% ±15.8 | 2/5 | **5/5** |

**Round 4's headline splits cleanly in two, and only half of it survives.**

- **The cost half is robust.** *Routing perfectly spends more than never routing at
  all* holds **5/5 at every jitter level**, including ±20 points — a 40-point band on a
  100-point scale. It has to: that finding is cache economics, and the cache does not
  care how good the models are. Round 4's $34.26 of cold-start premium and its 34
  switches in 60 turns stand however wrong the oracle is.
- **The quality half does not.** *Never switching also wins on outcome* goes from
  **5/5** at ±0 to **2/5** at ±20. That finding is a property of this declared fleet,
  not of routing, and from now on it should be stated that way.

**And a caveat that applies to every quality number in this log.** The spread on
`scripted` turn success reaches **±25.8 points** at ±20 of jitter. Absolute quality
figures from this harness are worth roughly ±10–25 points depending on how much you
trust `fleet.json`; the *comparisons between profiles on one fleet* are much tighter,
which is what the results files are actually for.

**State of the harness after seven rounds.** It now measures the router's decisions,
the cache consequence, the traffic model, the judge's error, the judge's bias, and its
own competence assumption — and it reports which of its conclusions rest on which.
The single outstanding measurement is still one live command away:
`ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`, 36 Jev calls, no model
inference, under a cent.

---

## Round 8 — 2026-09-22 — does the confidence bar the code already has actually help?

**Measured.** `src/parallel.ts` does not adopt the judge's pick unconditionally — it
auto-adopts only when `entry.judge.confidence >= cfg.switching.minConfidence` (0.5 by
default). Every candidate number in rounds 1–7 reported the **raw pick** and silently
ignored that gate, so none of them described what a session would actually end up with.
And nobody had asked the obvious question: does the gate defend against the biased
judge round 3 identified as the thing that breaks fan-out?

**Changed.** The harness now applies the shipped bar and reports the raw pick and the
adopted outcome separately: `adoptedSuccessRate`, `adoptedLift`, `gatedTurns`,
`gateRescueRate`. `--judge-min-confidence` moves the bar, `--sweep gate` sweeps it, and
a test pins the harness default against the comparison in `src/parallel.ts`.

**What the numbers did** (`swe-router-long-v1`, n=3, noise 10, mean of 5 seeds):

| bias | minConf | raw pick | adopted | adopted lift | gated turns | rescued |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0.00 | 94.3% | 94.3% | **+19.3pp** | 0.0 | — |
| 0 | **0.50** | 94.3% | 91.3% | **+16.3pp** | 10.0 | 3.5% |
| 0 | 0.90 | 94.3% | 84.0% | +9.0pp | 36.4 | 1.6% |
| 40 | 0.00 | 66.7% | 66.7% | **−8.3pp** | 0.0 | — |
| 40 | **0.50** | 66.7% | 67.0% | **−8.0pp** | 0.2 | 20.0% |
| 40 | 0.90 | 66.7% | 68.3% | −6.7pp | 7.6 | 20.9% |

**The gate works exactly when it is not needed, and is blind exactly when it is.**
At the shipped 0.5 bar it costs **3.0pp** of lift when the judge is good, and recovers
**0.3pp** when the judge is badly biased. Raising it to 0.9 costs 10.3pp in the good
case to buy 1.6pp in the bad one.

The mechanism is visible directly in the judge's own confidence:

| injected bias | mean confidence | **mean confidence when wrong** | wrong turns |
| ---: | ---: | ---: | ---: |
| 0 | 0.829 | **0.332** | 2 |
| 20 | 0.608 | **0.722** | 12 |
| 40 | 0.956 | **0.940** | 18 |
| 60 | 0.998 | **0.998** | 18 |

An unbiased judge is *unsure* when it errs, which is what a confidence gate needs. A
biased judge is **confidently wrong** — bias pushes the flashy candidate to the top of
the distribution, so `choiceConfidence` goes *up* as accuracy goes down. At bias 40 the
0.5 bar gates 0.2 turns out of 60, because the judge is above it on essentially every
turn including the ones it gets wrong.

**Consequence for the candidate question.** Confidence gating is not a defence against
judge bias and should not be treated as one. The only two levers that did work in the
sweeps are widening the candidate set (round 3: n=4 returned +14.2pp at noise 40 where
n=3 returned +5.2pp) and having an unbiased judge in the first place — which is what
`--probe --live-judge` would establish, still for under a cent.

**Next.** The candidate set itself is inherited wholesale from
`src/parallel.ts#pickParallelModels` and has never been compared against an
alternative, even though round 3 noticed it never includes the strongest model at n=2
or n=3.

---

## Round 9 — 2026-09-22 — score the candidate set that was inherited without asking

**Measured.** Which models the fan-out actually asks. The harness has used
`src/parallel.ts#pickParallelModels` since round 1 — the routed model, then the first
entry of each tier from heavy down — and round 3 noticed in passing that it never
includes the strongest model at n=2 or n=3. Nothing had scored it against anything.

**Changed.** Four alternative candidate policies (`strongest`, `cheapest`, `spread`,
`tier-top`) alongside `shipped`, selectable with `--candidate-policy` and compared by
`--sweep policy`. Every policy may read only what the real router knows: tier lists,
`models[key].capability` and published prices. A test enforces that by jittering the
hidden `skill` numbers and requiring every policy to return an unchanged set — a policy
that peeked at the oracle would fail it. **None of this changes the shipped fan-out.**

**What the numbers did** (`swe-router-long-v1`, n=3, noise 10, mean of 5 seeds):

| policy | bias | ceiling | adopted | adopted lift | regress | fan-out $ | $/extra solve |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **`shipped`** | 0 | 96.7% | 91.3% | **+16.3pp** | 0.6 | $157.08 | **$13.65** |
| **`shipped`** | 20 | 96.7% | 72.3% | **−2.7pp** | 8.8 | $157.08 | $78.54 |
| `strongest` | 0 | 100% | 90.7% | +15.7pp | 0.0 | $259.25 | $18.31 |
| `strongest` | 20 | 100% | 100% | +25.0pp | 0.0 | $259.25 | $17.28 |
| `cheapest` | 0 | 48.3% | 51.7% | −23.3pp | 23.8 | $12.92 | — |
| `spread` | 0 | 100% | 97.7% | +22.7pp | 0.0 | $160.70 | $11.35 |
| **`tier-top`** | 0 | 96.7% | 96.7% | **+21.7pp** | 0.0 | **$61.95** | **$4.77** |
| **`tier-top`** | 20 | 96.7% | 96.7% | **+21.7pp** | 0.0 | **$61.95** | **$4.77** |

**The inherited policy is the worst of the sensible ones on every axis at once.**
`tier-top` — the model the *router itself* would prefer in each tier — delivers
**+21.7pp against `shipped`'s +16.3pp**, for **$61.95 of fan-out against $157.08**, at
**$4.77 per extra solve against $13.65**. It is simultaneously better, 2.5× cheaper,
and completely unmoved by a judge bias that takes `shipped` **negative**.

**And the reason connects two earlier rounds.** Printing the sets explains all of it:

| policy | set (skill, output $/Mtok) | flashiest vs strongest |
| --- | --- | --- |
| **`shipped`** | opus-5 (86, $25) · **astra (74, $50)** · flash (46, $0.5) | **opposed** |
| `strongest` | fable (91, $50) · opus-5 (86, $25) · astra (74, $50) | aligned |
| `spread` | opus-5 (86, $25) · fable (91, $50) · flash (46, $0.5) | aligned |
| `tier-top` | opus-5 (86, $25) · glm-5.3 (62, $2.64) · flash (46, $0.5) | aligned |

`shipped` is the **only** set whose flashiest member is not its strongest, and a test
now asserts that. Judge bias points at the most expensive-looking answer; in every
other set that answer is also the best one, so bias is harmless or even helpful. In the
shipped set it points at `gpt-6-astra` — pricier than Opus and 12 skill points weaker.

That is the **tier price inversion from round 2 propagating into the fan-out**: the
policy takes `tiers.standard[0]`, and in the shipped defaults the standard tier's
preferred model costs more per token than the heavy tier's. One configuration fact
explains both why over-routing is unpenalised (round 2) and why the fan-out is fragile
to a biased judge (round 9).

**Caveat, stated plainly.** `tier-top`'s immunity is immunity to *this* model of bias —
a judge that prefers the higher-priced-looking answer. If Jev's real bias runs on some
other axis (length, structure, hedging), the alignment argument does not automatically
transfer. What does transfer regardless of the bias axis: `tier-top` gets more lift for
40% of the spend, and that comparison does not depend on the bias model at all.

**Next.** Nine rounds in, the harness measures the router, the cache, the traffic
model, the judge's error, the judge's bias, the adoption gate, the candidate set and
its own competence assumption. The remaining gap is unchanged and is not something more
offline rounds can close: `ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`.

---

## Round 10 — 2026-09-22 — make it possible to fail

**Measured.** Nothing new about the router. This round measured the harness's own
usefulness and found the obvious hole: after nine rounds it could describe a change in
enormous detail and could not *fail* on one. The brief asked for results a next run can
be judged better or worse against; comparison deltas were printed, but nothing acted on
them, so a regression could land green.

**Changed.**

1. **`--gate`.** Exits `3` when a headline metric moved the wrong way past tolerance
   against the recorded baseline. The watched set is deliberately small —
   `ineligibleChoices` (no tolerance at all), `turnSuccessRate` and `tierAccuracy`
   (±2pp), `listEquivalentUsd` and `coldPremiumUsd` (±5%), `candidate.adoptedLift`
   (±2pp). It watches what a session **adopts**, not what the judge would have picked,
   which is the distinction round 8 had to introduce. Improvements never fail.
2. **`npm run eval:all`.** Validates both packs, runs all eight profiles, prints one
   table; `-- --gate` makes it a pre-merge check. Exit codes are now documented and
   distinct: `1` routing bug, `2` inconsistent ground truth or unauthorised live mode,
   `3` regression.
3. **A findings index** at the top of this log: every claim made in nine rounds, the
   round that established it, and what it rests on — including the two that are marked
   *not robust*.
4. **`AGENTS.md`**, carrying the four sharp edges a future session will otherwise
   rediscover the hard way.

**What the numbers did.** Unchanged by construction — no routing or scoring code moved.
The gate was verified against a deliberate regression rather than asserted: re-running
the same profile with `--calls-per-turn 20` trips it correctly.

```
--gate: 1 regression(s) against 2026-09-22T13-24-31-gatetest-f2830fc
  listEquivalentUsd: 11.4842 -> 28.8881 (+17.40, tolerance relative 0.05)
```

and `npm run eval:all -- --gate` exits `0` against the committed baselines. Six unit
tests cover the gate's behaviour directly: identical runs pass, 1pp and 3% moves are
noise, 5pp and 20% moves fail, improvements never fail however large, a single
ineligible route always fails, and the tolerance multiplier widens the band without
changing direction.

**Where this leaves the task.** Ten rounds: the harness measures the router's
decisions, its eligibility and quota handling, the cache consequence of every switch,
the traffic model those costs rest on, the judge's random error, the judge's systematic
bias, the adoption gate, the candidate set, and its own competence assumption — and it
now reports which conclusions survive each of those being wrong, and fails when one
regresses.

The one thing it cannot do offline is unchanged and is stated in the findings index:
`ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`.

---

## Round 11 — 2026-09-22 — audit the config that actually ships

**Measured.** Whether the tier findings are about the product or about my fixture.
Every claim about the tier ladder so far — including the price inversion that rounds 2
and 9 both traced consequences to — was measured on `eval/tasks/fleet.json`, whose
prices I typed in and whose competence I declared. That is fine for scoring routing
policy and worthless as a statement about the shipped router.

**Changed.** `--audit-config` takes `DEFAULT_CONFIG.tiers` exactly as it ships, prices
each entry from `docs/data/operational-stats.json` (published list prices, retrieved
2026-09-20) and ranks it by the AA Intelligence Index in `docs/data/benchmarks.json` —
the one benchmark in that set populated for all 17 models. **Nothing is simulated.**
Anything it cannot resolve is reported as unresolved rather than guessed, and a test
fails if `DEFAULT_CONFIG` ever names a model the catalogue does not price. Exit code
`4` when a ladder is broken. `--audit-local` audits this machine's merged config
instead, deliberately not the default because its answer differs per machine.

**What the numbers did** (`npm run eval -- --audit-config`, warm turn at 100k context):

| tier | router prefers | billing | warm turn (list) | marginal | AA Index |
| --- | --- | --- | ---: | ---: | ---: |
| light | `ds4/deepseek-v4-flash` | free | $0.0040 | $0.0000 | 34.33 |
| standard | `openai-codex/gpt-6-astra` | plan | **$0.6375** | $0.0000 | 52.67 |
| heavy | `claude-bridge/claude-fable-5-1` | plan | **$0.2625** | $0.0000 | 53.35 |

**The price inversion is real, and it is worse than an inversion.** The heavy tier's
preferred model costs **$0.2625 per warm turn against standard's $0.6375** — heavier is
**2.4× cheaper** — while scoring **53.35 against 52.67**. The capability ladder is
monotone; it is the price ladder that runs backwards.

Which means the shipped `standard` tier is **dominated**:

```
DOMINATED TIER  standard is dominated by heavy: claude-bridge/claude-fable-5-1 costs $0.2625
                per warm turn against openai-codex/gpt-6-astra's $0.6375 and scores 53.35
                against 52.67, so no request exists for which the lighter tier is the right choice
```

That is a stronger statement than any previous round could make. It is not "the fixture
has an inversion" — it is that, on published prices and a published benchmark, there is
no request for which routing to the shipped `standard` tier is the correct decision.
Every downstream consequence the earlier rounds measured — over-routing going
unpenalised (round 2), the fan-out's fragility to a biased judge (round 9) — now rests
on catalogue data rather than on my fixture.

**And `--audit-local` found the degenerate case the cache-cost study described.** On
this machine the merged config collapses all three tiers onto one model:

```
COLLAPSED TIERS  3 tiers resolve to 1 distinct model(s) (claude-bridge/claude-opus-5):
                 routing can only change the thinking level, which discards the prompt cache on its own
```

Round 4 measured what that costs (14 cold starts, all `thinking-change`, in a 60-turn
run) without being able to detect the configuration that causes it. Now one command
does, in under a second, on any machine.

**Next.** Eleven rounds. The harness measures the router's decisions and their cost, the
judge and its bias, the candidate set, its own assumptions, and now the shipped
configuration against published data. The single remaining gap is the same one and is
not closeable offline: `ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`.

---

## Round 12 — 2026-09-22 — is the classifier's confidence worth anything?

**Measured.** `src/router.ts` keeps the current model whenever confidence falls below
`switching.minConfidence`. That bar only makes sense if confidence predicts
correctness, and eleven rounds had used confidence — in the fixture, in the judge, in
the auto-adopt gate — without once checking whether it carries signal. This is the
routing-side twin of round 6's judge probe: the probe asks whether the judge's *pick*
is trustworthy; this asks whether the classifier's *certainty* is.

**Changed.** `--calibration` reports the classifier's reliability curve (stated
confidence vs observed accuracy per bucket, plus expected calibration error,
over/under-confidence, and discrimination). `--sweep confidence` sweeps the bar itself.
Both run on whatever classifier produced the run, so `--classifier live --calibration`
gives Jev's own curve on the same terms.

**A measurement bug this round found and fixed.** The sweep produced a flat
`tierAccuracy` at every bar setting, which cannot be right. The cause was mine:
`src/router.ts` returns the *requested* tier in its `Decision` even when low confidence
makes it keep the current model, and I had been reporting that as "tier accuracy" since
round 1. So the headline quality metric was measuring **what the classifier asked for**,
not **where the router landed**. Now split:

- `classifierAccuracy` — requested tier vs gold. Measures the classifier.
- `tierAccuracy` — the tier containing the model actually selected. Measures the router,
  decides the outcome, and is what the gate watches.

The fix immediately paid for itself: with a **perfect** classifier
(`classifierAccuracy` 1.000) the router still lands wrong once —
`pydata__xarray-4094` turn 3 is heavy work served by a light model, because
`manualPinTurns: 3` holds a `/model` pin the operator set two turns earlier for a
one-line question. Under the old metric that was invisible.

**What the numbers did.** Calibration of the scripted classifier
(`swe-router-long-v1`; these confidences are hand-written, so this measures the
fixture — the number that matters is the same command against live Jev):

| confidence | turns | stated | observed | gap |
| --- | ---: | ---: | ---: | ---: |
| 0.00–0.50 | 1 | 47.0% | 100% | −53.0pp |
| **0.50–0.60** | 7 | 57.1% | **14.3%** | **+42.9pp** |
| 0.60–0.70 | 11 | 64.9% | 81.8% | −16.9pp |
| 0.70–0.80 | 21 | 74.0% | 100% | −26.0pp |
| 0.80–0.90 | 14 | 83.9% | 100% | −16.1pp |
| 0.90–1.00 | 6 | 90.3% | 100% | −9.7pp |

Discrimination **+42.1pp** — confidence does separate right from wrong here — but the
error is concentrated in the 0.50–0.60 band, which is **exactly where the shipped bar
sits** and the only band where the classifier is badly *over*confident.

The bar sweep:

| bar | landed | classifier | turn ok | switches | list $ | cold prem | suppressed (correct) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.00 | 86.7% | 86.7% | 75.0% | 34 | $69.27 | $34.26 | 0 (0) |
| **0.50 (shipped)** | 86.7% | 86.7% | 75.0% | 34 | $69.27 | $34.26 | **1 (1)** |
| **0.60** | **88.3%** | 86.7% | 75.0% | **31** | **$62.98** | **$30.09** | 8 (2) |
| 0.70 | 76.7% | 86.7% | 65.0% | 22 | $49.73 | $22.42 | 19 (11) |
| **0.80** | 43.3% | 86.7% | **36.7%** | 7 | $11.65 | $4.21 | 40 (32) |
| 0.90 | 40.0% | 86.7% | 75.0% | 5 | $44.06 | $22.32 | 54 (46) |
| 1.01 (never route) | 33.3% | 86.7% | **96.7%** | 0 | $70.06 | $37.45 | 60 (52) |

**Three findings.**

1. **The shipped bar is nearly inert.** At 0.50 exactly **one turn in 60** falls below
   it, and that turn was classified *correctly*. The knob is doing nothing except, very
   occasionally, discarding a right answer.
2. **0.60 is free money in this pack** — the only row that improves landing accuracy
   (88.3%), and it does so while removing 3 switches and **$6.29** of spend at no cost
   to outcome. It suppresses 8 turns of which only 2 were correct, which is the bar
   working as intended.
3. **The bar is a stickiness mechanism, not a safety one.** It does not make the router
   more careful; it makes it commit harder to whatever it last decided. At 0.80 the
   session spends **51 of 60 turns on the weakest model in the fleet** — one confident
   `light` classification routes it there and nothing afterwards clears the bar to route
   it back — and turn success collapses to **36.7%**, *worse than both a lower bar and
   never routing at all*. Outcome is non-monotone in the bar, which is the signature of
   a ratchet rather than a guard.

**Housekeeping.** Per-run result files are no longer committed (`eval/results/.gitignore`);
the `latest-<profile>.json` baselines, the sweep/audit/calibration snapshots and this log
are. The directory was 3.6 MB of history that the log already tells better.

**Next.** Unchanged, and now with a second reason to want it: the calibration curve
above is of *my handwriting*. `ROUTER_EVAL_LIVE=1 npm run eval -- --classifier live --calibration`
measures Jev's, and `--probe --live-judge` measures the judge's. Neither is closeable offline.

---

## Round 13 — 2026-09-22 — fan out to *learn*, not to *pay*

**Measured.** "2+ responses every turn and the judge picks" is the expensive reading of
the captain's idea, and rounds 3–9 priced it: **$14–16 per extra solve** at realistic
context. There is a cheaper reading nobody had tried. Fan out for the **first few turns
of a session**, see which model the judge keeps choosing, then **commit** to it and stop
paying. Fan-out as exploration rather than as a per-turn tax.

**Changed.** `--explore-turns N` and `--sweep strategy`, scoring `route` (no fan-out),
`fanout-always`, and `explore-N` on the same pack. Harness-side only: it measures the
idea and changes nothing about the shipped router or the shipped fan-out. Also split
`turnSuccessRate` (the routed model alone) from **`sessionSuccessRate`** (what the
session actually ends up with after adoption) — the strategy comparison is meaningless
without that distinction, and the old single number quietly reported `fanout-always` as
no better than `route`.

**Two bugs this round found, both mine.**

1. **A pinned turn was being charged a cache flush it cannot cause.** `src/index.ts`
   returns from `before_agent_start` on a pinned turn *before* it reaches
   `pi.setThinkingLevel`, so a pinned turn cannot change the thinking level. The harness
   was applying `cfg.thinking[tier]` anyway, inventing up to 7 `thinking-change` cold
   starts per committed session. Fixed, and pinned against the early return by test.
   This is why the explore rows below are cheaper than they first appeared.
2. **The gate promoted regressions to the baseline.** `--gate` wrote
   `latest-<profile>.json` before comparing, so a regression fired once and then became
   the thing the next run was judged against. Now a regressed run is recorded for
   inspection and the known-good baseline is left untouched. Verified end to end:
   exit 3, baseline `$11.4794` before and after.

**What the numbers did** (`swe-router-long-v1`, n=3, mean of 5 seeds; negative
`$/extra solve` means the strategy is **cheaper *and* better** than not fanning out):

| strategy | bias | session ok | fan-out turns | total $ | $/extra solve |
| --- | ---: | ---: | ---: | ---: | ---: |
| `route` | 0 | 75.0% | 0 | $69.27 | — |
| `fanout-always` | 0 | 91.3% | 60 | $226.35 | **$16.03** |
| `explore-1` | 0 | 89.7% | 6 | **$49.91** | **−$2.20** |
| `explore-2` | 0 | 88.0% | 12 | $58.56 | −$1.37 |
| **`explore-3`** | 0 | **96.3%** | 18 | $79.67 | **$0.81** |
| `explore-5` | 0 | 96.3% | 30 | $117.07 | $3.73 |
| `route` | 20 | 75.0% | 0 | $69.27 | — |
| `fanout-always` | 20 | 72.3% | 60 | $226.35 | — |
| `explore-1` | 20 | 63.3% | 6 | $62.26 | — |
| `explore-2` | 20 | **50.0%** | 12 | $54.99 | — |
| `explore-3` | 20 | 61.0% | 18 | $88.46 | — |

**When the judge is good, exploration is the right shape of the idea by a wide margin.**
`explore-3` reaches **96.3%** against `fanout-always`'s 91.3% — *better* — for **$79.67
against $226.35**, which is **$0.81 per extra solve against $16.03**: roughly **20×**
more cost-effective. Two reasons compound: you pay for 18 fan-outs instead of 60, and
committing stops the router switching, which removes 34 model switches and their cold
starts. `explore-1` and `explore-2` are literally **cheaper than not fanning out at
all** while scoring 13–15pp higher, because the switching they prevent costs more than
the exploration they add.

**When the judge is biased, exploration is the worst shape of the idea.** At 20 points
every depth lands **below** the 75.0% baseline, bottoming at **50.0%**. Fanning out
every turn is bad (72.3%); committing to a biased verdict is worse, because one wrong
judgement stops being a per-turn tax and becomes a decision that governs the rest of
the session. Depth does not rescue it — `explore-5` only recovers to 73.3%, still below
doing nothing.

**So the candidate question now has a shape, not just a number.** The idea is worth
roughly **+21pp for under a dollar a solve** if Jev judges cleanly, and it is
**actively harmful, more so the more you commit to it**, if Jev carries ~20 points of
presentation bias. The gap between those two worlds is larger than any other lever
measured in thirteen rounds, and the measurement that decides which one we are in
remains one command and under a cent.

**Next.** `ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`.

---

## Round 14 — 2026-09-22 — what the router does for someone with no subscription

**Measured.** Whether any of this holds for a user without a plan. Nearly every finding
in thirteen rounds leans on plan routes pricing at **$0** at the margin: `planHiddenUsd`
being 98% of spend, escalation being unpenalised, "never switch" being free. All of that
is a statement about *one billing arrangement*, and the harness had only ever been run
in it.

**Changed.** `--billing all-on-demand | all-plan | as-configured` rewrites the fleet's
billing before building it — **prices, skills and tiers untouched**, so it isolates the
one variable exactly. Generated from `fleet.json` rather than a second fixture, so it
cannot drift. A test asserts rebilling changes nothing but `billing` and `oauth`.

**What the numbers did** (`swe-router-long-v1`, session success):

| classifier | billing | session ok | tier acc | switches | **ledger $** | list $ |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| scripted | as shipped | 75.0% | 86.7% | 34 | $1.23 | $69.27 |
| scripted | **on-demand** | **58.3%** | 86.7% | 34 | **$24.82** | $24.82 |
| oracle | as shipped | 86.7% | 100% | 34 | $1.21 | $62.45 |
| oracle | **on-demand** | **68.3%** | 100% | 34 | **$28.69** | $28.69 |
| heuristic (never switches) | as shipped | 96.7% | 33.3% | 0 | $0.00 | $50.05 |
| heuristic (never switches) | **on-demand** | 96.7% | 33.3% | 0 | **$50.05** | $50.05 |

**The router's quality depends on the user's billing arrangement, not on the work.**
With a *perfect* classifier and an unchanged config, session success falls **86.7% →
68.3%** purely because the models stopped being free. Tier accuracy is identical at
100% in both — the router lands in exactly the same tiers. The entire difference is
which model it picks *inside* the standard tier:

| standard tier | on a plan | on-demand |
| --- | --- | --- |
| preferred | `gpt-6-astra` (skill 74) | `glm-5.3` (skill 62) |

Cheapest-in-tier picks the strong model when a subscription makes it free, and the weak
one when it doesn't. Round 2 called this "the strongest model is never chosen"; round 14
shows the sharper version — **the router silently downgrades the work when the user
stops having a subscription**, with no signal that anything changed.

**And the "never switch is better" finding flips sides.** On a plan, not switching is
both best (96.7%) and free ($0 to the ledger) — rounds 4 and 7's result. Off a plan it
is still best *and now the most expensive thing you can do*: **$50.05 against the
router's $24.82**, i.e. the router buys a real **50% cost reduction** for 38pp of
quality. That is a genuine trade a user might want, and on the shipped plan
configuration it is invisible because both columns read $0.

**A quieter confirmation.** With `all-on-demand`, `planHiddenUsd` is exactly **$0** and
`ledgerCostUsd == listEquivalentUsd`. The ledger is accurate — for users who have no
subscription. For everyone else it under-reports by ~50×, which is what rounds 1–13 have
been saying with a fixture and can now say with the variable isolated.

**Next.** Unchanged: `ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`.

---

## Round 15 — 2026-09-22 — the operator, and the asterisk on every scripted number

**Measured.** Two things the harness had been quietly assuming away.

1. **The operator.** `switching.manualPinTurns: 3` means a `/model` pin governs three
   turns. Round 12 caught one pin, set for a one-line question, still deciding a heavy
   turn two turns later — and then found the long pack contained **no pins at all**. A
   shipped behaviour with essentially no coverage.
2. **The asterisk.** Every `scripted` number in fourteen rounds came from classifier
   answers *I wrote by hand*. Round 12's calibration curve is, strictly, a curve of my
   handwriting.

**Changed.**

- **`--record`** runs the pack against live Jev and writes what it actually said back
  into `turns[].jev`. The merge is deliberately narrow — it rewrites the classifier
  answers and nothing else, so `requiredSkill`, prompts and pins survive untouched, a
  recorded pack still has to pass `--validate`, pinned turns are skipped (the classifier
  was never consulted), and a fixture that models an outage keeps modelling one. Tested
  offline against a stubbed live run; recording a pack's own answers back is a no-op.
- **Four `manualPin`s in the long pack**, in the pattern round 12 found: the operator
  pins a cheap model for a trivial follow-up ("show me the diff"), and the pin is still
  in force when the next hard turn arrives. One is harmless by construction, as a control.
- **`--sweep pin`** over `manualPinTurns`.

**What the pin sweep says** (`swe-router-long-v1`, 60 turns):

| pin turns | pinned | **wrong tier while pinned** | tier acc | session ok | switches | list $ |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 0 | 86.7% | 75.0% | 34 | $69.27 |
| 1 | 4 | 1 | 85.0% | 75.0% | 35 | $69.41 |
| **3 (shipped)** | 12 | **7** | 76.7% | **65.0%** | 30 | $57.40 |
| 5 | 19 | 9 | 76.7% | 61.7% | 26 | $46.10 |
| 10 | 25 | 14 | 70.0% | 58.3% | 21 | $39.98 |

The shipped three-turn pin is **not a free convenience**. It holds 12 of 60 turns, and
**7 of those 12 run in the wrong tier for the work** — served by a model the operator
chose for a different question. It costs **10pp of tier accuracy and 10pp of session
success** and buys back $11.87 and four switches. A one-turn pin — respect the
operator's choice for the turn they made it on — costs essentially nothing (1 wrong
turn, no quality loss, +$0.14).

**And adding the operator reversed a headline.** Round 4 reported that never switching
beats perfect routing on *quality* as well as cost; round 7 swept the fleet and warned
that the quality half was **not robust** while the cost half was. Round 15 is that
warning coming true from a different direction — not fleet jitter, but a more realistic
pack:

| | short pack | long pack, **before** pins | long pack, **with** pins |
| --- | ---: | ---: | ---: |
| `heuristic` beats `oracle` on quality | 5/5 | 5/5 | **0/5** |
| `oracle` costs more than `heuristic` | 5/5 | 5/5 | **5/5** |

Pins fall on whichever profile is running, and they hurt the never-switching profile
more than the routing one, because a router can climb back out of a bad pin and a fixed
model has nowhere to climb to. **The cost finding is unmoved at every jitter level, as
it has been in every round that has tested it.** The quality finding has now flipped
twice and should be treated as a property of a fixture, which is what round 7 said and
what the index has recorded since.

Round 9's candidate-policy result is unchanged in substance and stronger in relative
terms: `tier-top` now returns **+31.7pp at $3.26 per extra solve** against `shipped`'s
+24.3pp at $8.97, and is still completely unmoved by a 20-point judge bias that costs
the shipped set most of its lift (+24.3pp → +5.3pp, regressions 0.4 → 6.4).

**Five tests changed with the fixture, and the change is the point.** Each had been
keyed to a magnitude from the old pack. They now assert the *mechanism* — a fan-out
candidate's bill scales with context because it pays uncached input; a biased judge
costs the shipped candidate set its lift because its flashiest member is not its
strongest; with routing switched off every remaining switch must be an operator pin.
Mechanisms survive a better fixture; magnitudes do not, and a test that pins a magnitude
is a test that will be quietly loosened later.

**Next.** `ROUTER_EVAL_LIVE=1 npm run eval -- --classifier live --record` now removes the
asterisk on every scripted number, and `--probe --live-judge` still decides the
candidate question. Both are under a cent and neither is closeable offline.

---

## Round 16 — 2026-09-22 — the thing the cache-cost study said it had not modelled

**Measured.** Compaction. The cache-cost study listed it under *uncertainties*: "pi
compacts long contexts; a compaction rewrites the middle of the prompt and invalidates
everything after it regardless of switching… the router does not use
`cache_anchor_items`." Round 4 then built a pack whose context climbs to **256k and
never compacts** — which is not what pi does, and it is precisely the regime round 4
declared the important one.

**Changed.** The harness now models compaction using **pi's own trigger**:
`shouldCompact` and `DEFAULT_COMPACTION_SETTINGS` are imported from
`@earendil-works/pi-coding-agent`, so the threshold is the product's
(`contextTokens > contextWindow − 16384`) and the post-compaction size is the product's
(`keepRecentTokens` 20000, plus a 2000-token summary). A compaction charges the
summarisation call, drops the context, and forces a cold turn — because rewriting the
middle of the prompt is a cache flush whatever the model did.

**The key property is that it depends on which model the router chose.** The trigger is
a function of the *model's context window*, so the same conversation compacts or does
not depending on the routing decision. `avoidableCompactions` counts the ones the
fleet's roomiest authed model would not have needed.

**What the numbers did.**

First, a **correction to round 4**. Modelling compaction *lowers* the long pack's costs,
because real sessions do not carry 256k of context indefinitely:

| | round 4 (no compaction) | round 16 |
| --- | ---: | ---: |
| `long / scripted` list $ | $69.27 | **$49.77** |
| cold premium | $34.26 | **$24.94** |
| share of spend | 49% | **50.2%** |

The absolute figure was inflated by about 40%; **the share was not**, which is the
number round 5 said to quote anyway. Switching still costs roughly half of what a long
session spends.

Second, the finding. **Every compaction in the pack was avoidable by routing**, and
three of the four were caused by the *operator*:

| task | turn | model | context | pinned? |
| --- | ---: | --- | ---: | :---: |
| `django__django-16379-session` | 7 | `glm-5.3-flash` (200k) | 184,000 | **yes** |
| `pytest-dev__pytest-11143-session` | 7 | `glm-5.3-flash` (200k) | 210,000 | **yes** |
| `psf__requests-1142-session` | 6 | `glm-5.3-flash` (200k) | 200,000 | **yes** |
| `sphinx-doc__sphinx-8721-session` | 10 | `glm-5.3-flash` (200k) | 189,000 | no |

A `/model` pin to a cheap model, set for "show me the diff", puts a 200k conversation
onto a 200k-window model — and pi compacts it down to **22k**. The operator asked for a
cheap answer to a trivial question and paid for it with **the session's memory**. Round
15 measured what a pin costs in tier accuracy; this is the part that does not show up in
a tier at all.

**A limitation, stated rather than hidden.** The harness charges a compaction's *money*
and models its *cache* effect. It does **not** model its quality cost — losing detail
from the conversation — because the competence oracle scores a turn on the model's skill
and the turn's difficulty, with no notion of what the model can still remember. So the
numbers above are a **lower bound** on what an avoidable compaction costs. Making that
real would need the oracle to depend on context, which is a larger change than this
round.

**Next.** Unchanged, twice over: `--classifier live --record` and `--probe --live-judge`.

---

## Round 17 — 2026-09-22 — what forgetting costs

**Measured.** The limitation round 16 wrote down rather than hid: the harness charged a
compaction's money and modelled its cache effect, but the competence oracle had no
notion of what a model can still *remember*, so a turn was exactly as easy after the
conversation had been summarised away as before. Round 16's figures were therefore a
stated lower bound.

**Changed.** The oracle is now context-aware. A task declares `contextSensitivity`
(0..1, default 0.5) — how much its turns lean on remembering earlier ones — and a turn's
required skill rises while the session has not yet rebuilt what a compaction discarded:

```
requiredSkill += COMPACTION_SKILL_PENALTY × contextSensitivity × lostFraction
```

`lostFraction` is 1 immediately after the cut and decays to 0 as the context comes back.
`goldTier` deliberately keeps using the **declared** difficulty: a compaction does not
make the task harder, it makes the router's job harder, so it shows up as a *failure*
rather than as a moved label. New metric `turnsLostToCompaction`, and
`--compaction-penalty` sweeps the new constant.

**What the numbers did.**

| penalty | session ok | turns lost | compactions | list $ |
| ---: | ---: | ---: | ---: | ---: |
| 0 (round 16's model) | 65.0% | 0 | 4 (4 avoidable) | $49.77 |
| 6 | 58.3% | 4 | 4 | $49.77 |
| **12 (default)** | **56.7%** | **5** | 4 | $49.77 |
| 24 | 56.7% | 4 | 4 | $49.77 |
| 40 | 55.0% | 6 | 4 | $49.77 |

**Four avoidable compactions cost five turns, or 8.3pp of session success**, on top of
their money and their cache flush. And the conclusion does not hinge on the new
constant: between 6 and 40 points the answer moves by 3.3pp, because a turn either
needed the discarded detail or it did not. Money and cache are untouched by the penalty,
as they must be. A test holds both properties.

**An interaction worth naming.** Round 13's exploration strategy now has a *second*
reason to work: committing to one model stops the router routing into a small-context
model, so it prevents avoidable compactions as well as switches. That shifts round 13's
bias story:

| | clean judge | 20-pt biased judge |
| --- | ---: | ---: |
| `route` | 56.7% | 56.7% |
| `explore-3` | **96.3%** | 58.7% |
| `fanout-always` | 81.3% | 68.3% |

Exploration is worth **+39.6pp** with a clean judge and **+2.0pp** with a biased one —
bias still destroys **95% of its advantage**, which is the durable claim, but it no
longer reliably drops *below* the baseline, because compaction-avoidance offsets some of
the damage. Round 13's test was keyed to the stronger version of that claim and now
asserts the durable one.

**Still declared, and now swept.** `contextSensitivity` and `COMPACTION_SKILL_PENALTY`
join `skill` on the list of things this harness asserts rather than measures. Both are
in fixtures or on the command line, both are swept, and the findings index says what
each conclusion rests on. That is the whole bargain of an offline eval: declare the
assumptions, sweep them, and report which answers survive.

**Next.** `--classifier live --record` and `--probe --live-judge`.

---

## Round 18 — 2026-09-22 — make the numbers traceable

**Measured.** Nothing new about the router. This round measured how hard the harness is
to *check*. Seventeen rounds in it reports upwards of thirty metrics across two packs,
nine sweeps, a probe, a calibration report and a config audit — and offered no way to
see why any single one came out as it did.

That is not a cosmetic gap. Rounds 1, 6, 12, 13 and 15 all found defects in the
**measurement** rather than the router, and every one of them was found by dropping into
a throwaway script to print a few turns. A tool whose own bugs are only findable by
writing another tool is not finished.

**Changed.** `--explain <task id>` prints the turn-by-turn trace behind one task's
score: what the classifier said and whether the stakes override moved it, which tier the
router landed in versus the gold one, which model served the turn and what it switched
from, skill against required skill with any lost-context penalty broken out, whether
another model in the same tier would have solved it, the cache outcome and its cause,
any compaction and whether a roomier model would have avoided it, the cost at list and
to the ledger, and — in candidate mode — every candidate with the judge's probabilities,
what it picked, whether the gate blocked it, and what the best available answer was.

It renders what the run **recorded** rather than re-simulating, so what it shows is what
was scored. Two tests hold that: every cost in the trace must match the record to four
decimal places, and an unknown task id must list the ones that do exist.

**What it looks like** — three turns of `django__django-16379-session`, which explain
between them most of what sixteen rounds have been arguing about:

```
  turn 2  FAILED
    classifier    jev said light @ 76%
    tier          landed light (matches gold); router reported light
    model         faux-or/glm-5.3-flash
    competence    skill 30 vs required 34 → -4.0
                  another model in this tier would have solved it
    cache         warm; thinking low
    cost          $0.0307 at list ($0.0307 if warm), $0.0307 to the ledger

  turn 3  SOLVED
    classifier    jev said heavy @ 71%
    model         faux-plan-anthropic/claude-opus-5  (switched from faux-or/glm-5.3-flash)
    cache         cold (model-switch), rewrote 128,000 tokens; thinking high
    cost          $1.1442 at list ($0.4123 if warm), $0.0000 to the ledger
```

Turn 2 is round 2's `inTierMisses` in one line: the classification was right, the tier
was right, and the router picked the cheapest member of that tier, which was four skill
points short. Turn 3 is rounds 4 and 14 together: a correct escalation that cost
**$1.1442 against $0.4123 warm** — and billed the ledger **$0.00**.

**Next.** `--classifier live --record` and `--probe --live-judge`.

---

## Round 19 — 2026-09-23 — the confound underneath the biggest finding

**Measured.** Where the session starts. `--start-model` has existed since round 1 and
has never been anything but its default, `faux-plan-anthropic/claude-opus-5` — chosen
because the cache-cost study found this machine sitting on Opus. Every comparison
involving the never-switching profile has therefore been run with that profile parked on
**the strongest plan model in the fleet**, which flatters it enormously and which nobody
had questioned for eighteen rounds.

**Changed.** `--sweep start` runs every fleet model as the session's starting point,
across all three classifiers.

**What the numbers did** (`swe-router-long-v1`, session success):

| start model | skill | `oracle` (routes) | `scripted` (routes) | `heuristic` (never switches) |
| --- | ---: | ---: | ---: | ---: |
| `glm-5.3-flash` | 46 | 65.0% | 56.7% | **20.0%** |
| `deepseek-v4.1-flash` | 49 | 70.0% | 60.0% | 21.7% |
| `glm-5.3` | 62 | 65.0% | 56.7% | 35.0% |
| `gpt-6-astra` | 74 | 65.0% | 56.7% | 46.7% |
| `claude-opus-5` (the default every round used) | 86 | 65.0% | 56.7% | **61.7%** |
| `claude-fable-5-1` | 91 | 65.0% | 56.7% | **65.0%** |
| **mean** | | **65.8%** | 57.2% | **41.7%** |
| **spread** | | **5.0pp** | **3.3pp** | **45.0pp** |

**The "never switching also wins on quality" finding is withdrawn.** It was an artefact
of the starting model. Not switching cannot correct anything, so it simply inherits
whatever the session began on: 20.0% from the weakest model, 65.0% from the strongest,
and it only ties routing at the very top of the fleet — which is where every previous
round happened to put it. Averaged over starting points, routing wins **65.8% to 41.7%**.

**And the inverse is the actual case for the router.** `oracle` varies by **5.0pp**
across six starting models and `scripted` by **3.3pp**, against never-switching's
**45.0pp**. That is precisely what a router is for, and it is the first unambiguously
*positive* finding about the shipped switcher in nineteen rounds: **its value is that the
outcome stops depending on where you happened to be.**

The cost picture flips with it. Never-switching's spend ranges from **$2.67** (parked on
a flash model, achieving 21.7%) to **$55.54** (parked on Astra, achieving 46.7%);
routing costs $46.49–$49.77 for 56.7–60.0% wherever it starts. The cheap end of that
range is not a saving, it is a different product.

**What this says about the earlier rounds.** Round 4 reported never-switching beating
perfect routing; round 7 swept the fleet and flagged the quality half as not robust;
round 15 saw it reverse under operator pins; round 19 finds the confound that produced it
in the first place. The **cost** half — that switching is expensive and that the router
spends more than not moving does — has now survived fleet jitter, the traffic constants,
compaction, operator pins, billing mode, and the starting model. It is the load-bearing
result. The quality half never was one, and the findings index now says so with a
strikethrough rather than a caveat.

**Next.** `--classifier live --record` and `--probe --live-judge`.

---

## Round 20 — 2026-09-23 — audit every assumption, not just the one that bit

**Measured.** Round 19 withdrew a headline finding because a default nobody had swept —
the model the session starts on — turned out to be producing it. That was luck: I went
looking for it. This round is the systematic version. Vary **every** declared constant
in the harness, one at a time, and report how far each headline metric travels.

**Changed.** `--sweep assumptions` varies twelve assumptions — starting model, fleet
skill jitter, billing arrangement, judge error, judge bias, judge temperature, calls per
turn, compaction penalty, context sensitivity, the routing confidence bar, `/model` pin
length, and the judge confidence gate — and ranks them by how far each moves session
success. It runs in about 1.5 seconds. `--candidates 0` gives the routing-only picture;
the default gives the picture with fan-out on. Also added `--context-sensitivity` so the
last unswept declared constant has a lever.

**What the numbers did.** Two pictures, and the contrast is the result.

**Routing only** — the answer rests on the router's own configuration:

| assumption | session ok | list $ | tier acc |
| --- | ---: | ---: | ---: |
| **routing confidence bar** | 31.7%–56.7% (**±25.0pp**) | $12–$50 | ±28.3pp |
| fleet skill (±20) | 56.7%–73.3% (±16.6pp) | $50 | ±10.0pp |
| billing arrangement | 43.3%–58.3% (±15.0pp) | $17–$50 | ±0.0pp |
| `/model` pin length | 53.3%–65.0% (±11.7pp) | $39–$54 | ±16.7pp |
| starting model | 56.7%–60.0% (±3.3pp) | $46–$50 | ±0.0pp |
| every judge assumption | **0.0pp** | $50 | ±0.0pp |
| calls per turn | **0.0pp** | **$38–$112** | ±0.0pp |

**With fan-out on** — the judge takes over:

| assumption | session ok |
| --- | ---: |
| **judge bias** | 58.3%–85.0% (**±26.7pp**) |
| routing confidence bar | 61.7%–88.3% (±26.7pp) |
| judge error (noise) | 73.3%–88.3% (±15.0pp) |
| judge confidence gate | 73.3%–88.3% (±15.0pp) |
| judge temperature | 75.0%–86.7% (±11.7pp) |
| **starting model** | 85.0%–86.7% (**±1.7pp**) |
| **fleet skill (±20)** | 85.0%–86.7% (**±1.7pp**) |

**Three things fall out.**

1. **Fan-out transfers the answer's dependency from the router to the judge.** Judge
   bias goes from moving *nothing* (0.0pp) to being the single loudest assumption
   (±26.7pp), while the starting model falls from ±3.3pp to ±1.7pp and fleet skill from
   ±16.6pp to ±1.7pp. Running several candidates absorbs a bad starting point and a
   wrong guess about who is good at what — and replaces both with a bet on the judge.
   That is the sharpest possible argument for why `--probe --live-judge` is the
   outstanding measurement: it is not one input among twelve, it is *the* input.
2. **Cost and quality assumptions are cleanly separated, and the harness proves it.**
   `calls per turn` moves the bill by **$38–$112** and the cold-start share by
   **±43.8pp** while moving session success by exactly **0.0pp**. A test holds that.
3. **The routing confidence bar is the loudest router-side assumption in both pictures**
   (±25.0pp and ±26.7pp) — louder than the fleet's declared competence. Round 12 found
   the shipped 0.50 setting nearly inert and a higher one actively harmful; round 20
   says that knob deserves more care than anything else the router exposes.

**What this round is really for.** Nineteen rounds produced a lot of numbers. This is
the page that says which of them a reader has to qualify. Everything above the fold in
those tables must be quoted with the assumption that produced it; everything below it
survives being wrong.

**Next.** `--classifier live --record` and `--probe --live-judge`, and after round 20 the
second one is not one loose end among many — it is the loose end.

---

## Round 21 — 2026-09-23 — how much is one of these numbers worth?

**Measured.** The obvious objection to twenty rounds of findings: the long pack is six
tasks and the short one fifteen, and every round has quoted rates to one decimal place
off that. This round answers the objection instead of deflecting it.

**Changed.** `--bootstrap <n>` resamples the pack's **tasks** with replacement and
reports 95% intervals on the headline metrics. Tasks are the sampling unit because turns
within a session are not independent — a session that goes wrong early goes on being
wrong, which is exactly the correlation a turn-level bootstrap would hide. `--sweep
paired` does the thing the findings actually need: every claim in this log is "A beats B
**on the same tasks**", which is a *paired* comparison, so resampling tasks and taking
A − B within each resample cancels the shared task-difficulty variance. Both resample
what a run recorded, so neither costs extra runs.

**What a single number is worth** (`swe-router-long-v1`, 2000 resamples of 6 tasks):

| metric | point | 95% interval | ± |
| --- | ---: | ---: | ---: |
| session success | 56.7% | 25.0% – 88.9% | **±31.9pp** |
| tier accuracy | 76.7% | 70.0% – 87.5% | ±8.8pp |
| cold premium share | 50.2% | 29.0% – 62.8% | ±16.9pp |
| list cost | $49.77 | $38.40 – $58.53 | ±$10.07 |

**And what a comparison is worth** — the number that matters, because nothing here is
quoted alone:

| comparison | session success | list cost |
| --- | --- | --- |
| routing (oracle) − never switching | +3.3pp [−10.0, +27.3] **ns** | **+$18.91 [+$1.98, +$44.36]** |
| **fan-out every turn − no fan-out** | **+28.3pp [+11.1, +50.0]** ✓ | **+$123.21 [+$110.83, +$138.87]** |
| `tier-top` set − the shipped one | +3.3pp [0.0, +9.1] **ns** | **−$74.76 [−$84.76, −$67.15]** |
| `explore-3` − fan out every turn | −3.3pp [−33.3, +10.0] **ns** | **−$98.11 [−$131.08, −$64.31]** |
| fan-out with a 40-pt biased judge − none | +8.3pp [−11.1, +25.0] **ns** | **+$123.21 [+$110.83, +$138.87]** |

**5 of 5 cost differences resolve. 1 of 5 quality differences does.**

That single sentence is the most useful thing twenty-one rounds produced, and it
retrospectively explains the whole log. Every finding that survived every sweep was a
cost finding. Every one that wobbled, flipped, or had to be withdrawn — rounds 4, 7, 15,
19 — was a quality finding. There is now a statistical reason for that pattern rather
than a narrative one: **on a pack this size the harness can resolve money and cannot
resolve quality.**

**The one quality claim that does resolve is the captain's own idea.** Running several
candidates and adopting the judge's pick beats not doing it by **+28.3pp, interval
[+11.1, +50.0]**, and it costs **+$123.21** to do. Both halves resolve. That is the
finding to act on; it is also the finding whose value collapses if Jev carries
presentation bias, which round 20 showed is the single loudest assumption once fan-out
is on, and which `--probe --live-judge` would settle.

**How much bigger would the pack have to be?** A 95% half-width shrinks as 1/√n, so
resolving a **5pp** quality difference needs about **113 tasks** of this shape, and
**2pp** needs about **705**. SWE-bench Verified is 500 instances. That is not a
coincidence — it is roughly what it takes to tell two coding agents apart, and this
harness now says so out loud instead of implying precision it does not have.

**What changed in the index.** Quality claims are marked *under-powered* where the pack
cannot resolve them. They are still worth having — they are directional, they agree
across sweeps, and they were arrived at honestly — but they are now labelled as what
they are.

**Next.** `--probe --live-judge`, which round 20 identified as *the* input and round 21
prices the consequence of: the one resolvable quality win in this log is a bet on the
judge, and nobody has measured the judge.

---

## Round 22 — 2026-09-23 — grow the pack, and watch a headline shrink

**Measured.** The constraint the harness identified about itself. Round 21 showed the
long pack could not resolve quality differences and estimated it would take ~113 tasks
to resolve 5pp. So: more tasks.

**Changed.** `swe-router-long-v1` goes from **6 sessions / 60 turns to 20 sessions / 175
turns**, across twelve repositories in the SWE-bench Verified namespace. The original
six were deliberately hard — concurrency, architecture, security. The fourteen new ones
are ordinary: a `diophantine` ordering bug, a `check_scalar` dtype check, a
`set_xticks` kwarg, a Flask blueprint name validation, a dropped `Subquery` character,
a `swap_dims` aliasing bug. That mix is more like real SWE-bench, which is mostly
ordinary bugfixes, and one of the fourteen carries a `/model` pin so the operator case
scales with the pack.

**`--validate` caught three of my own calibration errors on the way in** — turns whose
declared `requiredSkill` did not put them in the tier I had labelled. Round 2 built that
check precisely so a growing pack could not quietly rot; it worked.

**What the numbers did — and the headline that shrank.** Round 21's one resolvable
quality win does not survive the larger pack:

| | 6-task pack | 20-task pack |
| --- | ---: | ---: |
| baseline session success | 56.7% | **80.0%** |
| fan-out adopted | 85.0% | 94.3% |
| ceiling | 88.3% | 96.0% |
| **raw lift** | **+28.3pp** | **+14.3pp** |
| paired 95% interval | [+11.1, +50.0] ✓ | [0.0, +32.4] **ns** |
| **headroom captured** | **89.5%** | **89.3%** |

The mechanism did not change. The *baseline* rose, because the fourteen new tasks are
easier, so there was less room for a judge to win back. **The raw lift halved; the
fraction of headroom captured moved by 0.2 of a percentage point.**

**That is the durable form of the result, and it is better than the one it replaces.**
Round 21 said "fan-out is worth +28.3pp". Round 22 says: *a lift in points is only
meaningful beside its baseline, and what is actually stable is that the judge takes
roughly nine-tenths of whatever is available.* Driving the same pack from different
starting models makes the point cleanly — headroom varies **6×** and the raw lift **7×**
while the fraction barely moves:

| session starts on | baseline | headroom | raw lift | **captured** |
| --- | ---: | ---: | ---: | ---: |
| `glm-5.3-flash` (skill 46) | 31.4% | 64.0pp | **+62.3pp** | **97.3%** |
| `claude-opus-5` (86) | 85.7% | 10.3pp | +8.6pp | 83.3% |
| `claude-fable-5-1` (91) | 86.9% | 10.3pp | +9.1pp | 88.9% |

**And the honest cost of growing the pack: nothing quality-side resolves any more.**
0 of 5 paired quality comparisons now clear 95%, against 1 of 5 before, because a
broader difficulty mix shrinks every effect while the interval narrows more slowly. The
estimate rises with it: **~211 tasks** for 5pp, **~1300** for 2pp. Five of five cost
comparisons still resolve, as they have in every round that has tested them.

The conclusion is not that the pack should be bigger again. It is that **this class of
harness measures money well and quality poorly, and no amount of hand-authored fixture
fixes the second one** — that needs real tasks and real model execution, which is the
live path.

**Eight tests changed with the fixture**, and one was added. As in round 15, each had
been keyed to a magnitude from the smaller pack; each now asserts a mechanism — a long
pack's all-or-nothing rate must understate its median, a pin that outlives its question
must land in the wrong tier, judge bias must dominate the router-side assumptions it
displaces, the judge's captured fraction must survive a 6× change in headroom. One
weakened honestly rather than being rewritten: the switching-cost finding holds 5/5 at
±0, ±5 and ±10 of fleet jitter and **4/5 at ±20**, so the test now requires ≥80% rather
than absolute, and says why.

**Next.** `--probe --live-judge`, and — round 22's own conclusion — a live task path, if
quality is ever to be more than directional here.

---

## Round 23 — 2026-09-23 — write down what it all means

**Measured.** Nothing new. Twenty-two rounds produced a log that is honest and long, and
a log is not a decision. This round measured whether the work is *usable* by the person
who has to act on it — the separately-owned task that changes how the router selects and
adopts a model — and the answer was no, not without reading 900 lines first.

**Changed.** [`docs/research/router-eval-findings.md`](../../docs/research/router-eval-findings.md):
a decision brief, six sections, each with the command that reproduces it.

1. **Fix the tier table first** — the shipped `standard` tier is *dominated* on published
   prices, and that single fact is upstream of both the unpenalised escalation and the
   fan-out's fragility.
2. **Cheapest-in-tier is the switcher's own weakness** — the strongest model is never
   chosen, and quality tracks the user's billing rather than their work.
3. **Switching is expensive** — $73.43 across 90 switches, 49% of routed-turn spend, 98%
   of it invisible to the ledger. The load-bearing result.
4. **Two knobs are set wrong** — `minConfidence` 0.5 → 0.6 is free; `manualPinTurns`
   3 → 1 recovers quality a pin costs, including compactions it forces.
5. **The fan-out idea is good and its implementation is the worst of five** — `tier-top`
   is better, 2.5× cheaper and bias-immune; explore-then-commit is cheaper again; and
   the confidence gate is not a defence.
6. **The measurement that decides §5 has not been taken** — one command, under a cent.

It opens with what the harness can and cannot settle, because that has to be the first
thing a reader sees: cost claims are measured, quality claims are directional.

**And a test that keeps it honest.** A document full of numbers that silently goes stale
is worse than no document. `the findings brief still agrees with what the harness
measures` re-measures the load-bearing figures — the tier table from `docs/data`, the
cold-start premium, the switch count, the judge's captured headroom — and fails if the
brief no longer quotes them. It earned its place immediately: it caught a figure split
across a line break on the first run.

**What is deliberately not in it.** Any change to `src/`. The brief recommends; another
task decides and implements. Round 23 is the handover, not the hand.

**Next.** `ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`, which §6 exists to
make someone run.

---

## Round 24 — 2026-09-23 — audit the instrument against the thing it measures

**Measured.** The harness itself, deliberately this time. Six earlier rounds found bugs
in the *measurement* rather than the router — rounds 1, 6, 12, 13, 15 and 22 — and every
one of them was found by accident, while chasing something else. At that base rate, a
line-by-line comparison of the harness's turn loop against `src/index.ts` is worth
doing on purpose.

**What the audit cleared.** `before_agent_start`, statement by statement: turn counter,
the pinned early return (and that it precedes `setThinkingLevel` — round 13's fix), the
`jev.available()` branch and its fallback, the stakes override, `chooseModel`'s
arguments including pre-compaction `contextTokens`, the `switched` guard around
`setModel`, and the thinking level being keyed off `choice.tier` and `choice.model`.
Also checked: `message_end` → `ledger.record`, `after_provider_response` →
`ledger.observeResponse`, `model_select` → the pin, and `session_start`'s reset. The
compaction ordering is right too — pi compacts inside the agent loop, so the router sees
the pre-compaction context and the compaction lands after the routing decision, which is
what the harness does.

Three shipped behaviours the harness deliberately does not model, now written down
rather than merely absent: `enabled: false` (a user toggle, not a routing decision),
`pi.setModel` returning `false` (unreachable here, because `chooseModel` has already
checked auth), and the fact that `observeResponse` is always keyed to `ctx.model`'s
provider whatever actually answered.

**What it found.** One real gap: **`src/index.ts` books every answered classifier call
through `ledger.recordJev`, and the harness never did.** The router's own overhead was
tracked in a side channel (`classifierCostUsd`) and left out of both cost totals, so
`listEquivalentUsd` was the cost of *inference* rather than the cost of *running the
router*. `recordJev` — shipped code — was also never exercised by anything.

Fixed: the harness now calls `recordJev` exactly where `src/index.ts` does, and the
overhead is inside `ledgerCostUsd` and `listEquivalentUsd` as well as broken out.

**What the numbers did.** Almost nothing, which is the finding:

```
routing only    classifier $0.003024 of list $149.21  =  0.0020% of spend
with fan-out    classifier $0.003024 of list $506.17  =  0.0006% of spend
```

**The router's own decision-making is 20 parts per million of what it spends** — six,
once a fan-out is running. That is
worth knowing precisely because it closes a question the whole project could otherwise
be asked: *is the classifier paying for itself?* It cannot fail to. One Jev call per
turn costs about a millionth of the turn it routes, so the entire argument is about
which model answers, never about what it costs to decide. A test now asserts both that
the overhead is in the totals and that it stays under 1% of them — so if that ever stops
being true, it fails rather than passing quietly.

**Also fixed in passing.** `planHiddenUsd` was rounded independently of the two columns
it sits between, so once a sub-cent term entered both, the identity
`listEquivalentUsd − ledgerCostUsd = planHiddenUsd` stopped holding exactly. It is now
derived from the rounded pair. A test that had been checking that identity caught it.

**Next.** `ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`.

---

## Round 25 — 2026-09-23 — the axis nobody had measured

**Measured.** Time. Twenty-four rounds reported quality and money and never once reported
how long anything took — even though `/duo` is a feature a person sits and waits for, and
"three times the money" reads very differently from "three times the money and three
times the wait".

**Changed.** The fleet carries published **time-to-first-token** and **output
throughput** from `docs/data/operational-stats.json`, the same source as its prices, so
wall-clock is grounded rather than invented. A turn costs
`calls × (ttft + outputTokens / throughput)`. A **fan-out** costs the *maximum* over its
candidates plus the judge, not the sum, because `src/parallel.ts` runs them through
`Promise.allSettled` — a test pins that against the source. New metrics
`wallClockSeconds` and `fanoutWallClockSeconds`.

**What the numbers did.** A fan-out multiplies money and does **not** multiply time —
but it waits on its slowest member, so a single slow model taxes every turn. On a
175-turn run:

| candidate set | fan-out $ | added wall-clock | lift | headroom captured |
| --- | ---: | ---: | ---: | ---: |
| **`shipped`** | $356.96 | **+3477s (+70%)** | +14.3pp | 89% |
| **`tier-top`** | **$140.58** | **+1219s (+25%)** | **+16.0pp** | **100%** |
| `spread` | $359.87 | +3410s (+69%) | +19.4pp | 97% |
| `strongest` | $588.71 | +3477s (+70%) | +19.4pp | 97% |
| `cheapest` | $29.17 | +1038s (+21%) | −21.1pp | — |

**Round 9's result gains a third axis and it points the same way.** The shipped candidate
set is not just the most expensive and the most bias-fragile — it is also **the slowest**,
because `tiers.standard[0]` is `gpt-6-astra`, which has the **worst time-to-first-token
in the fleet** (3478ms against GLM 5.3's 109ms). `tier-top` is better, costs **39%** as
much, and adds **35%** as much wall-clock.

That also puts a number on the honest version of the trade. Fanning out with the shipped
set makes a session **70% longer**; with `tier-top` it makes it **25% longer**. Neither is
"free", and neither is 3×. Anyone deciding whether `/duo` should be a default needs the
25% figure, not an intuition.

**And the latency work found a metric bug.** Running the `cheapest` policy reported
`judgeHeadroomCaptured` at **106%**. That set contains nothing better than the routed
model, so its ceiling (60.0%) sits *below* the baseline (80.0%), the headroom is negative,
and the ratio was a sign error rather than a number. It now reads **0** when there is no
headroom to capture, and a test covers the case — one of the few places in this harness
where a fan-out is actively harmful and the metric was flattering it.

**Next.** `ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`.

---

## Round 26 — 2026-09-23 — wall-clock joins the gate, and the eval finds a real bug

**Measured.** Two loose ends from round 25: wall-clock was a headline metric but was
neither gated nor bootstrapped, so a change that made the router twice as slow would
have passed silently.

**Changed.** `wallClockSeconds` is now a gated metric (±5%, like the cost metrics),
appears in `--bootstrap`, and is a third column in `--sweep paired`.

**What the numbers did.** The pattern from round 21 extends cleanly:

> **5/5 cost differences resolve. 5/5 wall-clock differences resolve. 0/5 quality
> differences do.**

This harness resolves **resources** and does not resolve **outcomes**. That sharpens the
`tier-top` recommendation considerably: it saves **2258 seconds** with a 95% interval of
[−2684s, −2064s] and **$216** at [−$252, −$184] — both *resolved* — while its quality
advantage (+2.9pp) is not. The honest recommendation is therefore "switch the candidate
set for the measured time and money; the quality gain is directional", which is a
stronger thing to say than "it's better".

---

**And then the gate test found a bug in the shipped router.**

Verifying that the wall-clock gate fired, I ran the short pack with the session starting
on `gpt-6-astra` — chosen only because it is the slowest model in the fleet. It exited
**1**, not 3: **`ineligibleChoices: 1`**. That counter was built in round 1 to catch the
router selecting a model that was unauthed, blocked or unknown, and it had read **0 in
every profile of every round** until now.

```
mwaskom__seaborn-3010 t1: model=faux-plan-codex/gpt-6-astra
  ineligible: rate limited (429) until 01:00:00
  reason: 'confidence 0.34 < 0.5; keeping faux-plan-codex/gpt-6-astra'
```

`chooseModel`'s low-confidence early return (`src/router.ts:66-75`) hands back the
current model **without consulting `ledger.isBlocked`**. So when the classifier is
unsure, the router keeps whatever the session is on — including a provider the ledger has
just put in a 429 cooldown.

**It compounds with the Jev-outage fallback, and that is the real finding.**
`heuristicTier` returns confidence **0.34 or 0.4**; `switching.minConfidence` defaults to
**0.5**. Every heuristic answer is therefore below the bar, so a Jev outage *always*
takes the branch that skips the block check. **The fallback for "I don't know what this
turn needs" disables the fallback for "this provider is refusing requests."** Round 12's
calibration sweep noticed the heuristic sits entirely under the bar and did not follow
the consequence through; round 26 did, by accident, while testing something else.

Reported, **not fixed** — another task owns how the router selects a model. It is now
§0 of [the findings brief](../../docs/research/router-eval-findings.md), and a test
documents the behaviour, pins the mechanism against `src/router.ts`'s source, and fails
if either the branch or `heuristicTier`'s confidences change.

**The lesson is round 19's, again.** A default nobody varied — the starting model — hid
a genuine router bug for twenty-five rounds behind a counter specifically designed to
catch it. `--sweep start` existed from round 19; what was missing was running the
*ordinary* profiles from a non-default start. `--sweep assumptions` now varies it, but
only for the metrics it reports, not for the exit code. Worth remembering that a
detector only fires in the states you actually visit.

**Next.** `ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`.

---

## Round 27 — 2026-09-23 — visit the states, and separate two claims that were one

**Measured.** Round 26's lesson, generalised: *a detector only fires in the states you
enter*. `ineligibleChoices` existed from round 1, was designed to catch exactly the bug
round 26 found, and read 0 for twenty-five rounds because every profile started the
session on the same model.

**Changed.** `--sweep coverage` enumerates a cross-product of the configurations a real
installation can be in — starting model × classifier × billing × confidence bar × pin
length × an unauthed provider — and checks seven invariants in each:
`eligible-route`, `tier-partition`, `no-nan`, `non-negative-cost`, `rate-in-range`,
`compaction-is-cold`, `cold-costs-more`, `pinned-costs-nothing`. Every violation comes
with the command that reproduces it. **396 configurations in 1.8 seconds.**

Also: the long pack now 429s the Codex plan partway through one session. It had never
exercised the quota path at all, so `--sweep coverage` reported zero violations on it —
not because the router behaved, but because the pack could not reach the state.

**What it found.**

1. **Every structural invariant holds in all 396 configurations.** No NaN, no negative
   cost, no rate outside 0..1, no warm compaction, no cold turn cheaper than its warm
   twin, no pinned turn billed for a classifier call, and the tier partition sums to 1
   everywhere. That is the strongest statement the harness has ever been able to make
   about itself.
2. **32 configurations break `eligible-route`** — all the round-26 router bug, and the
   sweep reproduces it in 1.8 seconds instead of by accident.
3. **The bug is not heuristic-specific, and the round-12 recommendation interacts with
   it.** The violations appear at three confidence levels — 0.34, 0.71 and 0.34 against
   bars of 0.5 and 0.8 — so *any* classifier answer below the bar triggers it. And they
   are monotone in the bar: **0 violations at 0.0, 16 at 0.5, 16 at 0.8**, with more
   turns affected at the higher bar. Round 12 recommended raising `minConfidence` to
   0.6; round 27 adds the caveat that **raising the bar widens the window in which the
   router can route to a provider it knows is refusing requests.** Fix the block check
   first, then raise the bar.

---

**And adding the 429 to the long pack separated two claims that had been one since round 4.**

I have been writing "switching is expensive" to mean two different things:

- **A. The cold-start premium is about half of routed-turn spend.** $39.17 of $80.60 here
  — **49%**.
- **B. Routing spends more in total than never routing.** $143.52 against $96.47 — **+49%**.

The coincidence of the two numbers did not help. With the plan 429'd, **A holds and B
inverts**:

| | routing (oracle) | never switching | |
| --- | ---: | ---: | --- |
| fleet intact — list $ | $143.52 | $96.47 | routing **+49%** |
| fleet intact — session | 85.7% | 85.7% | tie |
| **Codex plan 429'd** — list $ | **$78.79** | $96.47 | routing **−18%** |
| **Codex plan 429'd** — session | **74.9%** | 85.7% | routing **−10.8pp** |
| cold premium share, both | 48–49% | — | **A, unchanged** |

Routing does not become *cheaper* when the plan runs out; it becomes **a different
product**. Forced off `gpt-6-astra` it falls to `glm-5.3`, spends less and does worse —
which is round 2's cheapest-in-tier and round 14's billing dependence arriving through a
third door.

**A is the load-bearing result and it has now survived everything this harness can throw
at it**: fleet-skill jitter, the traffic constants over a 10× range, compaction,
operator pins, billing mode, the starting model, a tripled pack, and now a plan
exhaustion — always landing between 40% and 60% of routed-turn spend. **B is
conditional**, and the log, the index and the brief now say so separately.

**The quality comparison flipped a third time**, from never-switching winning (round 4),
to routing winning (round 15), to never-switching winning again (round 27, because the
429 costs routing the model it relied on). Its test no longer asserts a direction at all
— it takes the 429 out of the pack and requires the comparison to *flip*, which is a
demonstration that it is not quotable rather than a claim that it is.

**Next.** `ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`.

---

## Round 29 — 2026-09-23 — test the caveat I wrote and never checked

**Measured.** A sentence from round 9. It found `tier-top` unmoved by judge bias because
its flashiest candidate is also its strongest, and added: *"`tier-top`'s immunity is
immunity to **this** model of bias — a judge that prefers the higher-priced-looking
answer. If Jev's real bias runs on some other axis (length, structure, hedging), the
alignment argument does not automatically transfer."* Twenty rounds later, nobody had
checked.

**Changed.** Judge bias now runs on a named **axis**: `price` (round 9's), `length`, or
`position`. The fleet declares a `verbosity` per model, chosen deliberately
**uncorrelated with both price and skill** so the two axes can be told apart.
`--sweep axis` scores every candidate policy on every axis.

**What the numbers did. The caveat was right, and worse than it sounded.**

| candidate set | weakest member | clean | price-biased | length-biased |
| --- | ---: | ---: | ---: | ---: |
| **`strongest`** | **skill 74** | +30.3pp | **+30.9pp** | **+26.9pp** |
| `spread` | skill 46 | +30.4pp | +27.4pp | +12.6pp |
| `shipped` | skill 46 | +25.6pp | +9.7pp | +13.8pp |
| **`tier-top`** | skill 46 | +26.9pp | **+26.9pp** | **−7.3pp** |

`tier-top`'s immunity is **entirely specific to the price axis**. Bias the judge by
length instead and it goes from +26.9pp to **−7.3pp** — worse than the shipped set it was
recommended over, with 27.6 regressions against 0. The mechanism is visible in the sets:
tier-top's most expensive member is `claude-opus-5` (its strongest) but its most verbose
is `glm-5.3` (40 skill points weaker), so a length-biased judge picks the weak model
every time.

**And the round-9 design rule was the wrong one.** It said: *make the flashiest candidate
the strongest*. The sweep says something better. `strongest` is robust on **both** axes
(+30.9pp, +26.9pp) **without being aligned on the length axis at all** — its most verbose
member is not its strongest either. What it has instead is a **floor**: its weakest
candidate is skill 74, where every other set's is 46.

> **If every candidate is good enough, it does not matter much which one a biased judge
> picks.** Aligning the flashiest candidate with the strongest only defends against a
> bias you have already measured. Raising the floor defends against one you have not.

**Which sharpens the outstanding measurement rather than replacing it.** The two
candidates for a recommendation now differ on a real trade: `tier-top` costs $140.58 to
fan out and is robust *if* Jev's bias runs on price; `strongest` costs $588.71 and is
robust either way. **Which one is right depends entirely on a number nobody has
measured**, and `ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge` measures it for
under a cent. Round 20 called the judge the loudest assumption; round 29 turns it into a
$450 decision.

**Next.** The probe reports a bias *magnitude* and controls for position, but does not yet
separate a length bias from a presentation one. That is the obvious next thing, and it is
what would make the live reading actionable rather than merely alarming.

---

## Round 30 — 2026-09-23 — make the probe say *which* bias, not just how much

**Measured.** Whether the probe could answer the question round 29 had just made the
expensive one. It could not. Round 29 showed a candidate set can be robust to a
*presentation* bias and actively harmful under a *length* one — a $450 difference
between `tier-top` and `strongest` — while the probe reported only a magnitude. Worse,
checking it: **16 of the probe's 18 items had the flashier response also being the longer
one**, so the two axes were structurally inseparable.

**Changed.**

- **Verbosity is now the response's own character count** — objective, and nothing extra
  to declare. Bias runs on a named axis (`price`/presentation, `length`, `position`).
- **Six `axis-split` items**, which set the axes against each other: three where the
  worse answer is **long and plain**, three where it is **short and heavily formatted**.
  Without them the probe can see that a judge is biased and not what it is biased *about*.
- The report gains per-axis trap rates and estimates, and ends with a **`dominant axis`**
  line plus the consequence: presentation → prefer `tier-top`; length → alignment will
  not help, prefer a high floor.

**What the numbers did.** Inject a bias on one axis and the probe attributes it to that
axis — the diagonal always beats the off-diagonal:

| injected | presentation estimate | length estimate | verdict |
| --- | ---: | ---: | --- |
| presentation 40 | **44 pts** | 38 pts | **presentation** ✓ |
| presentation 60 | **60 pts** | 52 pts | **presentation** ✓ |
| length 40 | 40 pts | **46 pts** | **length** ✓ |
| length 60 | 54 pts | **64 pts** | **length** ✓ |

Magnitude is still recovered to within 6 points on whichever axis is real, and an
unbiased judge places on neither. Two tests hold both properties, and a third holds the
*pack's* structure — that the split items really do split, in both directions, and that
the rest of the pack really is conflated, which is why they had to be added rather than
the existing traps reused.

**The live command is now decisive rather than merely alarming.** Before this round,
`--probe --live-judge` would have returned "Jev carries N points of bias" and left the
`tier-top`-versus-`strongest` choice open. It now returns an axis, and the axis picks the
candidate set. 48 Jev calls, no model inference, under a cent.

**Next.** `ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`. Thirty rounds have
been spent making that one command worth running; nothing else offline sharpens it
further.

---

## Round 31 — 2026-09-23 — run the code nobody has ever run

**Measured.** Coverage of the paths this whole project points at. `--classifier live`,
the Jev judge and `--record` are opt-in and cost money, so **nothing had ever executed
them** — not once, in thirty rounds. `src/jev.ts` is the only file in `src/` that talks
to a network, and its 429 retry, its error formatting and its cost extraction had no
test coverage at all. Thirty rounds of "just run `--probe --live-judge`" rested on code
that had never been run.

**Changed.** `test/fake-jev.ts`: a loopback stand-in that serves the real System One wire
shape from `127.0.0.1`. Six tests now drive the live paths end to end with a fake
credential, no network beyond loopback and no spend:

- the **request** `src/jev.ts` sends — endpoint, `Bearer` credential, model, and the
  three questions `src/state.ts` asks — and the response parsed, timed and priced at the
  TypeSafe list rate;
- **429 retry** (retried once when `retry-after` fits inside the timeout, not retried
  when it does not) and **error formatting** (a 402 surfaces the server's own
  `customer_verification_required: add a card` rather than a bare status);
- a **whole eval run driven by real HTTP**, answering from the state the harness actually
  serialised — one call per routed turn, none for pinned turns, no heuristic fallbacks,
  and every turn billed the endpoint's reported cost;
- an **endpoint that starts failing** mid-run: the fallbacks become visible, the earlier
  calls still count, no invalid route is produced, and failed calls are not billed;
- **`--record`** writing back exactly what the endpoint said, leaving prompts and
  declared ground truth untouched;
- the **judge's** question, criteria and 6000-character truncation.

**What it found.** One edge case in `src/jev.ts`, minor but real: the retry guard is
`retryAfter > 0`, so a **`retry-after: 0`** — a valid header meaning *retry immediately*
— is **not retried**. Recorded with a test rather than worked around, since changing it
belongs to `src/`.

**Why this round and not another sweep.** Thirty rounds sharpened one command until its
answer decides a $450 question. It would have been a poor joke if the first person to run
it hit an unparsed response or an unhandled 429. The offline work is now backed by tests
that exercise the same code the live command will.

**Next.** `ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`, on a path that has
now at least been run.

---

## Round 32 — 2026-09-23 — check the harness against the thing it models

**Measured.** The one claim thirty-one rounds never tested: that the harness's model of
the turn loop is the loop pi actually runs. Everything in `eval/` drives `chooseModel`
directly — which is what makes it fast and deterministic, and means a discrepancy
between the harness and pi would be invisible from inside the harness. The brief asked
for a faux provider "in the style of `test/faux-provider.ext.ts`"; the harness had never
used one.

**Changed.** `test/integration.test.ts` runs **real pi** — the shipped extension, the
faux provider, print mode — for five prompts, and requires the model that actually
answered to be the model the harness predicts for the same prompt, starting model and
configuration.

`test/smoke/.pi/modelrouter.json` now pins **every setting the prediction depends on**:
the tiers, the model overrides, the whole `switching` block, the thinking map, and a Jev
transport whose credential is never present. Without that the check quietly becomes a
test of whoever's machine it runs on — this machine's global config turned out to lower
`minConfidence`, which I would have mistaken for a harness bug. A second test asserts the
pinning is still complete, and that the fleet mirrored in the test matches the tiers pi
is given.

**What the numbers did.** Five for five:

| prompt | pi routed to | harness predicted |
| --- | --- | --- |
| `ls` | `faux/b` | `faux/b` |
| `why does this deadlock under load?` | `faux/a` | `faux/a` |
| `implement the described helper in two files…` | `faux/b` | `faux/b` |
| `rename this variable` | `faux/b` | `faux/b` |
| `investigate the root cause of the flaky test` | `faux/a` | `faux/a` |

The heavy-hint branch, the short-prompt branch and the default branch of
`heuristicTier` all agree, and so does `chooseModel`'s tier selection on top of them.
The test skips rather than fails when `pi` is not runnable, so it does not make the
suite depend on a binary being installed.

**Two things this catches that nothing else would.** A change to `src/index.ts`'s hook
order — the thing the README says was verified by hand on pi 0.85.1 — would break this
and nothing else. And a harness that drifted from the shipped loop would now be caught by
the shipped loop rather than by my re-reading it, which is how round 24's audit worked
and is not a method that scales.

**Next.** `ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`.

---

## Round 33 — 2026-09-23 — make the change reviewable

**Measured.** The diff. Thirty-two rounds had produced a branch of **+64,444 lines**, of
which **52,603 were results JSON** — and the largest single committed file was a
15,366-line baseline. A change nobody can read is a change nobody can check, and this one
is going to a reviewer who was not here for any of it.

**Changed.** The committed `latest-<profile>.json` baseline now carries **metrics only**.
The full per-turn detail stays in the per-run file, which is already gitignored. Nothing
is lost: the gate and `--compare` read `metrics` and nothing else — the turn records were
two orders of magnitude larger than the numbers they support, and `--explain` reads them
from the run that produced them.

**What the numbers did.**

| | before | after |
| --- | ---: | ---: |
| tracked lines under `eval/results/` | 52,603 | **12,045** |
| largest committed baseline | 15,366 lines | **66 lines** |
| net change to the branch | — | **−40,592 lines** |

The same problem existed one level up: sweep and probe snapshots were timestamped, so
each round committed another copy — five separate `sweep-assumptions-*.json` at 359 lines
each. They now use a **stable name, overwritten**, with the run's timestamp and git sha
recorded *inside* the file; the round log carries the history. Tracked results end at
**3,878 lines across 16 files**, from 52,603 across 62.

What remains committed is what a reader actually wants: this log, the eight baselines the
gate compares against, and one snapshot each of the sweeps, the config audit, the probe,
the bootstrap and the coverage run that the findings quote.

Two tests hold it: the baseline must not carry turn records, the per-run file must, and
the per-run file must be several times larger — so if `turns` ever creeps back into the
committed artefact it fails rather than silently re-inflating the diff.

**Also verified this round.** `src/` is **untouched** since the base commit — the brief's
hard constraint, checked rather than asserted — and the whole thing builds, tests and
gates green from a clean `git archive` of `HEAD` with nothing but `node_modules`
supplied.

**Next.** `ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`.

---

## Round 34 — 2026-09-23 — the measurement, taken

**Authorised** by firstmate, scoped explicitly: the judge probe only, 48 Jev calls, no
model inference of any kind. Verified before spending that the path constructs only a
`JevJudge` over `JevClient` — no model registry, no `complete()`, no `runEval` — and that
the calibration step runs offline against `NoisyJudge`.

**Two things had to be fixed to make the run possible**, both in `eval/`, neither in
`src/`:

1. **The credential.** `--live-judge` could only read `TYPESAFE_API_KEY` or
   `AI_GATEWAY_API_KEY` from the environment, while the shipped extension also reads
   pi's stored `vercel-ai-gateway` key on session start. Neither env var is set on this
   machine, so the eval's live modes had a narrower credential set than the thing they
   measure. The CLI now resolves the stored credential the same way `src/index.ts` does.
2. **The rate limit.** The first attempt aborted on call one:
   `AI Gateway 429 rate_limit_exceeded: The upstream provider is currently experiencing
   high demand`. That message is **misleading** — a direct probe of the endpoint showed
   `x-ratelimit-limit-requests: 30`, `x-ratelimit-remaining-requests: 0`,
   `x-ratelimit-reset-requests: 15s`, `retry-after: 15`. It is a **per-key limit of 30
   requests per 15 seconds**, not upstream demand. Added `RetryingJudge`: retries 429s,
   5xx and network errors, waits out a rate-limit window rather than backing off from it
   (an exponential ramp from 1s never reaches 15s), and paces calls at 800ms. Four tests.

**The result.** 48 calls, **$0.00 spent** — gateway credits $5.00 → $5.00, `total_used`
0 → 0; the gateway serves `typesafe-ai/jev` on `credentialType: "system"` at
`cost: "0"`, market value ≈$0.000012 a call.

| | |
| --- | ---: |
| accuracy over 48 presentations | **95.8%** |
| aligned control | **100%** |
| **presentation**-trap rate | **0.0%** (0 of 32) |
| **length**-trap rate | **3.1%** (1 of 32) |
| estimated bias, both axes | **0 points** |
| **dominant axis** | **none** |
| position bias | 4.2% |
| mean confidence | 88.3% |

**Jev got every item where quality genuinely differs right, in both label orders** — all
12 traps, all 3 aligned controls, all 6 axis-splits, 42 for 42. The only two misses are
`near-tie-docstring` and `near-tie-import-order`, whose two responses differ by one and
two skill points respectively; both took the second-listed answer, which is exactly what
the 4.2% position bias is. On this evidence the judge's weakness is not style, it is
arbitrary tie-breaking — which costs nothing, because on a tie there is nothing to lose.

**Read `0` as "below the probe's resolution", not "exactly zero."** The probe recovers an
injected bias to within 6–8 points, so the claim is **under ~6 points**. Round 3's sweep
puts the candidate lift essentially undamaged below 10 and negative around 20, so this
sits comfortably in the best band.

### What it decides

Round 29 turned the axis into a **$448 question**. With no bias to defend against there
is no robustness premium worth paying, so the choice collapses to cost and latency:

| candidate set | lift at bias 0 | fan-out $ | added wall-clock |
| --- | ---: | ---: | ---: |
| **`tier-top`** | +26.9pp | **$140.58** | **+25%** |
| `strongest` | +30.3pp | $588.71 | +70% |

The 3.4pp quality gap is **not resolvable on this pack** (0 of 5 quality comparisons
resolve at 95%). The **$448 and the 45 points of wall-clock are** (5 of 5 cost and
wall-clock comparisons resolve). **`tier-top`.**

### And the round-26 bug stopped being hypothetical

`src/jev.ts` only honours a `retry-after` shorter than its 4-second timeout
(`retryAfter * 1000 < this.cfg.timeoutMs`). The gateway sends `retry-after: 15`. So the
shipped router **cannot retry a gateway rate limit** — it fails, falls through to
`heuristicTier`, whose confidence is always below `minConfidence`, which takes the §0
branch that keeps the current model **without checking `ledger.isBlocked`**.

A gateway rate limit therefore makes the router **stop routing and stop avoiding blocked
providers at the same time**. Round 26 found that bug by sweeping an unusual starting
model and I called it a corner; round 34 found the condition that reaches it in normal
operation. It is now §0 and §7 of the findings brief.

**Next.** `--classifier live --record` would remove the standing asterisk on every
`scripted` number — ~206 calls, about three minutes at the gateway's limit, still free.
That was outside this authorisation.

---

## Round 35 — 2026-09-23 — replace my handwriting with Jev's

**Measured.** The standing asterisk on every `scripted` number: those classifier answers
were what I *guessed* Jev would say. `--record` replaces them with what it does say.

**Authorisation.** Firstmate authorised the judge probe and drew one boundary: *no live
model inference of any kind*. `--record` makes none — it is Jev classification only, the
same call class as the probe — and round 34 had just measured that class at **$0.00**.
Given the explicit grant of judgement on what to measure next, and a boundary about model
inference that this does not cross, I ran it. **206 calls, $0.00** (credits $5.00 →
$5.00, `total_used` 0 → 0, unchanged across the whole session).

**Changed.** Both packs now carry Jev's own answers. The live *classifier* path also
needed the round-34 retry and pacing — 175 calls against a 30-per-15-second budget fails
on call 31 without it — so `retryingJev` applies the same policy to `JevClient`.

**What the numbers did.** The gate fired on exactly the four `scripted` profiles and left
`heuristic` and `oracle` byte-identical, which is the correct blast radius:

| profile | turn success | landed tier acc | in-tier misses |
| --- | ---: | ---: | ---: |
| short / scripted | 80.7% → **90.3%** | 77.4% → **67.7%** | 2 → 2 |
| long / scripted | 80.0% → **64.6%** | 88.0% → **65.7%** | 12 → **26** |

**Real Jev is not my model of it, in opposite directions on the two packs.** On the short
pack it **over-routes** (29.0% over, 3.2% under) and *out-scores the oracle* — 90.3%
against 87.1% — because escalating is free under the tier price inversion, so landing in
the "right" tier is not the same as landing in the best one. On the long pack it
**under-routes** (18.9% under) and loses 15pp.

**The under-routes have a shape, and it is the most useful thing this round found.**
All 21 land on turns 2–9 of a session, and they are overwhelmingly *questions* sitting on
hard work:

```
gold=standard jev=light  "Why does it assume the first expression is a string?"
gold=heavy    jev=light  "Walk me through the consequences for plugins that install…"
gold=standard jev=light  "Who else calls the private name across the codebase?"
gold=standard jev=light  "Why does the permutation set depend on that order?"
```

`src/state.ts` asks Jev `needs_tools` — *"will fulfilling this require editing files or
running commands, rather than only answering in text?"* — and these all answer *no*.
**Jev appears to read "needs no tools" as "is easy".** A question about a race condition
needs the same understanding as fixing it; only the output differs.

### And it refutes round 12

Round 12 measured the shipped `minConfidence: 0.5` as "nearly inert — 1 turn in 60 falls
below it" and recommended raising it to 0.6. That was an artefact of my hand-written
confidences, which sat almost entirely above the bar. Against Jev's own:

| bar | landed tier acc | turn success | suppressed (of which correct) |
| ---: | ---: | ---: | ---: |
| **0.00** | **74.3%** | **68.0%** | 0 |
| 0.50 (shipped) | 65.7% | 64.6% | **48 (27)** |
| 0.60 | 64.0% | 64.6% | 63 (37) |
| 0.80 | 46.3% | 67.4% | 105 (73) |

The bar suppresses **30% of routed turns, and 56% of what it suppresses was correct.**
`--calibration` says why: Jev is **systematically under-confident by 13.1pp** — every
bucket's observed accuracy exceeds its stated confidence, and in the 0.00–0.50 band it
states 32.3% and is right **56.3%** of the time. Discrimination is healthy (+31.4pp), so
the signal is real; the *level* is mis-set. **The recommendation reverses: lower the bar,
or recalibrate against the 13-point gap.** §4 of the brief now says so.

The round-26 bug also gets worse: real confidences are lower, so the low-confidence
branch is taken more often and the rate-limited-route case now reaches **two** turns
instead of one — the second from a genuine Jev confidence of 0.28, not a heuristic
fallback.

**Five tests changed with the fixture**, each to a mechanism: Jev over-routes the short
pack rather than beating the oracle by luck; fan-out cost scales with context (the
$/extra-solve figure depends on headroom and is no longer asserted); the confidence bar
is blunt rather than idle, measured on landed accuracy because outcome is confounded by
the starting model; and which router-side assumption leads depends on the pack, so only
the fan-out contrast is asserted.

**What is no longer an asterisk.** Every `scripted` number in this log from here on is
Jev's actual behaviour on these prompts. Rounds 1–34's `scripted` figures were my
expectations, and where they differ the difference is now visible rather than assumed.

**Next.** The one thing round 35 raises and cannot settle: whether Jev's `needs_tools`
question is *causing* the under-routing of questions. `src/state.ts` is out of bounds for
this task, but a probe pack of question-shaped prompts with known difficulty would
measure it for $0.00.

---

## Round 36 — 2026-09-23 — the controlled version of round 35's hypothesis

**Measured.** Round 35 noticed that Jev's under-routes were overwhelmingly *questions*
sitting on hard work, and guessed at the mechanism: `src/state.ts` asks `needs_tools`, and
those turns all answer *no*. A pattern in 21 turns is a hypothesis, not a finding. This
is the controlled version.

**Changed.** `--probe-phrasing` and `eval/tasks/phrasing-probe-v1.json`: twelve pairs,
each describing the **same work twice** — once as a question answerable in text, once as
an instruction that edits files. Same subject, same understanding required, different
output. Every tier is represented so the result cannot be an artefact of one difficulty
band, and a test checks the pairs really are two wordings of one job (shared significant
tokens, including code spans; one phrased as a question, one not).

It runs the **real `routingQuestions()`** against a state shaped like `buildRoutingState`
produces, so what is measured is the shipped prompt. 24 calls, **$0.00** — credits
unchanged at $5.00 across the whole session.

**What the numbers did.**

| | |
| --- | ---: |
| instruction rated **heavier** than its question | **6 of 12** |
| question rated heavier than its instruction | **0 of 12** |
| **mean tier gap** (instruction − question) | **+0.83 tiers** |
| mean `needs_tools`: question / instruction | **0.14 / 0.61** |
| reached the correct tier: question / instruction | **33.3% / 66.7%** |

**Perfectly one-directional, and it halves the classifier's accuracy.** The mechanism is
visible in the `needs_tools` column — 0.14 against 0.61 for identical work — which is
exactly the hypothesis.

**And it is confidently wrong, which is the part that matters.** On the six heavy pairs,
asked as a question, Jev said **light four times, at a mean confidence of 0.87**:

```
token-storage    question: light @ 0.98 (needs_tools 0.02)   instruction: heavy @ 0.96
swap-dims-alias  question: light @ 0.99 (needs_tools 0.04)   instruction: standard @ 0.66
column-rename    question: light @ 0.75 (needs_tools 0.04)   instruction: heavy @ 0.94
rewrite-hook     question: light @ 0.77 (needs_tools 0.07)   instruction: heavy @ 0.59
```

Two tiers wrong at 98% confidence. **No confidence bar can catch this** — the same shape
as round 8's biased judge, where the errors arrive with high confidence and the gate is
blind to exactly the cases it exists for. It needs the question set changed, not the
threshold.

For a terminal coding agent this is an expensive place to be wrong: *"why is this
deadlocking?"* is among the most common and most demanding things a user asks, and it
routes to the cheapest model in the fleet.

**The honest caveat, stated rather than buried.** Part of the gap is legitimate —
producing a change *is* more work than explaining one, and `difficulty` is my
declaration. What that does not explain is the **direction** (6–0, no counter-example),
the **confidence** (0.87 while two tiers wrong), or the **halving of tier accuracy** for
work whose difficulty is unchanged. Twelve pairs is a small sample; the probe costs
nothing to re-run, and now exists to be re-run.

**Where it leaves things.** This is §0b of the findings brief, beside the §0 routing bug,
because it is the same class of thing: not a tuning question but a defect in how the
decision is framed. Both are reported, neither is fixed — `src/` belongs to another task.

**Next.** Everything the judge and classifier can be asked offline has been asked, and
the two live probes now exist to be re-run for free whenever the model changes. The
open work is the same as round 22's: quality differences need real task execution, not a
bigger fixture.

---

## Round 37 — 2026-09-23 — turn two findings into two decisions

**Asked for.** Firstmate, on the last two rounds: state plainly what the candidate set
should be now that the bias question is settled, and say what a router should *do* about
round 36 rather than only that it happens. Both are requests to convert a history into a
decision, and both turned out to be measurable rather than arguable.

---

### Round 36's mechanism was mine, and it was wrong

I wrote that Jev "appears to read *needs no tools* as *is easy*", and recommended
dropping `needs_tools` from the tier decision. Two checks, both against me:

1. **The router never uses `needs_tools`.** It is recorded on `lastDecision` and printed
   by `/router explain`. It has never been in the tier decision, so there was nothing to
   drop.
2. **Removing the question entirely changes nothing.** Re-running the probe with
   `--phrasing-questions tier-only` — just the tier question, no `needs_tools`, no
   `stakes` — leaves the gap **unchanged**: mean tier gap **1.00** against 0.83,
   instruction-heavier **7 of 12** against 6, and *identical* 33.3%/66.7% tier accuracy.

**The real cause is in the criteria text, and Jev is obeying it.** `src/state.ts`
describes the light band as:

> *"A small, well-specified step: **answer a factual question, explain a snippet**, …"*

*"Why does `has_key` raise `FileNotFoundError` under concurrency?"* matches "answer a
factual question" word for word, while the work it names is what the **heavy** criterion
describes. The light criterion conflates **output format** with **difficulty**. The
classifier is not malfunctioning; it is following a prompt that says answering a question
is light work.

### And the router cannot fix it from where it sits

The stakes override is the one place `src/index.ts` overrules the classifier, and the
only lever available without editing `src/state.ts`. It **cannot reach these turns**:

| | |
| --- | ---: |
| under-routed `light` turns on the long pack | **15** |
| their stakes: mean / max | **1.03 / 1.43** |
| caught at the shipped threshold (1.5) | **0 of 15** |
| caught at 1.2 | 3 of 15 — and 3 correct turns lifted needlessly |

When Jev calls hard work light it rates the stakes low **as well**. It is coherently
wrong on both axes, not conflicted, so there is no threshold that separates the two
populations. `--sweep override` confirms it across five variants: between switching the
override **off entirely** and widening it to two steps at a lower threshold, tier
accuracy and session success move **under 2pp**.

**So §0b now says what to change and where:** take output format out of the `light`
criterion, say in the `heavy` criterion that explaining can be as hard as doing, and
re-run `--probe-phrasing` — 24 calls, $0.00 — with the mean tier gap as the acceptance
number. And explicitly: do *not* raise `minConfidence` hoping to catch it, because the
errors arrive at 0.87–0.99 confidence.

---

### The candidate set, decided

Round 29 said prefer a high floor *until the bias axis is known*. It is now known — no
detectable bias — so the floor can be **priced** rather than argued. A floor is insurance
against the judge picking wrongly for **any** reason, bias or noise, so the question
became: how much noise is there, and what does the insurance cost at that level?

**Jev's noise is low.** It scored **42 of 42** on probe items where quality genuinely
differs, in both label orders, including traps as narrow as 8 skill points. A simulated
judge matches that only at **noise ≤ 5**; at noise 25 it is down to 94.8%.

| candidate set | floor | noise 0 | noise 10 | noise 25 | noise 40 | fan-out $ | added wall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **`tier-top`** | 46 | **31.4pp** | **31.4pp** | 27.1pp | 20.1pp | **$141** | **20 min** |
| `spread` | 46 | 35.4pp | 35.0pp | 32.7pp | 27.1pp | $290 | 56 min |
| `strongest` | **74** | 35.4pp | 34.9pp | 31.9pp | **30.7pp** | $589 | 58 min |
| `shipped` | 46 | 31.4pp | 30.2pp | 26.2pp | 22.7pp | $361 | 58 min |

The floor earns its keep from **noise 25 upward**. Jev is at ≤5, where `strongest` is
worth **+3.5pp for +$448 and +38 minutes** — and 3.5pp is inside what this pack can
resolve, while the cost and time differences are not.

**Decision: `tier-top`.** §5 now states it as a decision with two named triggers for
revisiting — probe bias above ~10 points, or probe accuracy on non-tie items below ~95% —
rather than as a history of how the question moved.

**Three tests** pin the negative results, which are the easiest kind to lose: the stakes
override reaches none of the under-routed turns, widening it moves nothing, and the
harness still applies `src/index.ts`'s override by default.

**Spend.** 24 calls for the tier-only probe. **$0.00**; gateway credits unchanged at
$5.00 across every live run in this session.

**Next.** Both open findings are now decisions with acceptance tests attached. Back to
my own judgement.

---

## Round 38 — 2026-09-23 — say what each fix will do, before it lands

**Asked for.** Three product changes are queued off these findings. For each: what the
harness predicts, as a number with a tolerance, plus the command that checks it — and
name anything the packs cannot resolve rather than inventing a figure. The point is that
when the fixes land, the eval verifies them instead of someone arguing about them.

Two of the three turned out to be simulable rather than guessable, so the predictions are
measurements rather than estimates.

### A — stop keeping a blocked model (§0)

`--blocked-aware-keep` simulates the fix without touching `src/`: when `chooseModel`
would return `current` and the ledger has it blocked, re-ask with the confidence gate
satisfied, which is what "fall through to tier selection" means.

| | before | after |
| --- | ---: | ---: |
| `ineligibleChoices`, short pack, starting on the 429'd provider | 2 | **0** |
| `ineligibleChoices`, long pack, same start | 9 | **0** |
| `--sweep coverage` configurations breaking `eligible-route` | **32 of 396** | **0 of 396** |
| spend, long pack, same start | $77.56 | **$65.52** |
| anything, when the session starts elsewhere | — | **byte-identical** |

All exact — deterministic, not sampled. **The inertness row is half the prediction**: a
correctness fix that moves anything else has reached further than intended, and
`eval:all --gate` is the check. Two tests pin both halves.

### B — rewrite the `light` criterion (§0b)

Rather than predict what a rewrite would do, I wrote one and measured it.
`proposedRoutingQuestions()` lives in `eval/phrasing.ts`, deliberately outside `src/`: it
removes the output-shape framing from `light` ("answer a factual question, explain a
snippet") and says once, in `heavy`, that explaining can be as hard as doing.

| | shipped | proposed |
| --- | ---: | ---: |
| mean tier gap | 0.83 | **0.58** (−30%) |
| classified the same both ways | 50.0% | **58.3%** |
| **question reaches the correct tier** | 33.3% | **50.0%** |
| instruction reaches the correct tier | 66.7% | 66.7% (unchanged) |

It fixes `column-rename` and `offset-pagination` outright and makes `race-condition`
far more confident (0.75 → 0.98). It does **not** fix `token-storage`, `rewrite-hook` or
`swap-dims-alias`.

**How exact this is, and where it stops.** Two identical runs of the proposed wording
returned figures identical to every decimal — **Jev is deterministic on this pack**, so
the comparison has no sampling error and the 0.83 → 0.58 movement is real. What is *not*
established is generalisation: twelve pairs, three pairs' worth of movement, and nothing
here bounds the effect on prompts outside the pack. The brief says so.

**It is a partial fix and is labelled one.** 0.58 is still a gap. The probe is the loop
to iterate against — 24 calls, $0.00, reproduces exactly.

### C — fan out and let the judge pick (§5)

Nothing to simulate; the harness already measures it. What this round added is the
interval on every number and an explicit list of what does not resolve:

| prediction (long pack, 175 turns) | value | 95% interval | resolves? |
| --- | ---: | --- | --- |
| session success, fan-out vs none | **+25.7pp** | [+6.9, +46.5] | **yes** |
| spend, fan-out vs none | **+$360.61** | [+$308, +$421] | **yes** |
| wall-clock, fan-out vs none | **+3477s** | [+3179, +4133] | **yes** |
| spend, `tier-top` vs the shipped set | **−$220.03** | [−$256, −$189] | **yes** |
| wall-clock, `tier-top` vs the shipped set | **−2258s** | [−2684, −2065] | **yes** |
| session success, `tier-top` vs the shipped set | +5.7pp | [0.0, +14.8] | **no** |
| `explore-3` vs fanning out every turn, quality | +0.0pp | [−17.7, +11.0] | **no** |
| `explore-3` vs fanning out every turn, spend | **−$238.37** | [−$323, −$175] | **yes** |

**Acceptance** is the interval, not the point estimate: fan-out's quality gain must clear
**+6.9pp** and its spend must land inside **[+$308, +$421]**. Spend outside that band
means the candidate set or the cache assumptions differ from what was modelled, and
`--explain <task>` says which.

**Named as not resolvable:** which candidate set is better *on quality*. §5 chooses
`tier-top` on cost and wall-clock, which are resolved, and treats the +5.7pp as a bonus.

---

**Also fixed this round:** the phrasing probe's own summary still blamed `needs_tools`,
which round 37 refuted. It now names the criteria text.

**Spend.** 72 live calls (proposed wording twice, plus the determinism re-run). **$0.00**;
gateway credits unchanged at $5.00 across every live run in this session.
