# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Build, test, verify

`npm run check` (tsc), `npm test` (node --test over `test/*.test.ts`), then both smokes. `npm run smoke` and
`npm run smoke:billing` drive real pi against the zero-cost faux provider and must answer from `faux/b` and
`faux/a` respectively; that difference is the billing gate working end to end, so a change that makes them agree
is a regression, not a wash. Both smokes are hermetic: each sets `PI_CODING_AGENT_DIR` to its own `agent/` fixture, so the global layer is
`test/smoke*/agent/modelrouter.json` (where the `models` label and `allowPayPerToken` entry the billed route needs
must live, since a project file may not state them) and the user's real global config is never read.

## Where the rules live

- Billing policy is **data**, never hardcoded: `billing`, `entitlement` and `scopes` in `src/config.ts`. Provider
  or model names carry no billing meaning on their own — `src/billing.ts` decides eligibility from live evidence.
- `src/billing.ts` keeps three questions separate and every explanation should too: the **basis** (what pays), the
  **verification** (how well that is established), and the **eligibility** (what the config permits). Only a
  verified subscription route is `preferred`. Never let a config label stand in for evidence. `RANK` sorts evidence
  only within the subscription basis (verified before assumed); it must never put another account's credits ahead
  of a subscription nothing says is spent, or the turn spends money while included usage sits unused.
- Quota state is keyed by *credential*, not provider id, but only where that is proven. `credentialOf()` is what
  the config declares - it keys `cfg.scopes` and names the pair worth testing - while `refreshEntitlements`
  resolves both ids' credentials through pi, compares them in memory (never logged, persisted or put in the
  ledger) and tells `Ledger.linkAccount` what it found; `Ledger.accountOf` files and reads quota by that. It runs
  behind the probe gate, bounded by `billing.probe.timeoutMs` because it can cost an OAuth refresh on the turn's
  critical path, and thereafter on the probe's own interval - but a session that has no answer yet always asks,
  since the links are per-process while `probedAt` is shared, and guessing "not shared" files this account's
  windows under a second name nothing merges back. Only an answer moves a link: a lookup that resolves nothing
  leaves the last one alone, because splitting a proven account strands the windows already filed under it. Auth *type* or a config
  declaration is not proof: two ids pi resolves differently stay separate accounts, both for quota and for the
  probe, since a wrong alias removes the paid overflow at the moment it is needed while a missed one costs only a
  second probe. Ids that do share must never grow a second copy of the same account's
  windows.
- Quota window ids are the provider's own wire names (`5h`, `7d`, `7d_oi`, `primary`); a per-model meter is keyed
  `<model>:<role>` from the limit name the provider reports, which is what lets `scopeGlobs` match it with no config.
  A scoped or overage window governs its own models only. A 429/402 is attributed to the windows *that response*
  reported spent; when it names none but still bounds itself (a `retry-after`, or a meter no route answers to), the
  refusal is the credential's own and is stored as one more account-wide window (`REFUSAL_WINDOWS`) rather than a
  second kind of state. A 429 carrying no quota evidence whatsoever is the entitlement gate, not quota
  (docs/research/plan-quotas.md §1), and is recorded nowhere - a 402 is never that, since payment required is the
  credential's own answer about money and the providers that send it report no windows at all (§4, §5), so it is
  always recorded and never explained away by a window - — keep it that way, since every earlier attempt to
  hold a provider-wide cooldown beside the windows traded one wrong answer for another. An `overage` rejection refuses extra billed
  usage and only that, so it is never what places a refusal. Clearing one is an expired window carrying its own
  `lastSeen`, never a deleted key, so `mergeLedgers` can settle it, and every 2xx writes that marker whether or not
  this session held the refusal - a concurrent session's refusal would otherwise come back over the top of a
  credential that just answered. Such a refusal reaches
  `assess` as `refused`, not `exhaustedAccount`: it excludes every route on the credential whatever the basis, and
  must never be read as spent subscription quota that extra credits may cover. A spent meter that matches
  no routable model (`windowPlaceable`) is carried as uncertainty, never as account-wide exhaustion, and can never
  absorb a refusal either — a 429 whose only spent meter is unplaceable is the credential's own.
  `docs/research/plan-quotas.md` is the authority for header names, JSON shapes and value scales — note especially
  that Anthropic utilization is 0..1 in headers but 0..100 from `/api/oauth/usage`.
- `src/entitlement.ts` may only call read-only usage endpoints. Nothing here may send inference or log a credential.

## Sharp edges

- `~/.pi/agent/modelrouter/usage.json` (version 3; `readLedgerFile` upgrades 1 and 2) is shared by every concurrent pi session. `Ledger.save()` merges token
  totals as deltas against the last disk sync under a directory lock; adding a field means teaching
  `mergeLedgers` how it settles. A reader for an older file version must upgrade rather than discard, or a running
  session on the old version will erase the new one's data.
- `after_provider_response` carries only `{status, headers}`. Model-scoped attribution has to come from
  `ctx.model` at the time of the call.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
