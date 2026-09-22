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
