# Router eval

A repeatable, offline measurement of the model switcher on SWE-bench-style tasks.

```bash
npm run eval                                  # offline, deterministic, no network, no spend
npm run eval -- --classifier heuristic        # score the no-credential fallback
npm run eval -- --classifier oracle           # the routing ceiling
npm run eval -- --candidates 3                # candidate-selection mode: 3 responses, judge picks
npm run eval -- --help
```

Every run writes `eval/results/<timestamp>-<profile>-<git>.json` plus a
`latest-<profile>.json` the next run automatically compares against, and prints the
deltas. `--note "..."` appends a round line to [`results/log.md`](results/log.md).

Exit code is `1` when `ineligibleChoices > 0` — the router choosing a model that was
unauthed, blocked or outside the fleet is a bug, not a score.

## What it measures, and what it does not

The harness measures **the decision layer**: given a classification, which model does
the router pick, was that model eligible and affordable, what did the pick cost in
money and in cache, and did the task get done. All of that logic is imported from
`src/` and run unmodified — `chooseModel`, `heuristicTier`, `buildRoutingState`,
`Ledger`, `JevClient`, `choiceConfidence`. The harness supplies only the world.

It does **not** run real repositories or real patches. Two things are declared rather
than measured, and both live in fixtures so you can argue with them:

| Declared | Where | What it means |
| --- | --- | --- |
| Which model can do which work | `tasks/fleet.json` → `skill`, `skillByCategory` | A turn is solved when the chosen model's category-adjusted skill reaches the turn's `requiredSkill`. |
| What the classifier says | `tasks/*.json` → `turns[].jev` | The tier, confidence, `needs_tools` and `stakes` a calibrated classifier is expected to return, written against the criteria in `src/state.ts`. |

So an offline number is a statement about **routing policy under a stated model of
competence**, not about Claude or GPT. `--classifier live` replaces the second
declaration with a real Jev call; nothing yet replaces the first.

## Modes

| `--classifier` | Source of the tier | Network |
| --- | --- | --- |
| `scripted` (default) | the fixture's `turns[].jev`; `fail: true` models an outage and falls through to the heuristic, exactly as `src/index.ts` does | none |
| `heuristic` | `src/router.ts#heuristicTier`, the real zero-cost fallback | none |
| `oracle` | always the fixture's `goldTier` at confidence 1 — the ceiling a perfect classifier reaches | none |
| `live` | a real Jev call through `src/jev.ts` | **yes, and it is billed** |

Live mode needs both `--classifier live` and `ROUTER_EVAL_LIVE=1`; either one alone
refuses to run. Nothing else in the harness can reach a network: the offline fleet's
registry throws if anything calls `complete()`, and every provider id starts `faux-`.

## The turn loop

One task is one pi session. Each turn reproduces `before_agent_start` from
`src/index.ts`, in order:

```
turn++ → manual-pin check → buildRoutingState → classify → stakes override (≥1.5 lifts light to standard)
       → chooseModel → setModel → thinking level → record usage in the Ledger
```

A pinned turn returns before the classifier call, so it costs nothing to route — the
harness books that the same way. One `Ledger` serves the whole run, because plan
quota and 429 cooldowns are account facts that outlive a session: a 429 in one task
still steers the next.

## Cost and cache

Token counts come from the traffic profile measured in the cache-cost study: ~5
provider calls per user turn, ~650 newly cached tokens per call, ~550 output tokens
per call, and a ~100% prefix hit rate while the model and thinking level hold still.
A turn goes **cold** — the whole prefix is re-written instead of read — on the first
turn of a session, on a model switch, **or on a thinking-level change**, which is the
invalidation Anthropic documents and the study measured on this machine.

Two cost numbers are reported side by side, and the gap between them is the point:

- `ledgerCostUsd` — what `src/ledger.ts` sees. Subscription routes report **$0**.
- `listEquivalentUsd` — what the same tokens are worth at list price, whoever pays.
- `planHiddenUsd` — the difference: spend the router makes but cannot see.

Fan-out candidates are priced differently on purpose. `src/parallel.ts` calls
`complete` with `cacheRetention: "none"` and a fresh `sessionId`, so each candidate
pays the **full uncached input rate once** and leaves the session's own cache alone.

## Metrics

| Metric | Reading |
| --- | --- |
| `taskResolveRate` | tasks where every turn was solved |
| `turnSuccessRate` | turns solved |
| `tierAccuracy` / `underRouteRate` / `overRouteRate` | chosen tier vs `goldTier`; the three always sum to 1 |
| `underRouteFailures` | turns that failed *because* the tier was too low |
| `inTierMisses` | turns that failed with the **right** tier, where another model in that tier would have solved them — the switcher's own miss |
| `ineligibleChoices` | must be 0; anything else is a routing bug |
| `heuristicFallbacks` | turns the classifier could not serve |
| `planHiddenUsd` | subscription spend invisible to the ledger |
| `listUsdPerResolvedTask` | quality and spend in one number |
| `coldTurns`, `coldByCause`, `coldPremiumUsd` | cache consequence; `coldPremiumUsd` is exact, each turn is priced cold and warm |

Candidate mode adds `baselineSuccessRate` (the routed model alone),
`judgeSuccessRate` (the judge's pick), `oracleSuccessRate` (the best candidate — the
ceiling), `judgeLift`, `judgeHeadroomCaptured`, `judgeRecall`, `judgeRegressions`,
and `listUsdPerExtraSolve`.

The candidate set is chosen by the **same policy** as `src/parallel.ts`, and the judge
question is the **same string** it sends to Jev. `test/eval.test.ts` pins both against
that file, so if the shipped fan-out changes, the harness fails rather than drifts.

The offline judge (`NoisyJudge`) perceives each candidate's true skill with a bounded
error — `--judge-noise` is that error's half-width in skill points — so it is reliably
right about large quality gaps and near a coin flip on small ones. It is a stand-in
for Jev, not a simulation of it.

## Files

| Path | What |
| --- | --- |
| `cli.ts` | `npm run eval`: flags, table, results file, deltas |
| `harness.ts` | the turn loop |
| `classifier.ts` | the four classifier modes + the stakes override |
| `candidates.ts` | candidate policy, judges, the pinned judge question |
| `fleet.ts` | fleet JSON → `ModelRegistry` + `RouterConfig` |
| `simulate.ts` | the competence oracle and the token/cost model |
| `metrics.ts` | the metric set and how to read each direction |
| `results.ts` | results IO, the round log, run comparison |
| `session.ts` | the fake `ExtensionContext` `buildRoutingState` needs |
| `tasks/` | the fleet and the task pack |
| `results/` | one JSON per run, `latest-<profile>.json`, `log.md` |
