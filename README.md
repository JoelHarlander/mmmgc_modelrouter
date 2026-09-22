# pi-modelrouter

A [pi](https://github.com/earendil-works/pi) extension that routes every turn to the right-sized model, using
[TypeSafe AI's Jev](https://docs.typesafe.ai) as a fast, cheap classifier, and supports N-way parallel responses.

- **Routing**: one Jev call per turn (a few hundred input tokens, output is free) classifies the request into
  `light | standard | heavy`, plus `needs_tools` and `stakes`. Code then picks the cheapest authed model in that tier.
- **Billing eligibility**: every candidate is assessed before it can be picked. The router separates *what pays*
  (`subscription`, `extra-credits`, `pay-per-token`, `free`) from *how well that is established*
  (`verified`, `stale`, `unverified`), and only a verified subscription-backed route is `preferred`.
  Paid routes are ordered, not banned: included usage first, then the account's own credits, then per-token
  billing — so when the subscription really is used up the turn still runs, and the explanation says what paid.
- **Plan vs on-demand**: subscription (OAuth) providers cost nothing at the margin until their window fills.
  The ledger reads Anthropic and Codex quota headers and 429/402 responses, polls the providers' read-only usage
  endpoints, and steers away from exhausted plans — per model, not just per provider.
- **Cache-aware switching**: leaving a model with a warm prompt cache is charged as a context re-read.
- **Manual override wins**: `/model` pins your choice for `switching.manualPinTurns` turns.
- **Parallel**: `/duo`, `/trio`, `/par N <prompt>` fan the same conversation out to N models in-process, show
  timings and cost, let Jev pick the best answer, and let you adopt one into the session.

## Install

```bash
pi install /Users/j/Documents/code/jez_modelrouter
```

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
`src/config.ts`. Model ids are `provider/modelId` exactly as `pi --list-models` shows them.

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
is really spent (the ChatGPT overflow), and last ordinary per-token billing — paid Anthropic and xAI included. A
route is excluded only when it cannot serve the turn: no auth, a cooldown, or a spent window or balance with no
paid path behind it.

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
that the credential's next successful answer clears. A refusal that carries no quota evidence at all — no window
headers and no `retry-after` — is Anthropic's entitlement gate rather than quota pressure
(docs/research/plan-quotas.md §1) and is not recorded: backing a healthy subscription off itself on evidence the
provider never gave would also route away from the only credential that could clear it. While it stands it excludes every route on that credential
whatever pays for them: a credential refusing calls is not a spent subscription window, so extra billed credits are
never a way around it. And when a provider reports a spent
meter that names no route your config can reach, the router neither ignores it nor calls the whole credential
spent — it carries it as uncertainty on every route of that provider and stops calling those verdicts `verified`.

Quota is a fact about a credential, not about a provider id. `entitlement.<provider>.authProvider` names the
credential a provider id routes on — `claude-bridge` routes on `anthropic`'s — and one account is worth one
read-only probe per interval, not one per id. Sharing the *quota* takes more than the declaration: the two ids
must also present the same credential in pi's own auth evidence. When they do, one set of windows serves both and
a refusal seen through either excludes the routes of both; when the evidence differs or pi knows of no credential
for one of them, the provider keeps its own quota, so a spent subscription never excludes a route billed on a
different credential — which is exactly when the paid overflow is needed.

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
| `/router` | Status card: tiers, auth, billing basis per route, quota, session spend, last decision |
| `/router explain` | Candidates, billing basis, evidence and uncertainty behind the last decision |
| `/router billing` | Refreshes entitlement evidence, then shows what pays for each configured route |
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
npm test               # node --test (router, billing, entitlement, ledger, parallel, config)
npm run smoke          # end-to-end on pi's faux provider: no tokens spent
npm run smoke:billing  # same, with a spend gate that must keep the router off the cheap model
```

`npm run smoke` routes a light prompt to the billed `faux/b`, which its global fixture names in `allowPayPerToken`;
`npm run smoke:billing` names only `faux/a` there, so `faux/b` is not a route that may bill and the answer comes
from `faux/a` instead. The difference between the two is the billing gate doing its job end to end.

Verified on pi 0.85.1: `pi.setModel()` inside `before_agent_start` applies to the same turn, so the switch
happens before the first provider request. The interactive surfaces (`/router` cards, routing notifications,
`/duo` panel, Jev judge, adopt dialog, adopted message ordering) were exercised by driving pi in tmux against
the faux provider with live Jev; they are not part of the automated suite.

Research behind the defaults lives in `docs/research/` (benchmarks, operational stats, plan quotas, preference data).
