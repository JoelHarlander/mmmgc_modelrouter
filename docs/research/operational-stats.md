# Operational Stats: Vercel AI Gateway vs OpenRouter (2026-09-20)

Operational data (price, latency, throughput, uptime, context) for candidate models of a
coding-agent model router. All data was collected read-only on 2026-09-20 (UTC) via the
Vercel CLI (`npx vercel@latest ai-gateway ... --format json`) and the public
OpenRouter models API (`https://openrouter.ai/api/v1/models`).

## Raw data (docs/data/)

| File | Source |
|---|---|
| `gateway-models.json` | `vercel ai-gateway models ls --format json` (375 models) |
| `gateway-endpoints.json` | `vercel ai-gateway models endpoints <id> --format json` for all 17 models, keyed by gateway model id |
| `gateway-leaderboard.json` | `vercel ai-gateway leaderboard models --modality text --format json` (daily request/token/spend share, 2026-07-22 → 2026-09-20) |
| `openrouter-models.json` | `curl -s https://openrouter.ai/api/v1/models` (446 models) |
| `operational-stats.json` | Normalized array of objects (one per model) with the same fields as the table below |

## Methodology

- **Price (in / out / cache read)**: cheapest Vercel AI Gateway endpoint per model,
  converted from per-token strings to $/Mtok. Many models are served by many providers
  (GLM 5.3 Flash: 20 endpoints); the per-model price spread is noted per row.
- **Context window / max output**: maximum across gateway endpoints for that model
  (matches how OpenRouter reports it).
- **Best TTFT**: lowest `latency_last_1h.p50` (ms) across endpoints.
- **Throughput**: highest `throughput_last_1h.p50` (tok/s) across endpoints.
- **Uptime**: best `uptime_last_1d` (%) across endpoints.
- **Gateway leaderboard rank**: rank by request-share percentage on the most recent day
  the model appears (2026-09-20), excluding the aggregated "Other" row. The leaderboard
  is a usage-popularity chart (requests / tokens / spend share), **not** a quality
  ranking; only the top ~10 models per day are listed, so most models have no rank (—).
- Numbers were cross-checked against OpenRouter; material differences are noted per row.

## Results

| Model | Gateway ID | OpenRouter ID | In $/Mtok | Out $/Mtok | Cache read $/Mtok | Context | Max out | Best TTFT (ms) | Throughput (tok/s) | Uptime 1d (%) | LB rank | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Claude Fable 5.1 | `anthropic/claude-fable-5.1` | `anthropic/claude-fable-5.1` | 10 | 50 | 0.25 | 1,000,000 | 128,000 | 1335.5 | 84 | 100 | — | 3 endpoints (anthropic, bedrock, vertexAnthropic); uniform pricing. OpenRouter pricing matches. |
| Claude Opus 5 | `anthropic/claude-opus-5` | `anthropic/claude-opus-5` | 5 | 25 | 0.5 | 1,000,000 | 128,000 | 1696 | 284.5 | 99.9544 | 10 | 4 endpoints; uniform pricing. LB rank 10 by request share (0.52%) on 2026-09-20. |
| Claude Sonnet 5 | `anthropic/claude-sonnet-5` | `anthropic/claude-sonnet-5` | 2 | 10 | 0.2 | 1,000,000 | 128,000 | 1286.5 | 103 | 100 | — | 4 endpoints; uniform pricing. Not in latest leaderboard request rows (appears in tokens/spend metrics). |
| Claude Haiku 4.5 | `anthropic/claude-haiku-4.5` | `anthropic/claude-haiku-4.5` | 1 | 5 | 0.1 | 200,000 | 64,000 | 443.5 | 110 | 100 | — | 4 endpoints; uniform pricing. Not in leaderboard. |
| GPT-6 Astra | `openai/gpt-6-astra` | `openai/gpt-6-astra` | 10 | 50 | 1 | 1,050,000 | 128,000 | 3478 | 91.5 | 99.9683 | — | 2 endpoints (openai, azure); uniform pricing. High p50 TTFT but highest throughput among frontier models. |
| GPT-5.5 | `openai/gpt-5.5` | `openai/gpt-5.5` | 5 | 30 | 0.5 | 1,000,000 | 272,000 | 636 | 169 | 100 | — | 3 endpoints; openai/bedrock cheapest, azure $5.5/$33. OpenRouter reports context 1,050,000 and max-output 128,000 (gateway shows up to 272,000 via bedrock). |
| GPT-5.4 Mini | `openai/gpt-5.4-mini` | `openai/gpt-5.4-mini` | 0.75 | 4.5 | 0.075 | 400,000 | 128,000 | 523 | 174.5 | 99.9957 | — | 2 endpoints; uniform pricing. |
| Grok 4.6 | `spacexai/grok-4.6` | `x-ai/grok-4.6` | 2 | 6 | 0.5 | 500,000 | 500,000 | — | — | 99.1332 | — | **Id substituted**: requested `xai/grok-4.6` does not exist on the gateway; correct gateway id is `spacexai/grok-4.6` (OpenRouter: `x-ai/grok-4.6`). Single xAI endpoint; no latency/throughput stats exposed by the CLI. Tiered pricing: 2x above 200k prompt tokens. OpenRouter max-output 450,000. |
| GLM 5.3 | `zai/glm-5.3` | `z-ai/glm-5.3` | 0.7 | 2.2 | 0.12 | 1,048,576 | 1,048,576 | 109 | 507 | 100 | — | Gateway prefix `zai`, OpenRouter `z-ai`. 20 endpoints; input ranges $0.7–$1.4, output $2.2–$4.4 (cheapest is blackbox). OpenRouter mid-range: $0.896/$2.816, context 1,310,720, max-out 131,072. Not in leaderboard. |
| GLM 5.3 Flash | `zai/glm-5.3-flash` | `z-ai/glm-5.3-flash` | 0.075 | 0.25 | 0.01 | 1,048,576 | 1,048,576 | 366 | 269.5 | 100 | 3 | 20 endpoints; input ranges $0.075–$0.45 (cheapest is deepinfra). OpenRouter: $0.09/$0.3, cache-read $0.018, context 1,310,720, max-out 131,072. LB rank 3 by request share (6.34%). |
| DeepSeek V4 Pro | `deepseek/deepseek-v4-pro` | `deepseek/deepseek-v4-pro` | 0.66 | 1.98 | 0.022 | 1,048,576 | 1,048,576 | 500 | 125.5 | 100 | — | 6 endpoints (incl. first-party deepseek); input ranges $0.66–$2.4. OpenRouter cheaper: $0.422/$0.845, cache-read $0.035, max-out 384,000. Not in leaderboard. |
| DeepSeek V4 Flash | `deepseek/deepseek-v4-flash` | `deepseek/deepseek-v4-flash` | 0.06 | 0.18 | 0.007 | 1,048,576 | 1,048,576 | 434.5 | 384.5 | 100 | 5 | 9 endpoints, **no first-party deepseek endpoint**. OpenRouter cheaper: $0.037/$0.073. Leaderboard lists it as "DeepSeek V4 Flash 0731" (dated variant name). LB rank 5 (4.38% of requests). |
| DeepSeek V4.1 Flash | `deepseek/deepseek-v4.1-flash` | `deepseek/deepseek-v4.1-flash` | 0.15 | 0.6 | 0.003 | 1,048,576 | 1,048,576 | 345 | 277 | 100 | 1 | 16 endpoints; input ranges $0.15–$0.3. First-party deepseek is cheapest with cache-read $0.003. OpenRouter max-output 384,000 (gateway allows up to 1,048,576 via some hosts). **Most popular model on the gateway: LB rank 1 (36.1% of requests on 2026-09-20).** |
| Gemini 3.7 Flash | `google/gemini-3.7-flash` | `google/gemini-3.7-flash` | 0.75 | 3.75 | 0.075 | 1,000,000 | 65,536 | 1060.5 | 276 | 99.9828 | — | 2 endpoints (google, vertex); uniform pricing. OpenRouter context 1,048,576. |
| Gemini 3.5 Flash | `google/gemini-3.5-flash` | `google/gemini-3.5-flash` | 1.5 | 9 | 0.15 | 1,000,000 | 64,000 | 1482 | 285 | 99.9818 | — | 2 endpoints; uniform pricing. OpenRouter context 1,048,576, max-out 65,536. (Leaderboard's "Gemini 3.5 Flash Lite" is the Lite variant, not this model.) |
| Gemini 3.1 Pro (prev) | `google/gemini-3.1-pro-preview` | `google/gemini-3.1-pro-preview` | 2 | 12 | 0.2 | 1,000,000 | 64,000 | 3852 | 119 | 99.988 | — | 2 endpoints; uniform pricing. OpenRouter context 1,048,576, max-out 65,536. |
| Kimi K3 | `moonshotai/kimi-k3` | `moonshotai/kimi-k3` | 2.1 | 10.95 | 0.23 | 1,048,576 | 1,048,576 | 337 | 493 | 100 | 8 | 16 endpoints; input ranges $2.1–$3.0 (cheapest inference-net). OpenRouter cheaper: $1.7/$8.5, cache-read $0.17, max-out 943,718. LB rank 8 by request share (1.18%). |

## ID substitutions

1. **`xai/grok-4.6` → `spacexai/grok-4.6`** on the Vercel AI Gateway (the gateway uses
   owner prefix `spacexai`; OpenRouter uses `x-ai/grok-4.6`). All other requested ids
   existed verbatim on the gateway.
2. **`zai/*` vs `z-ai/*`**: Zhipu models are `zai/glm-5.3` and `zai/glm-5.3-flash` on the
   gateway but `z-ai/glm-5.3` and `z-ai/glm-5.3-flash` on OpenRouter.
3. Leaderboard names are display names; "DeepSeek V4 Flash 0731" is the leaderboard
   listing for `deepseek/deepseek-v4-flash` (dated variant naming).

## Fields the CLI did not expose

- **TTFT / throughput for Grok 4.6**: the single `xai` endpoint returns
  `latency_last_1h: null` and `throughput_last_1h: null` — so no TTFT or tok/s for
  Grok 4.6. All other 16 models expose them.
- Latency/throughput are only available as **p50/p95 over the last hour** per endpoint;
  the CLI does not expose mean TTFT, time-per-token curves, or per-region performance.
- Uptime is exposed as **15m / 1h / 1d** percentages per endpoint only; no uptime SLA,
  incident history, or 30-day uptime.
- The gateway reports **per-endpoint pricing including regional uplifts**
  (`inference_regions`, e.g. a 10% `us` zone uplift on Anthropic) and **tiered pricing**
  (Grok 4.6 doubles above 200k prompt tokens) — these are captured in
  `docs/data/gateway-endpoints.json` but flattened to a single base price in the table.
- The **leaderboard has no quality/rank score**: it only reports daily share_percent for
  requests/tokens/spend, and only for the top ~10 models plus an aggregate "Other" —
  so 8 of our 17 models have no leaderboard rank at all, and ranks reflect usage
  popularity, not model quality.
- The CLI does not expose per-model request counts, provider health/incidents, or
  rate-limit/quota information.

## Caveats for the router

- "Best" values aggregate across independent providers: the cheapest price endpoint and
  the fastest TTFT endpoint are usually different providers (e.g. GLM 5.3's $0.7 input
  is blackbox while its 507 tok/s p50 comes from another host). The raw per-endpoint
  data in `docs/data/gateway-endpoints.json` should be used for provider-aware routing.
- OpenRouter prices are sometimes lower than the gateway's cheapest endpoint (DeepSeek
  V4 Flash: $0.037 vs $0.06; Kimi K3: $1.7 vs $2.1), and sometimes higher (GLM 5.3:
  $0.896 vs $0.7).
- Stats are a 1-hour p50 snapshot taken 2026-09-20; expect diurnal variation.