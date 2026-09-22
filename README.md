# pi-modelrouter

A [pi](https://github.com/earendil-works/pi) extension that routes every turn to the right-sized model, using
[TypeSafe AI's Jev](https://docs.typesafe.ai) as a fast, cheap classifier, and supports N-way parallel responses.

- **Routing**: one Jev call per turn (a few hundred input tokens, output is free) classifies the request into
  `light | standard | heavy`, plus `needs_tools` and `stakes`. Code then picks the cheapest authed model in that tier.
- **Billing eligibility**: every candidate is assessed before it can be picked. The router separates *what pays*
  (`subscription`, `extra-credits`, `pay-per-token`, `free`) from *how well that is established*
  (`verified`, `stale`, `assumed`, `unverified`), and only a verified subscription-backed route is `preferred`.
  Extra billed usage and unverified plans are reachable only where the config names them.
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
    "anthropic/*": { "billing": "plan" },
    "openai-codex/*": { "billing": "plan" },
    "openrouter/*": { "billing": "on-demand" }
  },
  "plan": { "utilizationCeiling": 0.85, "cooldownMinutesOn429": 30 },
  "billing": {
    "preferVerifiedSubscription": true,
    "allowUnverifiedSubscription": true,
    "allowExtraBilled": ["openai-codex/*"],
    "requireVerifiedExtraBilled": true,
    "allowPayPerToken": ["openrouter/*", "vercel-ai-gateway/*", "ds4/*"],
    "denyPaid": ["xai/*", "anthropic/*"],
    "evidenceMaxAgeMinutes": 30,
    "probe": { "enabled": true, "timeoutMs": 4000, "minIntervalMinutes": 30 }
  },
  "scopes": { "claude-bridge:7d_oi": ["*/claude-fable-*"] },
  "switching": { "minConfidence": 0.5, "cacheSwitchPenalty": true, "manualPinTurns": 3 },
  "parallel": { "defaultN": 2, "judge": "jev", "autoAdopt": false, "switchToWinner": false }
}
```

Billing labels: an explicit `models` override wins; otherwise zero-cost models are `free`, OAuth providers are
`plan`, everything else is `on-demand`. **A label is not evidence.** It decides which billing question gets asked;
live quota headers and the read-only usage endpoints in `src/entitlement.ts` decide the answer.

### Billing policy

| Key | Effect |
| --- | --- |
| `preferVerifiedSubscription` | Rank verified subscription-backed routes above every billed route, regardless of price |
| `allowUnverifiedSubscription` | Keep a `plan`-labelled route usable while its backing is still unverified (it is never *preferred*) |
| `allowExtraBilled` | Model globs that may spend credits **after** their subscription window is exhausted |
| `requireVerifiedExtraBilled` | Refuse extra billed usage unless live credit evidence says credits exist |
| `allowPayPerToken` | Model globs that may bill per token. Not `["*"]`: a route that costs money is reachable only where it is named |
| `denyPaid` | Model globs that must never receive paid inference, whatever else allows them |
| `evidenceMaxAgeMinutes` | Evidence older than this is `stale`, not `verified` |
| `probe` | Read-only entitlement polling. Never touches an inference endpoint |

`scopes` maps a provider's model-scoped limit window (`"<providerGlob>:<windowId>"`) to the models it governs, so an
exhausted Fable weekly bucket excludes Fable while the same credential keeps serving Opus. Window ids are the ones
the provider uses on the wire (`5h`, `7d`, `7d_oi`, `primary`, `secondary`, `<family>:primary`).

`entitlement` maps a provider to its read-only usage endpoint. The shipped entries are Anthropic's
`/api/oauth/usage`, Codex's `/wham/usage`, OpenRouter's `/api/v1/key` and the Vercel gateway credit balance. A probe
that cannot authenticate is recorded as a failed probe — the route then stays `unverified`, which routing discloses
rather than guessing either way.

## Commands

| Command | What it does |
| --- | --- |
| `/router` | Status card: tiers, auth, billing basis per route, quota, session spend, last decision |
| `/router explain` | Candidates, billing basis, evidence and uncertainty behind the last decision |
| `/router billing` | Refreshes entitlement evidence, then shows what pays for each configured route |
| `/router on` / `off` / `reload` | Toggle routing, reload config |
| `/duo <prompt>` / `/trio <prompt>` | 2 or 3 parallel responses |
| `/par [N] <prompt>` | N parallel responses (2..8) |

The parallel commands share routing's gate: a model that routing would refuse cannot be fanned out to, and while
routing is off they refuse outright (`parallel.requireRoutingEnabled`).

## Development

```bash
npm install
npm run check          # tsc
npm test               # node --test (router, billing, entitlement, ledger, parallel, config)
npm run smoke          # end-to-end on pi's faux provider: no tokens spent
npm run smoke:billing  # same, with a denyPaid rule that must keep the router off the cheap model
```

`npm run smoke` routes a light prompt to `faux/b`; `npm run smoke:billing` adds `denyPaid: ["faux/b"]` and must
answer from `faux/a` instead. The difference between the two is the billing gate doing its job end to end.

Verified on pi 0.85.1: `pi.setModel()` inside `before_agent_start` applies to the same turn, so the switch
happens before the first provider request. The interactive surfaces (`/router` cards, routing notifications,
`/duo` panel, Jev judge, adopt dialog, adopted message ordering) were exercised by driving pi in tmux against
the faux provider with live Jev; they are not part of the automated suite.

Research behind the defaults lives in `docs/research/` (benchmarks, operational stats, plan quotas, preference data).
