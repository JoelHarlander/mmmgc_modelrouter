# Router eval rounds

One entry per round: what it measured, what it changed, what the numbers did.
Runs are reproduced with `npm run eval -- <flags>`; the JSON for each is in this directory.

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
