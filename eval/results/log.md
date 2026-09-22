# Router eval rounds

One entry per round: what it measured, what it changed, what the numbers did.
Runs are reproduced with `npm run eval -- <flags>`; the JSON for each is in this directory.

## Findings index

Jump to the round that established each claim, and what it rests on.

| Finding | Round | Robust to |
| --- | :---: | --- |
| The router never picks an ineligible model — `ineligibleChoices` is 0 in every profile, including after a plan 429 | 1 | everything swept |
| `planHiddenUsd` is ~98% of spend: almost all of it is invisible to the ledger it spends by | 1 | everything swept |
| The default tiers are **not a cost ladder** — escalating a tier makes a turn *cheaper* | 2, **11** | **published list prices, no simulation** |
| The shipped **`standard` tier is dominated by `heavy`**: cheaper *and* more capable, so no request justifies it | **11** | published prices + AA Intelligence Index |
| Cheapest-in-tier means the strongest model is never chosen, in any profile | 2 | — |
| At realistic context, **switching costs ~half of a long session's spend** (50.2% of it; $24.94 after r16 corrected r4's $34.26) | 4, **16** | ±20pt fleet jitter (r7), traffic constants (r5) |
| A profile that never changes model still pays 14 cold starts, all `thinking-change` | 4 | — |
| ~~Never switching *also* wins on quality~~ | 4 | **WITHDRAWN in r19.** It was an artefact of starting the session on the strongest model. Averaged over starting points, routing wins 65.8% to 41.7%. |
| **Routing's value is insensitive to the starting model** (5pp spread across six starts); not routing varies by **45pp** and simply inherits whatever it began on | **19** | every fleet model as a start |
| Fan-out costs 2.9× more per extra solve at realistic context ($4.94 → $14.28) | 4 | traffic constants (r5) |
| Candidate selection is worth **~+15pp** when the judge is good | 3 | traffic constants (r5) |
| **~20 points of judge bias makes fan-out worse than not running it** | 3 | 5 seeds × 3 widths |
| Random judge error is far more forgiving than systematic bias; noise partly cancels bias | 3 | 5 seeds |
| The shipped **confidence gate does not defend against bias** — a biased judge is confidently wrong | 8 | 5 seeds × 3 bias levels |
| The **shipped candidate set is the worst of five**: `tier-top` gets +21.7pp for 40% of the spend and is bias-immune | 9 | 5 seeds; bias-immunity is model-dependent |
| The fan-out's fragility to bias is the **tier price inversion** (r2) propagating into `pickParallelModels` | 9 | fleet prices |
| The shipped routing confidence bar (0.50) is **nearly inert** — 1 turn in 60 falls below it | **12** | both packs |
| Raising that bar is **stickiness, not safety**: at 0.80 the session freezes on one model for 51 of 60 turns | **12** | both packs |
| A perfect classifier still lands in the wrong tier, because a `/model` pin outlives the turn it was for | **12** | — |
| **Fan-out as *exploration* is ~20× more cost-effective than fanning out every turn**: +21.3pp for $0.81/solve vs $16.03 | **13** | 5 seeds |
| …but commitment **amplifies** judge bias: at 20 points, every explore depth is worse than not fanning out at all | **13** | 5 seeds |
| **The router's quality depends on your billing, not your work**: same config, same tasks, 86.7% → 68.3% when models stop being free | **14** | isolates one variable |
| On a plan, "never switch" is free and best; **off a plan it is the most expensive option** (2× the router's spend) | **14** | both packs |
| The shipped `manualPinTurns: 3` leaves **7 of 12 pinned turns in the wrong tier**, costing 10pp of session success | **15** | long pack |
| **A `/model` pin to a small-context model forces pi to compact**, discarding the conversation to serve a one-line request | **16** | pi's own `shouldCompact` |
| Every compaction in the pack was **avoidable by routing**: a roomier model was authed and available | **16** | fleet windows |
| Those avoidable compactions cost **5 turns of quality (8.3pp)** on top of their money and cache | **17** | penalty 6–40 pts |

**Still unmeasured, and not closeable offline:** how much presentation bias Jev's own
judging carries. `ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge` — 36 Jev
calls, no model inference, under a cent. Which of the three candidate-selection
verdicts above applies depends entirely on that number.

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
