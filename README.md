# pi-modelrouter

A [pi](https://github.com/earendil-works/pi) extension that routes every turn to the right-sized model, using
[TypeSafe AI's Jev](https://docs.typesafe.ai) as a fast, cheap classifier, and supports N-way parallel responses.

- **Routing**: one Jev call per turn (a few hundred input tokens, output is free) classifies the request into
  `light | standard | heavy`, plus `needs_tools` and `stakes`. Code then picks the cheapest authed model in that tier.
- **Plan vs on-demand**: subscription (OAuth) providers cost nothing at the margin until their window fills.
  The ledger reads Anthropic and Codex quota headers and 429/402 responses and steers away from exhausted plans.
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
  "switching": { "minConfidence": 0.5, "cacheSwitchPenalty": true, "manualPinTurns": 3 },
  "parallel": { "defaultN": 2, "judge": "jev", "autoAdopt": false, "switchToWinner": false }
}
```

Billing defaults: an explicit `models` override wins; otherwise zero-cost models are `free`, OAuth providers are
`plan`, everything else is `on-demand`.

## Commands

| Command | What it does |
| --- | --- |
| `/router` | Status card: tiers, auth, plan quota, session spend, last decision |
| `/router explain` | Candidates and cost estimates behind the last decision |
| `/router on` / `off` / `reload` | Toggle routing, reload config |
| `/duo <prompt>` / `/trio <prompt>` | 2 or 3 parallel responses |
| `/par [N] <prompt>` | N parallel responses (2..8) |

## Development

```bash
npm install
npm run check   # tsc
npm test        # node --test (router, ledger, config)
npm run smoke   # end-to-end on pi's faux provider: no tokens spent
```

Verified on pi 0.85.1: `pi.setModel()` inside `before_agent_start` applies to the same turn, so the switch
happens before the first provider request. The interactive surfaces (`/router` cards, routing notifications,
`/duo` panel, Jev judge, adopt dialog, adopted message ordering) were exercised by driving pi in tmux against
the faux provider with live Jev; they are not part of the automated suite.

Research behind the defaults lives in `docs/research/` (benchmarks, operational stats, plan quotas, preference data).
