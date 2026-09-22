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

## 0b. The tier criteria call hard questions "light", and the router cannot fix it

**What happens.** `--probe-phrasing`: twelve pairs describing the **same work twice**,
once as a question answerable in text, once as an instruction that edits files.

| | result |
| --- | ---: |
| instruction rated **heavier** than its question | **6 of 12** |
| question rated heavier than its instruction | **0 of 12** |
| mean tier gap | **+0.83 tiers** |
| reached the correct tier: question / instruction | **33.3% / 66.7%** |

On heavy work asked as a question, Jev says *light* **4 times in 6, at mean confidence
0.87** - two tiers wrong at up to 98% confidence.

**Why.** Not a defect in the model. The shipped `light` criterion in `src/state.ts` reads:

> *"A small, well-specified step: **answer a factual question, explain a snippet**, rename
> or move something, write a one-line command, read or list files, simple lookups..."*

*"Why does `has_key` raise `FileNotFoundError` under concurrency?"* matches **"answer a
factual question"** textually, while the work it names - concurrency reasoning - is what
the *heavy* criterion describes. **The light criterion conflates output format with
difficulty, and Jev is following it correctly.**

**Two things this is not.** I proposed both and measured both away:

- *Not `needs_tools`.* The router never uses it - it is recorded and displayed and
  nothing else. And re-running the probe with **only** the tier question, dropping
  `needs_tools` and `stakes` from the request entirely, leaves the gap **unchanged**
  (mean gap 1.00 against 0.83, identical 33.3%/66.7% accuracy). Asking it is not the
  cause.
- *Not fixable by the stakes override.* That is the one place the router already
  overrules the classifier, and the only lever available without touching
  `src/state.ts`. It **cannot reach these turns**: of the 15 under-routed `light` turns
  on the long pack, the shipped 1.5 threshold catches **0**, because when Jev calls hard
  work light it rates the stakes low too (mean 1.03, max 1.43). It is coherently wrong on
  both axes, not conflicted. `--sweep override` confirms it across five variants - tier
  accuracy and session success move **under 2pp** between turning the override off
  entirely and widening it to two steps at a lower threshold.

### What to do

**Change the criteria text, because nothing downstream of it works.** Specifically:

1. **Take output format out of the `light` criterion.** "Answer a factual question,
   explain a snippet" should be qualified to mean questions whose answer is already known
   or trivially looked up - not any request answerable in prose.
2. **Say in the `heavy` criterion that explaining can be as hard as doing.** It already
   names "debugging with unclear cause, security or concurrency reasoning"; it needs to
   say those stay heavy when the user asks *about* them rather than asking for a fix.
3. **Re-run `--probe-phrasing` after the edit.** 24 Jev calls, $0.00. The mean tier gap
   is the number to watch: near zero means the criteria describe difficulty rather than
   output shape.

**Do not** raise `switching.minConfidence` hoping to catch these. The errors arrive at
0.87-0.99 confidence, so a bar cannot see them, and §4 shows raising it is harmful anyway.

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

- **$33.31 of cold-start premium on a 175-turn run — 50% of routed-turn spend**, across
  68 switches. Money that bought nothing but re-reading context the model already had.
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

**`switching.minConfidence: 0.5` should be *lowered*, not raised.** This reverses what
this section said before round 35, and the reason is that the earlier recommendation was
built on hand-written confidences rather than Jev's own.

Against Jev's real confidences the bar suppresses **48 of 160 routed turns — 30% — and
27 of those were classified correctly.** Lowering it to 0 raises landed tier accuracy
from **65.7% to 74.3%** and turn success from 64.6% to 68.0%, for $4.79.

The cause is visible in `--calibration`: Jev is **systematically under-confident by
13.1pp**. Every confidence bucket's observed accuracy exceeds its stated confidence, most
starkly at the bottom — in the 0.00–0.50 band it states 32.3% and is right **56.3%** of
the time. A bar that treats Jev's stated confidence as honest therefore discards good
routes. Discrimination is healthy (+31.4pp), so the signal is real; it is the *level*
that is mis-set. The bar remains a stickiness mechanism rather than a safety one: raising
it to 0.80 drops landed accuracy to 46.3%.

**`switching.manualPinTurns: 3` is not a free convenience.** It holds 15 of 175 turns and
**9 of those run in the wrong tier** — served by a model the operator chose for a
different question. It costs **3.4pp of landed tier accuracy and 5.1pp of session
success** against a one-turn pin. Worse, a pin to a small-context model **forces pi to compact**: three of the
pack's compactions are pin-induced, discarding a 200k conversation down to 22k to answer
"show me the diff".

**Recommendation.** `minConfidence: 0` — or better, recalibrate: Jev's stated confidence
maps to roughly 13 points more true accuracy than it claims, so a bar set on the raw
number sits about 13 points too high. `manualPinTurns: 1` — respect the operator's
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
cheaper**, **2.8× less added wall-clock**, and immune to a *price*-axis bias. The shipped
set is slowest because `tiers.standard[0]` is `gpt-6-astra`, which has the worst
time-to-first-token in the fleet; a fan-out waits on its slowest member, since
`src/parallel.ts` runs candidates in parallel.

**But that immunity is axis-specific, and the axis has not been measured.**
`--sweep axis` biases the judge by *length* instead of by price. `tier-top` goes from
**+26.9pp to −7.3pp** — worse than the shipped set — because its most verbose member is
its *weakest*. Only one set stays robust on both axes:

| candidate set | weakest member | clean | price-biased | length-biased |
| --- | ---: | ---: | ---: | ---: |
| `strongest` | **skill 74** | +30.3pp | **+30.9pp** | **+26.9pp** |
| `spread` | skill 46 | +30.4pp | +27.4pp | +12.6pp |
| `shipped` | skill 46 | +25.6pp | +9.7pp | +13.8pp |
| `tier-top` | skill 46 | +26.9pp | +26.9pp | **−7.3pp** |

**The design rule is the floor, not an alignment.** `strongest` is robust *without* being
aligned with the bias on the length axis — because its weakest member is still a capable
model, so it does not matter much which one a biased judge picks. Aligning the flashiest
candidate with the strongest only works against a bias you have already measured; raising
the floor works against a bias you have not.

### The decision: use `tier-top`

The bias question is settled (§6: **no detectable bias on either axis**), so the floor
argument can be priced rather than argued. A high floor is insurance against the judge
picking wrongly *for any reason* - bias or plain noise - so the question is how much
noise there actually is, and what the insurance costs at that level.

**Jev's judging noise is low.** On the probe it scored **42 of 42** on every item where
quality genuinely differs, in both label orders, including traps with gaps as narrow as
8 skill points. A simulated judge matches that only at **noise <= 5**; by noise 25 it is
down to 94.8%.

**At that operating point the floor buys nothing, and costs a great deal** (bias 0, mean
of 5 seeds, long pack):

| candidate set | floor | noise 0 | noise 10 | noise 25 | noise 40 | fan-out $ | added wall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **`tier-top`** | 46 | **31.4pp** | **31.4pp** | 27.1pp | 20.1pp | **$141** | **20 min** |
| `spread` | 46 | 35.4pp | 35.0pp | 32.7pp | 27.1pp | $290 | 56 min |
| `strongest` | **74** | 35.4pp | 34.9pp | 31.9pp | **30.7pp** | $589 | 58 min |
| `shipped` | 46 | 31.4pp | 30.2pp | 26.2pp | 22.7pp | $361 | 58 min |

The floor only earns its keep from **noise 25 upward**, where `strongest` pulls 10.6pp
ahead of `tier-top`. Jev is at <= 5. There, `strongest` is worth **+3.5pp for +$448 and
+38 minutes per 175 turns** - and 3.5pp is well inside what this pack can resolve (see
"Read this first": 0 of 5 quality comparisons resolve at 95%, while cost and wall-clock
differences all do).

> **Use `tier-top`** - the model the router itself prefers in each tier. It is the
> cheapest and fastest of the sets that work, and its quality deficit against the best is
> smaller than the pack can measure.

**What would change this.** Re-run `--probe --live-judge` (48 calls, $0.00) when the
judge model changes. If it comes back with **bias above ~10 points**, or if its accuracy
on non-tie items drops below ~95% (implying noise above ~25), switch to `strongest` and
pay for the floor. Those are the two triggers; nothing else in this section should move
the decision.

**Also do not ship the shipped set.** `shipped` is dominated outright - `tier-top` beats
it on quality at every noise level, for 39% of the money and 35% of the wall-clock.

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

## 6. The measurement that decides §5 — **taken, 2026-09-23**

**Jev carries no detectable presentation or length bias, and §5 resolves in favour of
`tier-top`.**

`ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge`, 48 calls via the Vercel AI
Gateway, **$0.00 actually spent** (credits $5.00 → $5.00, `total_used` 0 → 0; the gateway
serves `typesafe-ai/jev` on system credentials at `cost: "0"`, market value ≈$0.000012 a
call).

| | result |
| --- | ---: |
| accuracy, all 48 presentations | **95.8%** |
| aligned control | **100%** |
| **presentation**-trap rate | **0.0%** (0 of 32) |
| **length**-trap rate | **3.1%** (1 of 32) |
| estimated bias, both axes | **0 points** |
| dominant axis | **none** |
| position bias | 4.2% |
| mean confidence | 88.3% |

Every one of the 12 traps, 3 aligned controls and 6 axis-splits was answered correctly in
**both** label orders — 42 for 42 on items where quality genuinely differs. The only two
errors are on `near-tie` items whose responses differ by one and two skill points, where
there is nothing to choose; both took the second-listed answer, which is what the 4.2%
position bias is.

**Read `0` as "below this probe's resolution", not as "exactly zero".** The probe
recovers an injected bias to within about 6–8 points, so the honest claim is **under ~6
points**. That is comfortably inside the safe zone: round 3's sweep shows the candidate
lift is essentially undamaged below 10 points and only turns negative around 20.

### What that decides

With no bias to defend against, there is no robustness premium worth paying, so the
`tier-top`-versus-`strongest` choice collapses to cost and latency:

| candidate set | lift at bias 0 | fan-out $ | added wall-clock |
| --- | ---: | ---: | ---: |
| **`tier-top`** | +26.9pp | **$140.58** | **+25%** |
| `strongest` | +30.3pp | $588.71 | +70% |

The 3.4pp quality difference is **not resolvable on this pack** (0 of 5 quality
comparisons resolve at 95%); the **$448 and the 45 points of wall-clock are** (5 of 5
cost and wall-clock comparisons resolve). **Prefer `tier-top`.**

Re-run the probe if the judge model changes, or before relying on this for a materially
different task mix — it is one reading of one model on one pack, and it costs nothing.

---

## 7. Two things the live run turned up on the way

**The gateway's 429 message is misleading, and it triggers the §0 bug for real.**
The gateway replies *"The upstream provider is currently experiencing high demand"* to
what is actually a **per-key rate limit** — 30 requests per 15 seconds, visible only in
`x-ratelimit-remaining-requests: 0` and `retry-after: 15`.

`src/jev.ts` only honours a `retry-after` **shorter than its 4-second timeout**
(`retryAfter * 1000 < this.cfg.timeoutMs`), so a `retry-after: 15` is never waited on and
the call fails. The router then falls through to `heuristicTier` — whose confidence is
always below `minConfidence` — which takes the §0 branch that keeps the current model
**without checking `ledger.isBlocked`**.

So a gateway rate limit makes the router stop routing *and* stop avoiding blocked
providers, at the same time. §0 is no longer a hypothetical reachable only by an unusual
starting model: **this is the condition that reaches it in normal operation.**

**Jev is free on this route.** The gateway reports `cost: "0"` with
`credentialType: "system"`, so the classifier's overhead measured in round 24 at ~20 parts
per million of spend is, on the gateway path today, **zero**. The scripted cost model
prices it at the TypeSafe list rate instead, so it slightly *over*states routing
overhead — in the safe direction, and by an amount too small to matter.

---

## 8. How §6 was measured, and what is still outstanding

Everything in §5 was a bet on Jev's judging being unbiased. §6 settles that;
`--sweep assumptions` explains why it mattered so much: with fan-out off, no judge
assumption moves the outcome at all; turn fan-out on and **judge bias becomes the single
loudest input (±26.7pp)**, while the starting model and the fleet's declared competence
fall to ±1.7pp each. Running several candidates absorbs a bad starting point and a wrong
guess about who is good at what — and replaces both with a bet on the judge.

```bash
ROUTER_EVAL_LIVE=1 npm run eval -- --probe --live-judge   # taken; see §6
```

48 Jev calls, **no model inference**, and $0.00 as it turned out. It shows Jev 24 pairs of written
answers whose true quality is declared and whose presentation is deliberately opposed,
in both label orders, and reports the bias in the same units `--sweep bias` prices. The
probe is calibrated: it recovers an injected bias to within 8 points.

**It also reports which *axis* the bias runs on**, which after round 29 is the half that
decides what to do. Six `axis-split` items set length against presentation — three where
the worse answer is long and plain, three where it is short and heavily formatted —
because in every other item the flashier answer is also the longer one. The report ends
with a `dominant axis` line and the consequence:

| Jev's dominant axis | what to prefer |
| --- | --- |
| **presentation** | `tier-top` — cheap, fast, and its costliest-looking member is its strongest |
| **length** | `strongest` — alignment will not help; only a high floor survives |
| **none** ← *what it returned* | either; choose on cost and latency |

Read against `--sweep bias`, the measured **under ~6 points** puts §5 in the top row:

| Jev probes at | what §5 is worth |
| --- | --- |
| **≤10 points** | **the full effect** |
| ~20 points | roughly zero, and the fan-out bill is pure loss |
| ≥40 points | **negative** — worse than not fanning out |

### Still outstanding

`ROUTER_EVAL_LIVE=1 npm run eval -- --classifier live --record` replaces the
hand-written classifier answers in the task packs with what Jev actually says, removing
the standing asterisk on every `scripted` number. It needs ~206 Jev calls rather than 48
and, at the gateway's 30-per-15-seconds limit, roughly three minutes of wall-clock. Not
run here: the authorisation was scoped to the judge probe.

---

## What would make the quality half measurable

Not a bigger fixture — round 22 tested that. It needs real tasks executed by real models:
the oracle's declared `skill` replaced by what a model actually did. That is a different
and much larger harness, and this one is built so its pieces (the router loop, the
ledger accounting, the cache and compaction model, the judge probe, the sweeps, the
paired bootstrap) would carry over to it.
