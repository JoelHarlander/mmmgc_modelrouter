# Research notes: TypeSafe AI (Jev) + Vercel AI Gateway + pi

Date: 2026-09-20. Sources: docs.typesafe.ai, vercel.com/docs/ai-gateway, pi 0.85.1 docs (`~/.local/share/fnm/.../@earendil-works/pi-coding-agent/docs`).

## TypeSafe AI: Jev (jev-1.13.0, alias jev-latest)

- Not an LLM. "System One" decision model: send `state` (text/JSON) + a map of typed
  questions, get calibrated probabilities + a separate `confidence` per answer.
- Primitives: `choice` (pick 1 of up to 255 options, returns full distribution),
  `score` (2–10 ordered levels, returns float score + distribution),
  `noul` (yes/no probability).
- Endpoint: `POST https://api.typesafe.ai/v1/systemone`, bearer `TYPESAFE_API_KEY`.
  Response `usage.input_tokens` / `output_tokens`, `model` = versioned id.
- Price: $0.042 per Mtok input, output free. Limits: 250k tok/s, 1,200 rpm.
  Context: 64k total, 32k for state + longest question. Text only. English best.
- All questions in one request are evaluated in parallel against the state once.
  Batching is the intended pattern ("speculative fan-out").
- Confidence for choice = (n*peak - 1)/(n-1). Docs' intent-routing pattern:
  confidence < 0.5 -> fall back / escalate. Pin the versioned model id if you tune thresholds.
- SDKs: `@typesafe-ai/sdk` (JS, retries + retry-after), `typesafe-sdk` (Python).
  `@ai-sdk/typesafe-ai` exists but uses `experimental_evaluate` from the AI SDK; heavy for our use.
- Raw API is one POST; no SDK strictly needed.

## Vercel AI Gateway

- OpenAI-compatible `https://ai-gateway.vercel.sh/v1` (also Anthropic Messages,
  Responses). Coding-agent surface: `/coding-agent/v1`. Model ids `creator/model`.
- Catalog `GET /v1/models`: 375 models. Fields: context_window, max_tokens,
  pricing.input/output (per token, string), tags (reasoning, tool-use), modalities,
  zdr/no_training, released, knowledge cutoff. Enough for a cost table.
- `vercel ai-gateway models endpoints <id>` gives per-provider TTFT, uptime, price.
- Per-request `providerOptions.gateway`: `models` (fallback chain), `order`, `only`,
  `sort` (price | ttft | throughput), `byok`, `tags`, `user`, `zeroDataRetention`.
- Cost per request: `generationId` -> `GET /v1/generation`. Spend report `/v1/report`
  (custom reporting is a paid add-on: $0.075/1k tag writes, $5/1k queries).
- Routing rules (team-wide, static): rewrite model A -> B, or deny. NOT content-aware.
- Virtual models `vmc/<slug>`: static bundle of model + provider order + fallbacks +
  fast mode + tags. Also not content-aware.
- Leaderboards = usage popularity (requests/tokens/spend), not quality benchmarks.
- Pricing: zero markup, pay-as-you-go credits. Free tier = subset of models + lower
  rate limits. BYOK needs paid tier; BYOK failures fall back to system credentials
  (billed to credits) and BYOK spend is never budget-capped.
- `npx vercel ai-gateway setup --agent pi` writes `vercel-ai-gateway` key into
  `~/.pi/agent/auth.json` (0600, .bak). Dry run for pi confirmed: only that file changes.
  Note: running the CLI performed a Vercel device login on this machine.

## pi 0.85.1 integration surface

- Built-in provider `vercel-ai-gateway` (models.generated.js, anthropic-messages API,
  baseUrl ai-gateway.vercel.sh). Appears in `--list-models` once auth.json has the key.
- Authed providers on this machine (`pi auth check`): anthropic (OAuth = Claude plan),
  openai-codex (OAuth = ChatGPT plan, via local bridge 127.0.0.1:8791), xai (OAuth),
  openrouter (OAuth key, pay-per-token), ds4 (local, free), claude-bridge.
  `settings.enabledModels` scopes the picker: gpt-6-astra, glm-5.3, glm-5.3-flash,
  grok-4.6, claude-fable-5-1, claude-opus-5.
- Extension hooks that matter:
  - `before_agent_start` (prompt, systemPrompt, systemPromptOptions) — place to classify.
  - `pi.setModel(model)` — session-level switch, recorded in history; returns false if no auth.
  - `ctx.modelRegistry.find/getAvailable/getProviderAuth`, `ctx.scopedModels`.
  - `message_end` — assistant `usage` {input, output, cacheRead, cacheWrite, reasoning, cost}.
  - `after_provider_response` — status + headers (429, retry-after; plan quota headers if passed through).
  - `model_select` — notification when model changes (source: set | cycle | restore).
  - `ctx.getContextUsage()` — context tokens (switch cost: cache loss is proportional).
  - `pi.registerProvider` — could wrap/override a provider if needed.
- Example `examples/extensions/preset.ts` shows `pi.setModel` + model/thinking presets.
- Docs do not state whether `setModel` inside `before_agent_start` applies to the
  same turn. Must verify empirically (fallback: `input` event, which fires earlier).

## Cost model for "on demand vs plan"

- Plan (OAuth subscription) models: marginal $ = 0 until quota window is exhausted;
  then 429 / degraded. Signals: provider rate-limit headers via `after_provider_response`
  (Anthropic unified 5h/7d utilization headers, Codex primary-used-percent), or a 429.
- On-demand (openrouter, gateway): $ = tokens x catalog price. Gateway catalog gives price.
- Switch cost: leaving a model with a warm cache costs ~contextTokens x input price of the
  new model on the next turn. Router must weigh this against per-turn savings.
