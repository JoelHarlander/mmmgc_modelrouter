# pi-modelrouter

A [pi](https://github.com/earendil-works/pi) extension that routes every turn to the right-sized model, using
[TypeSafe AI's Jev](https://docs.typesafe.ai) as a fast, cheap classifier, and supports N-way parallel responses.

- **Routing**: one Jev call per turn (a few hundred input tokens, output is free) classifies the request into
  `light | standard | heavy`, plus `needs_tools` and `stakes`. Code then picks the best-ranked billing-eligible
  model in that tier, cheapest first within a rank.
- **Billing eligibility**: every candidate is assessed before it can be picked. The router separates *what pays*
  (`subscription`, `extra-credits`, `pay-per-token`, `free`) from *how well that is established*
  (`verified`, `stale`, `unverified`), and only a verified subscription-backed route — or a zero-cost one — is
  `preferred`. Paid routes are ordered, not banned: included usage first, then the account's own credits, then per-token
  billing — so when the subscription really is used up the turn still runs, and the explanation says what paid.
- **Plan vs on-demand**: subscription (OAuth) providers cost nothing at the margin until their window fills.
  The ledger reads Anthropic and Codex quota headers and 429/402 responses, polls the providers' read-only usage
  endpoints, and steers away from exhausted plans — per model, not just per provider.
- **Cache-aware switching**: leaving a model with a warm prompt cache is charged as a context re-read.
- **Manual override wins**: `/model` pins your choice for `switching.manualPinTurns` turns. The pin is honoured
  whatever pays for it, but the status line names the basis and a pin nothing may bill says so.
- **Parallel**: `/duo`, `/trio`, `/par N <prompt>` fan the same conversation out to N models in-process, show
  timings and cost, let Jev pick the best answer, and let you adopt one into the session.

## Install

Stable (the `main` branch, which is what an unqualified install follows):

```bash
pi install git:github.com/JoelHarlander/mmmgc_modelrouter
```

Dev — the integration channel, where changes land before they are promoted:

```bash
pi install git:github.com/JoelHarlander/mmmgc_modelrouter@dev
```

The `@<ref>` suffix is pi's own source syntax (`pi install --help`); pi clones into
`~/.pi/agent/git/github.com/JoelHarlander/mmmgc_modelrouter` and records the entry, ref and all, in
`~/.pi/agent/settings.json` under `packages`. Installing again with a different ref **rewrites that
one entry** rather than adding a second, because pi matches a package by repository and ignores the
ref when doing so — so `pi install …@dev` and `pi install …@main` are how you switch channels.

| You want | Command |
| --- | --- |
| Track dev | `pi install git:github.com/JoelHarlander/mmmgc_modelrouter@dev` |
| Go back to stable | `pi install git:github.com/JoelHarlander/mmmgc_modelrouter@main` |
| Pin one release | `pi install git:github.com/JoelHarlander/mmmgc_modelrouter@v0.2.0` |
| See where you are | `/router update` inside pi |

Use `@main` to return to stable, not the bare form. Dropping the ref rewrites the settings entry,
but the existing clone keeps the upstream branch it was checked out on, so pi would go on following
dev while settings say otherwise. `@main` moves both. (A bare install into a *fresh* clone is fine;
it is only switching back in place that needs the explicit ref.)

Channels, what the versions mean, and how a release is cut: [docs/RELEASING.md](docs/RELEASING.md).

## Updating

pi owns updating. `pi update <source>` — or `pi update --extensions` for every installed package —
re-fetches the ref the settings entry names and hard-resets the clone to it:

```bash
pi update git:github.com/JoelHarlander/mmmgc_modelrouter
```

The ref comes from settings, not from what you type, so `pi update` can never change your channel;
only `pi install …@<ref>` does. A branch ref moves with the branch each time you update. A ref that
names one commit — a tag or a SHA — is a pin: the same fetch lands on the same commit, so an
install pinned to `@v0.2.0` stays there until you install another ref.

One consequence of tracking a channel explicitly: pi's startup "updates available" notice skips
ref-qualified entries, so it goes quiet once you are on `@dev` or `@main`. That is the gap
`/router update` fills. It is the only part of the router that talks to the forge, it runs only when
you type it, and it changes nothing — it reads the installed clone and pi's settings, then asks the
remote for the tip of your ref with `git ls-remote`:

```
[router update]
release: 0.3.0-dev (dev)  1a2b3c4  tracking git:github.com/JoelHarlander/mmmgc_modelrouter@dev
remote dev: 9f8e7d6 — differs from the installed 1a2b3c4; pi update moves this install to it
update on this channel:  pi update git:github.com/JoelHarlander/mmmgc_modelrouter@dev
switch to dev:           pi install git:github.com/JoelHarlander/mmmgc_modelrouter@dev
switch to stable:        pi install git:github.com/JoelHarlander/mmmgc_modelrouter@main
```

Offline, or with the remote unreachable, the local lines still print and the remote line says which
part failed. The channel also shows in `/router` and, while you are on a non-stable one, as a `·dev`
mark on the status line — it is read from the version in `package.json`, which travels with the
code, rather than from the clone's branch label, which pi's reset leaves pointing at whatever was
cloned first.

Jev needs one credential, resolved in this order (`jev.transport: "auto"`):

1. `TYPESAFE_API_KEY` (or `jev.apiKey`): direct to `api.typesafe.ai`, model `jev-latest`.
2. A Vercel AI Gateway key: `AI_GATEWAY_API_KEY`, `jev.gatewayApiKey`, or the `vercel-ai-gateway` entry pi already
   stores in `~/.pi/agent/auth.json`. Calls go to the gateway's TypeSafe-compatible surface
   (`https://ai-gateway.vercel.sh/typesafe/v1/systemone`) as model `typesafe-ai/jev`, billed to gateway credits, and
   the per-call cost from the gateway metadata is recorded in the ledger.

The easiest path is the gateway one, which also unlocks its catalog as on-demand candidates:

```bash
npx vercel ai-gateway setup --agent pi
```

The Vercel team needs a credit card on file before the gateway serves any request (it returns
`customer_verification_required` otherwise). Without any Jev credential the router falls back to a low-confidence
heuristic, which by default keeps the current model.

## Configure

`~/.pi/agent/modelrouter.json` (global) and `<project>/.pi/modelrouter.json` (project) are merged over the defaults in
`src/config.ts`. Model ids are `provider/modelId` exactly as `pi --list-models` shows them. The JSON is the source of
truth: edit it by hand, or choose tiers interactively with `/router models`, which edits the same global file.

### Choosing models: `/router models`

`/router models` opens a picker listing the models pi itself offers: its enabled set (`enabledModels` or `--models`)
when you have one, otherwise every catalog model pi holds a credential for (`Ctrl+A` switches to the whole
catalog). For each tier it shows the models in order, and next to every model it shows the router's own verdict:
the billing basis (`subscription`, `extra-credits`, `pay-per-token`, `free`), how well that is established
(`verified`, `stale`, `unverified`), and whether it is `preferred`, merely allowed, or `excluded` and why. It also
shows the catalog price where the basis bills per token. The highlighted model's evidence, uncertainty and known
quota are shown in full. These are the same assessments `/router billing` makes, not a second opinion.

`Enter` adds a model to the tier or removes it, `Shift+↑/↓` (or `Alt`/`Ctrl` with the arrows) reorders, `Tab` changes
tier, typing filters, `Ctrl+S` saves and `Esc` closes. Order within a tier is preference among equals: the router
still weighs billing rank, then estimated cost, then capability first, and `/duo` considers each tier's first entry
before the rest.

The picker keeps two mistakes in view, and `/router` and pi's startup repeat them:

- a tier entry the router cannot use: not in pi's catalog, no credential, or excluded by the billing gate right now;
- an eligible model pi offers that no tier names, so the router never considers it. Without an explicit enabled set
  only the untiered models that cost nothing at the margin (subscription or zero-cost) are flagged, and billed ones
  are counted, since "every model with a credential" is often a whole gateway catalog.

Saving writes **only** the tier lists you changed, and only to the global `~/.pi/agent/modelrouter.json` (the target, if
that is a symlink). Every other key, the key order, the indentation and each list's one-line or one-per-line layout
stay as they were. The file is replaced atomically, the previous copy is kept as `modelrouter.json.bak`, and a tier
changed on disk since the picker opened, or a file that is not valid JSON, is refused rather than overwritten. The
router then reloads exactly as `/router reload` does. The picker never writes a project's `.pi/modelrouter.json`, and
never writes any key but `tiers`. If a pay-per-token model you add shows `excluded: not in billing.allowPayPerToken`,
permitting that spend is a hand edit of `billing` in the global file. Where the open project's file sets a tier, the
picker says so: your global change applies everywhere else, and that project keeps its own list.

```jsonc
{
  "tiers": {
    "light": ["openrouter/z-ai/glm-5.3-flash", "vercel-ai-gateway/deepseek/deepseek-v4.1-flash"],
    "standard": ["openai-codex/gpt-6-astra", "openrouter/z-ai/glm-5.3"],
    "heavy": ["claude-bridge/claude-fable-5-1", "anthropic/claude-opus-5"]
  },
  "thinking": { "light": "low", "standard": "medium", "heavy": "high" },
  "models": {
    "claude-bridge/*": { "billing": "plan" },
    "openai-codex/*": { "billing": "plan" },
    "openrouter/*": { "billing": "on-demand" }
  },
  "plan": { "utilizationCeiling": 0.85, "cooldownMinutesOn429": 30 },
  "billing": {
    "allowExtraBilled": ["openai-codex/*"],
    "allowPayPerToken": ["openrouter/*", "vercel-ai-gateway/*", "ds4/*", "anthropic/*", "xai/*"],
    "evidenceMaxAgeMinutes": 30,
    "probe": { "enabled": true, "timeoutMs": 4000, "minIntervalMinutes": 30 }
  },
  "scopes": { "anthropic:7d_oi": ["*/claude-fable-*"] },
  "switching": { "minConfidence": 0.5, "cacheSwitchPenalty": true, "manualPinTurns": 3 },
  "parallel": { "defaultN": 2, "judge": "jev", "autoAdopt": false, "switchToWinner": false }
}
```

Billing labels: a `models` label wins wherever one matches, glob or not; only where no label claims the route does a zero catalog price make it `free`, OAuth providers are
`plan`, everything else is `on-demand`. **A label is not evidence.** It decides which billing question gets asked;
live quota headers and the read-only usage endpoints in `src/entitlement.ts` decide the answer.

Precedence, once every candidate is assessed: a verified subscription-backed route or a genuinely zero-cost one
first, then a `plan` label nothing has verified, then the account's own extra credits once its subscription window
is really spent (the ChatGPT overflow), and last ordinary per-token billing — paid Anthropic and xAI included.
Evidence orders the subscription basis against itself, never against another account: a subscription with no sign
of being spent is still included usage and comes before a different credential's credits. A route is excluded only
when it cannot serve the turn: no auth, a cooldown, or a spent window or balance with no paid path behind it.

### Billing policy

| Key | Effect |
| --- | --- |
| `allowExtraBilled` | Model globs that may spend credits **after** their subscription window is exhausted, and only on fresh credit evidence |
| `allowPayPerToken` | Model globs that may bill per token. Not `["*"]`: a route that costs money is reachable only where it is named. Naming one orders it last, it does not promote it |
| `evidenceMaxAgeMinutes` | Evidence older than this is `stale`, not `verified` — in both directions, so an ageing "no credits" fact stops excluding a route |
| `probe` | Read-only entitlement polling. Never touches an inference endpoint |

`scopes` maps a credential's model-scoped limit window (`"<providerGlob>:<windowId>"`) to the models it governs, so an
exhausted Fable weekly bucket excludes Fable while the same credential keeps serving Opus. Window ids are the ones
the provider uses on the wire (`5h`, `7d`, `7d_oi`, `primary`, `secondary`, `<model>:primary`). `scopes` is the only
place that decides which windows are model-scoped; a `<model>:<role>` window is the one case it answers without an
entry, because such ids are minted at runtime from the model the meter belongs to, so it governs that model and
never the whole credential. Codex names the meter by an opaque limit id on the wire (`x-codex-bengalfox-*`) and by
the model in the usage poll, so the header path keys the window by the `x-codex-<id>-limit-name` it comes with;
both evidence paths then name the same meter, and a later poll refreshes what a header recorded.

A scoped window speaks only for its own models: a Fable-only or overage rejection excludes the models that window
governs and nothing else, whether it arrives on a 200 or on a 429 with `retry-after`. Only the windows *that*
response reported spent can answer whose refusal it is; a window stored hours ago cannot. A refusal the response
attributes to no window of its own — or attributes only to a meter that governs no route you can reach — is the
credential's own, and is recorded as one more account-wide window — `rate limited (429)` or
`budget exhausted (402)` — that expires after the `retry-after` it came with or `plan.cooldownMinutesOn429`, and
that the credential's next successful answer clears - the clear is written whether or not the session that got
the answer ever saw the refusal, since a concurrent session may have recorded it. An `overage` rejection refuses
extra billed usage and only that, so it can never be the window that explains a refusal of included usage. A `402`
is recorded whatever it carries: payment required is the account's own answer about money, not a window's. A refusal that carries no quota evidence at all — no window
headers and no `retry-after` — is Anthropic's entitlement gate rather than quota pressure
(docs/research/plan-quotas.md §1) and is not recorded: backing a healthy subscription off itself on evidence the
provider never gave would also route away from the only credential that could clear it. While it stands it excludes every route on that credential
whatever pays for them: a credential refusing calls is not a spent subscription window, so extra billed credits are
never a way around it. And when a provider reports a spent
meter that names no route your config can reach, the router neither ignores it nor calls the whole credential
spent — it carries it as uncertainty on every route of that provider and stops calling those verdicts `verified`.

Quota is a fact about a credential, not about a provider id. `entitlement.<provider>.authProvider` names the
credential a provider id *claims* to route on — `claude-bridge` claims `anthropic`'s — and that claim is only
ever a question. The answer is pi's: the two ids are one account when pi hands out the same credential for both,
which the router compares in memory and never stores or reports. Because resolving a credential can cost an OAuth
refresh on the turn's critical path, the question is asked until it answers and only when the probe is due after
that, bounded by `billing.probe.timeoutMs` like the probe itself. Where the answer holds, the account is worth one
read-only probe per interval rather than one per id, one set of windows serves both, and a refusal seen through
either excludes the routes of both. Where it does not hold, or cannot be answered, each id keeps its own probe
and its own quota — so a spent subscription never excludes a route billed on a different
credential, which is exactly when the paid overflow is needed.

`entitlement` maps a provider to its read-only usage endpoint. The shipped entries are Anthropic's
`/api/oauth/usage`, Codex's `/wham/usage`, OpenRouter's `/api/v1/key` and the Vercel gateway credit balance. A probe
that cannot authenticate is recorded as a failed probe — the route then stays `unverified`, which routing discloses
rather than guessing either way.

A project `.pi/modelrouter.json` is read key by key against a list of what a repository may say: its tier lists,
`thinking`, `switching`, the `/duo` settings, `notifyOnSwitch`, `enabled` (off only) and `billing.probe.enabled`
(off only). Everything else — `jev`, `entitlement`,
`plan`, `models`, `scopes`, the rest of `billing`, and every key added in future — comes from the global file
alone. So a repository can pick the models it prefers and make the router stricter than you configured it, and it
can never name an endpoint a credential is sent to, assert what pays for a model, or loosen a spend safeguard.

## Commands

| Command | What it does |
| --- | --- |
| `/router` | Status card: tiers, auth, billing basis per route, eligible models in no tier, quota, session spend, last decision |
| `/router explain` | Candidates, billing basis, evidence and uncertainty behind the last decision |
| `/router billing` | Refreshes entitlement evidence, then shows what pays for each configured route |
| `/router models` | Choose and order each tier's models from what pi offers, and save them to the global config ([details](#choosing-models-router-models)) |
| `/router update` | Channel, version and commit of the running build, whether the channel has moved on, and the `pi` command that moves it |
| `/router on` / `off` / `reload` | Toggle routing, reload config |
| `/duo <prompt>` / `/trio <prompt>` | 2 or 3 parallel responses |
| `/par [N] <prompt>` | N parallel responses (2..8) |

The parallel commands share routing's gate *and* its ordering: a model that routing would refuse cannot be fanned
out to, the slots nobody named go to the best-ranked eligible candidates, and while routing is off they refuse
outright. An explicit `parallel.models` list is your own choice of what to compare, so it keeps its order — and
when a better-ranked eligible route goes unused because of it, the run says so. What the fan-out spends is
harvested like any other turn: quota headers and a 429 seen during `/duo`, `/trio` or `/par` reach the ledger.

## Development

```bash
npm install
npm run check          # tsc
npm test               # node --test (router, billing, entitlement, ledger, parallel, config, models, release)
npm run smoke          # end-to-end on pi's faux provider: no tokens spent
npm run smoke:billing  # same, with a spend gate that must keep the router off the cheap model
```

`npm run smoke` routes a light prompt to the billed `faux/b`, which its global fixture names in `allowPayPerToken`;
`npm run smoke:billing` names only `faux/a` there, so `faux/b` is not a route that may bill and the answer comes
from `faux/a` instead. The difference between the two is the billing gate doing its job end to end.

Verified on pi 0.85.1: `pi.setModel()` inside `before_agent_start` applies to the same turn, so the switch
happens before the first provider request. The interactive surfaces (`/router` cards, routing notifications,
`/duo` panel, Jev judge, adopt dialog, adopted message ordering) were exercised by driving pi in tmux against
the faux provider with live Jev; they are not part of the automated suite. The `/router models` picker is the
exception in part: `test/models.test.ts` drives its component headless with raw key sequences (add, reorder, filter,
tier switch, save, Esc) and the whole save path end to end, and its look in a real terminal was checked in tmux.

Work lands on `dev` and is promoted to `main` with `scripts/promote.sh`, which runs those four
commands as the release gate before it stamps a version and tags the commit:
[docs/RELEASING.md](docs/RELEASING.md).

Research behind the defaults lives in `docs/research/` (benchmarks, operational stats, plan quotas, preference data).
