# Subscription plan quotas & rate-limit signals for a model router

Research date: **2026-09-20**. All URLs retrieved 2026-09-20 with a browser User-Agent via curl,
GitHub issue API (`api.github.com`), and shallow clones (`router-for-me/CLIProxyAPI`,
`openai/codex`, `xai-org/grok-build`, `earendil-works/pi`) into `/tmp` for grepping.

Purpose: what a model router (pi extension switching between plan-backed OAuth credentials and
pay-per-token gateways) must respect when a coding agent uses **OAuth subscription credentials**
instead of API keys. Each section covers: window lengths, header names with example values, how to
compute utilization 0..1, and what to do on exhaustion.

---

## 1. Anthropic — Claude Pro/Max via OAuth (Claude Code, pi `anthropic` provider)

### Window lengths

- **5-hour rolling session window** ("five_hour"). Usage accumulates and drops out of the window
  on a rolling basis; the reset header gives the instant at which the window is fully replenished.
- **7-day weekly window** ("seven_day"), shared cap. Per-support docs, the Usage page shows
  "progress towards both your session limit and weekly limits", with weekly limits tracked
  separately for "Opus only and all other models".
- **Model-scoped weekly sub-limits**: separate weekly buckets surfaced by Claude Code as
  `seven_day_opus` ("Opus limit"), `seven_day_sonnet` ("Sonnet limit"), and
  `seven_day_overage_included` ("Fable limit"); the raw header namespace for the Fable bucket is
  `7d_oi`. Source: anthropics/claude-code#73770 (status-line JSON enumeration) and #94694 (plan
  usage popup: "5-hour limit 4% / Weekly, all models 54% / Weekly, Fable 56%").
- Limits are **shared across claude.ai, Claude Code, and IDE extensions** (support.claude.com
  "Use Claude Code with your Pro or Max plan"). Pro/Max users can enable **usage credits**
  (overage, billed at API rates) after included usage runs out.
- Context: these are *subscription* quotas, distinct from the pay-per-token API limits
  (RPM/ITPM/OTPM per usage tier) documented at docs.claude.com/en/api/rate-limits.

### Unified rate-limit response headers (OAuth traffic)

Present on ordinary (successful) proxied responses when authenticated with Claude OAuth
credentials; Claude Code and pi receive them on every response. The `anthropic-beta:
oauth-2025-04-20` beta is what Claude Code/CPA send to enable them (see CPA issue #22;
anthropics/claude-code#87420 notes the entitlement gate ignores the beta either way).

| Header | Value format | Example |
| --- | --- | --- |
| `anthropic-ratelimit-unified-5h-utilization` | float, **0.0–1.0** | `0.35` |
| `anthropic-ratelimit-unified-5h-reset` | unix epoch seconds (parsers also accept RFC 3339 / HTTP date) | `1789900800` |
| `anthropic-ratelimit-unified-5h-status` | `allowed` \| `allowed_warning` \| `rejected` | `allowed_warning` |
| `anthropic-ratelimit-unified-7d-utilization` | float 0.0–1.0 | `0.54` |
| `anthropic-ratelimit-unified-7d-reset` | unix epoch seconds | `1790332800` |
| `anthropic-ratelimit-unified-7d-status` | same triple | `allowed` |
| `anthropic-ratelimit-unified-7d_oi-utilization` / `-reset` / `-status` | same triple, model-scoped (Fable/"overage included") bucket | `rejected` |
| `anthropic-ratelimit-unified-status` | aggregate status across windows | `rejected` |
| `anthropic-ratelimit-unified-reset` | unix epoch seconds; reset of the binding (rejected) window | `1789900800` |
| `anthropic-ratelimit-unified-representative-claim` | `five_hour` \| `seven_day` (may contain `overage`) — names the binding window | `seven_day` |
| `anthropic-ratelimit-unified-overage-utilization` / `-reset` / `-status` | same triple for the usage-credits (overage) bucket | `rejected` |
| `anthropic-ratelimit-unified-overage-disabled-reason` | string, non-empty when overage is off | — |
| `anthropic-ratelimit-unified-fallback-percentage` | observed alternate naming (see below) | — |
| `anthropic-ratelimit-unified-{5h,7d,overage}-surpassed-threshold` | server-driven warning flag (can arrive without a utilization value) | — |

Header-name provenance: the Go parser `internal/runtime/executor/helps/claude_ratelimit.go` and its
fixtures in router-for-me/CLIProxyAPI (the exact names above, case-insensitive lookups);
anthropics/claude-code#73770 ("populated from the `anthropic-ratelimit-unified-*` response headers");
anthropics/claude-code#94694 (names `anthropic-ratelimit-unified-{5h,7d,overage}-surpassed-threshold`).
HermannBjorgvin/Clawdmeter#42 (2026-05-27) documents an older/alternate header generation
(`...-unified-overage-utilization`, `...-unified-fallback-percentage`, `...-unified-reset`,
`...-unified-status` without the window infix) — treat exact header spellings as **subject to
change**; parse leniently and ignore unknown names.

**Utilization scale — important**: the header `*-utilization` is a **0.0–1.0 fraction**. Evidence:
Claude Code's status-line builder computes `used_percentage: v.five_hour.utilization * 100`
(anthropics/claude-code#73770); CPA's parser treats `u >= 0 && u < 1.0` as "healthy"
(claude_ratelimit.go `isClaudeUtilizationHealthy`). In contrast, the **polled JSON** from
`GET https://api.anthropic.com/api/oauth/usage` uses **0–100** (CPA ADR 0006: "polled JSON is
0–100; a raw 0.5 is ambiguous"). Do not runtime-guess the scale from magnitude — pin it per source.

### What a 429 looks like

- **Quota exhaustion (OAuth plan):** HTTP 429, body `{"type":"error","error":{"type":"rate_limit_error","message":"..."} , "request_id":"..."}`,
  accompanied by `retry-after` (seconds) and the `anthropic-ratelimit-unified-*` headers with the
  relevant `-status: rejected`. The 5h/7d/7d_oi `-reset` headers give the recovery deadline;
  Claude Code shows "You've hit your session limit · usage resumes at HH:MM" (anthropics/claude-code#75730
  shows this message being mislabeled as a monthly spend limit in v2.1.204).
- **Entitlement gate (not quota):** OAuth requests to premium models are refused with a *bare*
  `429 {"type":"error","error":{"type":"rate_limit_error","message":"Error"}}` — **no unified
  headers, no retry-after** — unless the first `system` block is verbatim "You are Claude Code,
  Anthropic's official CLI for Claude." (`claude-haiku-4-5` exempt). Verified in
  anthropics/claude-code#87420 with repro curl commands. **A router must not treat this
  headerless 429 as quota pressure** (it causes spurious AIMD backoff on healthy accounts).
- **Spend cap (API-key orgs, for contrast):** 429 `rate_limit_error` with
  `details.error_code: "enforced_spend_limit_reached"`, message "You will regain access on … at
  00:00 UTC", and **no retry-after** (docs.claude.com/en/api/rate-limits).

### Computing utilization 0..1

- Header path: `utilization` is already 0..1 — use directly; percent = `utilization * 100`.
- Poll path (`GET https://api.anthropic.com/api/oauth/usage`, the endpoint Claude Code's
  `/usage` and CPA poll, cached ~30 min): values are 0–100, so divide by 100.
- Compute per window: `five_hour`, `seven_day`, model-scoped weekly (`7d_oi`, plus UI-only
  `seven_day_opus` / `seven_day_sonnet`), and the overage bucket. `representative-claim` says
  which window binds the account right now.

### On exhaustion

1. Distinguish rejection source: `unified-5h-status` / `-7d-status` / `-7d_oi-status` /
   `overage-status` = `rejected`; an overage-only or Fable-only rejection with 5h/7d
   `allowed` is **model-scoped** — route to a different model on the same credential instead of
   cooling the whole credential down (this is exactly CPA's
   `ClaudeHeadersIndicateUnifiedRateLimitRejection` logic).
2. Cooldown = max of `retry-after` and the rejected windows' `-reset` epochs (unix seconds),
   optionally plus a small fuzz (CPA adds 1–30 s).
3. If no reset info, exponential backoff. `allowed_warning` (plus Claude Code's 0.7 display gate
   and 0.75/0.5/0.25 pace rules) is the signal to start shifting traffic *before* rejection.
4. Do not burn plan quota on a second OAuth credential if the headerless entitlement-gate 429
   is observed — fix the request shape (first system block) instead.

### Sources (retrieved 2026-09-20)

- https://docs.claude.com/en/api/rate-limits — API tier limits, standard
  `anthropic-ratelimit-requests/tokens/input-tokens/output-tokens-*` headers, spend-cap 429 shape.
- https://support.claude.com/en/articles/11145838 — "Use Claude Code with your Pro or Max plan"
  (shared limits across surfaces, options on hitting limits).
- https://support.claude.com/en/articles/9797557 — "Usage limit best practices" (Settings > Usage
  shows "five-hour session and weekly usage limits"; weekly per "Opus only and all other models").
- https://support.claude.com/en/articles/11647753 — "How do usage and length limits work?"
- https://support.claude.com/en/articles/14552983 — "Models, usage, and limits in Claude Code"
  (Enterprise seat = rolling-window pool; API key = pay-as-you-go).
- https://github.com/anthropics/claude-code/issues/73770 — status-line `rate_limits` keys and
  header→key mapping (five_hour, seven_day, seven_day_overage_included, overage, opus/sonnet).
- https://github.com/anthropics/claude-code/issues/94694 — plan usage popup (5h + weekly +
  weekly Fable percentages) and `surpassed-threshold` header path.
- https://github.com/anthropics/claude-code/issues/87420 — entitlement-gate headerless 429 with
  repro; `oauth-2025-04-20` beta.
- https://github.com/anthropics/claude-code/issues/75730 — session-limit 429 mislabeled as
  monthly spend limit; session window auto-reset behavior.
- https://github.com/anthropics/claude-code/issues/30930 — `/api/oauth/usage` itself can 429
  (retry-after: 0) for Max users.
- https://github.com/earendil-works/pi/issues/6959 — pi feature request to expose
  `anthropic-ratelimit-unified-*` (utilization, resets_at, weekly caps) to extensions.
- https://github.com/jonmast/cpa-quota-api-extension/issues/22 and
  `docs/adr/0006-claude-quota-observations-from-response-headers.md` — full header table,
  `oauth-2025-04-20` beta, `/api/oauth/usage` polling, utilization-scale analysis.
- https://github.com/router-for-me/CLIProxyAPI`internal/runtime/executor/helps/claude_ratelimit.go`
  (+ tests) — canonical header names, status values, reset formats, overage/Fable-only logic.
- https://github.com/HermannBjorgvin/Clawdmeter/issues/42 — older/alternate header names.

---

## 2. OpenAI — ChatGPT Plus/Pro via OAuth (Codex CLI, pi `openai-codex` provider)

### Window lengths

- **Primary window: 5 hours** (`x-codex-primary-window-minutes: 300`).
- **Secondary window: weekly** (`x-codex-secondary-window-minutes: 10080`).
  Verified by a real captured 429 in earendil-works/pi#4172 (ChatGPT Plus plan) and by Codex CLI's
  own parser tests (`window_minutes` values 60/1440/10080 appear; treat the roles as
  server-defined and identify the window by `window-minutes`, not by name).
- Official product docs: "local messages per five-hour period" and "Local messages and cloud
  chats share your plan's usage allowance. **Weekly limits may also apply.**"
  (developers.openai.com/codex/pricing). ChatGPT usage dashboard:
  `https://chatgpt.com/codex/settings/usage`.

### Response headers (`x-codex-*`)

Present on responses from the ChatGPT backend (Codex CLI parses them in
`codex-rs/codex-api/src/rate_limits.rs`; the default "metered limit id" is `codex`, so the header
family prefix is `x-codex-`):

| Header | Value format | Example (real capture, pi#4172) |
| --- | --- | --- |
| `x-codex-primary-used-percent` | float, **0–100** | `100` |
| `x-codex-primary-window-minutes` | int minutes | `300` |
| `x-codex-primary-reset-after-seconds` | int seconds until reset | `13873` |
| `x-codex-primary-reset-at` | unix epoch seconds | `1777936568` |
| `x-codex-primary-over-secondary-limit-percent` | float | `0` |
| `x-codex-secondary-used-percent` | float 0–100 | `80` |
| `x-codex-secondary-window-minutes` | int minutes | `10080` |
| `x-codex-secondary-reset-after-seconds` | int seconds | `316705` |
| `x-codex-secondary-reset-at` | unix epoch seconds | `1778239400` |
| `x-codex-active-limit` | metered limit id that bound the request | `premium` |
| `x-codex-plan-type` | `guest` \| `free` \| `go` \| `plus` \| `pro` \| `prolite` \| … | `plus` |
| `x-codex-credits-has-credits` / `-unlimited` | `True`/`False` (also `1`/`0`) | `False` |
| `x-codex-credits-balance` | string balance | `0` |
| `x-codex-rate-limit-reached-type` | `rate_limit_reached` \| `workspace_owner_credits_depleted` \| `workspace_member_credits_depleted` \| `workspace_owner_usage_limit_reached` \| `workspace_member_usage_limit_reached` | — |
| `x-codex-promo-message` | string upsell message | — |
| `x-codex-<family>-*` (e.g. `x-codex-bengalfox-*`) | **additional per-model limits**: same `primary/secondary` field set per family, plus `x-codex-<family>-limit-name` (e.g. `gpt-5.2-codex-sonic`) | — |

Family discovery (from codex-rs `parse_all_rate_limits`): every header matching
`x-<limit_id>-primary-used-percent` (after stripping the prefix) defines an additional limit
family; `limit_id` is normalized (e.g. `codex-secondary` family, `codex_other`). The websocket
path mirrors all of this as `codex.rate_limits` events (see below).

### Quota poll endpoint: `/wham/usage`

Codex CLI polls the ChatGPT backend (`PathStyle::ChatGptApi`: `{base}/wham/usage`, base =
`https://chatgpt.com/backend-api`; the API-key path style is `{base}/api/codex/usage`) —
`codex-rs/backend-client/src/client/rate_limit_resets.rs`. Response JSON (per
`codex-rs/codex-backend-openapi-models`):

```json
{
  "plan_type": "plus",
  "rate_limit": {
    "allowed": false,
    "limit_reached": true,
    "primary_window":   { "used_percent": 100, "limit_window_seconds": 18000,
                          "reset_after_seconds": 13872, "reset_at": 1777936568 },
    "secondary_window": { "used_percent": 80, "limit_window_seconds": 604800,
                          "reset_after_seconds": 316704, "reset_at": 1778239400 }
  },
  "credits": { "has_credits": false, "unlimited": false, "balance": "0" },
  "additional_rate_limits": [
    { "limit_name": "GPT-5.3-Codex-Spark", "metered_feature": "…",
      "rate_limit": { "allowed": true, "limit_reached": false,
                      "primary_window": { … }, "secondary_window": { … } } }
  ],
  "rate_limit_reached_type": "rate_limit_reached",
  "rate_limit_reset_credits": { "available_count": 1 }
}
```

Related endpoints in the same file: `GET /wham/rate-limit-reset-credits` (list banked reset
credits) and `POST /wham/rate-limit-reset-credits/consume` (redeem one; body
`{"redeem_request_id": "...", "credit_id": "..." | null}`) — these power Codex's "banked
rate-limit reset" feature (developers.openai.com/codex/pricing describes the referral/banked
reset promo). Websocket transport frames the same data as
`{"type":"codex.rate_limits","rate_limits":{"primary":{…},"secondary":{…}},"credits":{…},
"plan_type":"plus","metered_limit_name":"…"}`.

### What a 429 looks like

Real capture (earendil-works/pi#4172, plan `plus`):

```
HTTP 429
body: {"type":"error","error":{"type":"usage_limit_reached",
        "message":"The usage limit has been reached","plan_type":"plus",
        "resets_at":1777936568,"eligible_promo":null,"resets_in_seconds":13872}}
headers: X-Codex-Active-Limit: premium
         X-Codex-Plan-Type: plus
         X-Codex-Primary-Used-Percent: 100
         X-Codex-Secondary-Used-Percent: 80
         X-Codex-Primary-Window-Minutes: 300
         X-Codex-Primary-Over-Secondary-Limit-Percent: 0
         X-Codex-Secondary-Window-Minutes: 10080
         X-Codex-Primary-Reset-After-Seconds: 13873
         X-Codex-Secondary-Reset-After-Seconds: 316705
         X-Codex-Primary-Reset-At: 1777936568
         X-Codex-Secondary-Reset-At: 1778239400
         X-Codex-Credits-Has-Credits: False
         X-Codex-Credits-Balance: 0
         X-Codex-Credits-Unlimited: False
```

Codex CLI maps `error.error.type == "usage_limit_reached"` to its rate-limit error path
(`codex-rs/codex-api/src/api_bridge.rs`); websocket errors wrap the same shape with status 429
and the `x-codex-*` headers inside the event payload (`endpoint/responses_websocket.rs`).

### Computing utilization 0..1

`used_percent / 100` for each window (primary = 5h, secondary = weekly, plus every additional
per-model family). `reset_at` (unix seconds) or `reset_after_seconds` give recovery time;
`limit_window_seconds` gives the window length when headers only carry minutes. The "TUI switch
prompt" fires at `used_percent >= 90` on either window (codex-rs `RATE_LIMIT_SWITCH_PROMPT_THRESHOLD
= 90.0`) — a good proactive-switching threshold for a router.

### On exhaustion

1. Parse `x-codex-active-limit` + the per-family headers to see whether the *general* plan limit
   or a *model-scoped* additional limit was hit; if model-scoped, switch model on the same
   credential.
2. Cooldown until `reset-at` / `retry-after` (not present in the capture above; the body's
   `resets_in_seconds` is the fallback). Retry the same request afterwards — no request change
   is needed.
3. Check `x-codex-credits-*`: if the account has credits, ChatGPT can continue on credits
   (paid-per-use) — opt in deliberately (mirrors Anthropic's usage-credits flow).
4. Workspace variants (`workspace_*_credits_depleted` / `..._usage_limit_reached` in
   `x-codex-rate-limit-reached-type`) mean a workspace, not the user plan, is exhausted.
5. In-flight turn semantics: OpenAI lets the active turn finish ("If you reach your usage limits
   during an active turn, the agent will be able to continue working on that turn, subject to
   fair use limits") — so route the *next* turn elsewhere.

### Sources (retrieved 2026-09-20)

- https://github.com/openai/codex — `codex-rs/codex-api/src/rate_limits.rs` (header names,
  families, credits, promo, `usage_limit_reached` mapping),
  `codex-rs/backend-client/src/client/rate_limit_resets.rs` (`/wham/usage`,
  `/api/codex/usage`, reset-credits endpoints, `x-openai-codex-luna-reserve` opt-in header),
  `codex-rs/codex-backend-openapi-models/src/models/{rate_limit_status_payload,
  rate_limit_status_details, rate_limit_window_snapshot, additional_rate_limit_details,
  plan_type, rate_limit_reached_kind}.rs` (JSON shapes, plan enum),
  `codex-rs/tui/src/chatwidget/rate_limits.rs` (90% threshold, AccountUsage vs streamed
  updates, `/wham/usage` comment), `codex-rs/protocol/src/protocol.rs`
  (`RateLimitReachedType` values), `codex-rs/codex-api/src/endpoint/responses_websocket.rs`
  (429 event shape).
- https://developers.openai.com/codex/pricing — 5-hour period table by plan, "Weekly limits may
  also apply", credits, banked rate-limit resets, usage dashboard URL.
- https://help.openai.com/en/articles/11369540 (Codex in ChatGPT) and
  https://help.openai.com/en/articles/9793128 (Pro plans) — linked from the pricing page as the
  limits references.
- https://github.com/earendil-works/pi/issues/4172 — real 429 capture with full header set
  (quoted above).
- https://github.com/earendil-works/pi/issues/9704, #4927, #9481 — pi-side Codex header/telemetry
  work.
- https://github.com/router-for-me/CLIProxyAPI —
  `internal/runtime/executor/helps/codex_quota.go` (`X-Codex-*` normalization incl.
  `X-Codex-Primary-Reset-After-Seconds`, over-secondary-limit, credits, active limit, plan type;
  `/wham/usage` array form) and `codex_executor_request.go`.

---

## 3. xAI — SuperGrok / Grok Build via OAuth

### Window lengths

- **Free tier (Grok Build included usage): rolling 24-hour window.** The cli-chat-proxy error
  message states: "Usage resets over a rolling 24-hour window — tokens (actual/limit):
  1065387/1000000" for `grok-4.5-build-free` (i.e. ~1M tokens / 24h for that model; per-model).
- **Paid tiers (SuperGrok / Heavy): one shared weekly usage pool.** Official FAQ (docs.x.ai
  /grok/faq.md): "Rolling out in June 2026, Grok will now use a simpler, more flexible system for
  paid users. Instead of separate daily limits for each product (like Chat, Imagine, Voice, or
  Build), you get one shared weekly usage pool … The usage pool limit resets every week on a
  schedule shown in the Usage tab in Settings." When hit, options are pay-as-you-go or a higher
  tier. **Exact per-tier token/message numbers: UNVERIFIED (not published).**

### Endpoints & auth

- OAuth device flow against `https://auth.x.ai` (public client id
  `b1a00492-073a-47ea-816f-4c329264a828`, scopes `openid profile email offline_access
  grok-cli:access api:access` — from CPA `internal/auth/xai/types.go`).
- OAuth inference goes through **`https://cli-chat-proxy.grok.com/v1`** (OpenAI-compatible),
  not `api.x.ai` (that is the pay-per-token API, with per-tier RPS/TPM limits per model and 429s
  on exceed — docs.x.ai/developers/rate-limits). Grok Build CLI install: `curl -fsSL
  https://x.ai/cli/install.sh | bash` (docs.x.ai/build/overview.md).

### Rate-limit / quota signals

- **No documented usage or quota response headers.** Neither docs.x.ai (Build/Grok sections) nor
  the grok-build source (`xai-org/grok-build`, grepped for `x-ratelimit`, `rate limit` headers)
  exposes an `x-usage-*`-style header on success responses. Only `retry-after` on 429 is relied
  upon (grok-build `rate_limit_backoff_tests.rs` mocks 429 + `retry-after`). **UNVERIFIED that
  no undocumented headers exist** — treat absence-of-evidence as evidence.
- **429 free-quota exhaustion body** (well-known error code in grok-build
  `xai-grok-shell/src/sampling/error.rs`):

```json
{"code":"subscription:free-usage-exhausted",
 "error":"You've used all the included free usage for model grok-4.5-build-free for now.
          Usage resets over a rolling 24-hour window — tokens (actual/limit): 1065387/1000000."}
```

  Grok Build maps this to a paywall ("You've reached your free Grok Build usage limit for now.
  Get SuperGrok for much higher limits … grok.com/supergrok"). CPA treats it as a 24h cooldown
  for credential rotation.
- **403 `bad-credentials`** ("access token could not be validated") means the OAuth token was
  invalidated — refresh, don't cool down (CPA `xaiStatusErr` remaps it to 401).
- Generic 429s (concurrency caps etc.): backoff only, no quota implication.

### Computing utilization 0..1

Not possible from headers today. Options: (a) parse `tokens (actual/limit)` out of the
exhaustion message (free tier) → `actual / limit`; (b) approximate a weekly burn rate locally
from token usage, as the FAQ only guarantees a weekly reset schedule in the Usage tab. Both
UNVERIFIED as stable interfaces.

### On exhaustion

- Free tier: 429 `subscription:free-usage-exhausted` → cool the credential ~24 h (rolling window;
  CPA uses a fixed 24h) or upgrade/switch credential. The token count in the message lets you
  budget before the next run.
- Paid (SuperGrok): wait for the weekly pool reset (schedule in grok.com Settings > Usage),
  pay-as-you-go, or upgrade tier. There is no in-band per-request warning header, so a router
  must keep its own weekly accumulator if it wants lead time.

### Sources (retrieved 2026-09-20)

- https://docs.x.ai/grok/faq.md — SuperGrok shared weekly usage pool (June 2026 rollout),
  weekly reset, cancellation/refunds, SuperGrok Heavy.
- https://docs.x.ai/developers/rate-limits.md — pay-per-token API RPS/TPM tiers per model
  (incl. `grok-build-0.1`), 429 + backoff guidance (API keys, not OAuth plans).
- https://docs.x.ai/build/overview.md — Grok Build CLI, OAuth browser login vs `XAI_API_KEY`.
- https://github.com/xai-org/grok-build — `crates/codegen/xai-grok-shell/src/sampling/error.rs`
  (`subscription:free-usage-exhausted` code, paywall copy, 429/-32003 ACP mapping),
  `rate_limit_backoff_tests.rs` (retry-after handling).
- https://github.com/router-for-me/CLIProxyAPI — `internal/auth/xai/types.go` (endpoints,
  client id, scopes), `internal/runtime/executor/xai_executor_response.go` (`xaiStatusErr`:
  free-usage-exhausted 24h cooldown, bad-credentials→401) and its tests (full error-body
  examples).

---

## 4. OpenRouter (pay-per-token; pi `openrouter` provider)

**Confirmed pay-per-token**: OpenRouter is a prepaid-credit aggregator — you buy credits and are
billed per model at per-token prices (docs: "Credit limits govern how much you can spend";
pricing per model at openrouter.ai/models). There is **no subscription quota window**; the only
"limits" are credit limits (spend) and request-rate limits (free variants + DDoS protection).

### "Windows" (rate limits only)

- **Free-model variants** (`:free` ids): 20 requests/minute always; requests/day depends on
  all-time credits purchased: 50/day below 10 credits, 1000/day at ≥ 10 credits (constants
  FREE_MODEL_RATE_LIMIT_RPM=20, FREE_MODEL_NO_CREDITS_RPD=50, FREE_MODEL_HAS_CREDITS_RPD=1000,
  FREE_MODEL_CREDITS_THRESHOLD=10 in the limits doc).
- Daily/weekly/monthly `usage_*` counters on the key are UTC-day / UTC-week (starting Monday) /
  UTC-month accounting, not limits.
- DDoS protection (Cloudflare) beyond reasonable bursts.

### Rate-limit headers

- **On 429 only** (platform-origin limits): `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  `X-RateLimit-Reset` describing the hit limit; plus `Retry-After` when every attempted
  provider returned a retry hint. Quote from docs: "Successful inference responses do not include
  `X-RateLimit-*` headers." Example values: integer request counts / epoch or seconds (standard
  `X-RateLimit-Reset` semantics; **exact value format for -Reset: UNVERIFIED — not shown in
  docs**).
- **429 body**:

```json
{"error": {"code": 429, "message": "Rate limit exceeded",
           "metadata": {"error_type": "rate_limit_exceeded"}}}
```

  Provider-origin 429s surface through fallback routing and carry
  `error.metadata.provider_code` (the upstream error code) when available.
- **Mid-stream 429** arrives as an SSE chunk with `finish_reason: "error"` and an `error`
  object, since HTTP 200 was already sent.

### Quota/key endpoint: `GET /api/v1/key` (legacy alias `GET /api/v1/auth/key` — both live; the
docs page uses `/api/v1/key`)

Response fields (`data.*`):

| Field | Meaning |
| --- | --- |
| `label` | key label |
| `limit` | per-key credit cap, or `null` = unlimited |
| `limit_reset` | reset type for the per-key cap, or `null` |
| `limit_remaining` | remaining credits under the key cap (`null` = unlimited) |
| `include_byok_in_limit` | whether BYOK spend counts toward the cap |
| `usage`, `usage_daily`, `usage_weekly`, `usage_monthly` | credits used all-time / current UTC day / week (Mon) / month |
| `byok_usage`, `byok_usage_*` | same for external BYOK usage |
| `is_free_tier` | whether the user has ever purchased credits |
| `free_model_daily_requests` | `{used, limit, remaining}` — free-model requests in the current UTC day |

### 402 (budget/credit) shape

HTTP 402 with `error.metadata` carrying `limit_source` and `reason`:

- `limit_source: "openrouter_in_flight_budget"`, `reason: "in_flight_budget_exhausted"` —
  in-flight spending budget full; **transient**; carries `Retry-After`; wait and retry.
- `limit_source: "openrouter_credits"`, `reason: "weight_exceeds_budget"` — single request
  bigger than the whole budget; retrying won't help; lower `max_tokens`/prompt or add credits.
- `limit_source: "openrouter_key_limit"` — per-key credit cap exhausted; raise limit or wait for
  `limit_reset`.
- Every 402 with `metadata.limit_source` also carries `remedy_hint` (human-readable; branch on
  `limit_source`, not the text).

```json
{"error": {"code": 402, "message": "This request would exceed your available credits given your current in-flight requests. …",
           "metadata": {"reason": "in_flight_budget_exhausted",
                         "limit_source": "openrouter_in_flight_budget",
                         "remedy_hint": "Retry after your in-flight requests settle (see the Retry-After header). …"}}}
```

### Computing utilization 0..1

- Per-key budget: `1 - limit_remaining / limit` (guard: both non-null).
- Free-model daily cap: `free_model_daily_requests.used / free_model_daily_requests.limit`.
- Account balance: no utilization concept — monitor `usage` (credits used) against balance in the
  dashboard; poll `GET /api/v1/key` before failures start.
- Platform rate limits: only observable *after* a 429 via `X-RateLimit-Remaining / -Limit`.

### On exhaustion

- 402 `openrouter_in_flight_budget`: honor `Retry-After`, retry unchanged.
- 402 `openrouter_credits`: add credits, reduce request size, or route to another provider —
  not transient.
- 429: exponential backoff, honor `Retry-After`; on free variants buy ≥ 10 credits or switch to
  the paid variant (no platform cap); on provider-side 429 add fallback models / relax provider
  routing preferences.
- Because it's pay-per-token, a router should treat OpenRouter as the *always-available*
  fallback whose marginal cost per request is `tokens × model price` (from `GET
  https://openrouter.ai/api/v1/models` pricing fields), never as an exhaustible plan.

### Sources (retrieved 2026-09-20)

- https://openrouter.ai/docs/api-reference/limits.md (canonical markdown of the Limits page:
  key-check endpoint, 402/429 shapes, X-RateLimit note, free-model caps, in-flight budget).
- https://openrouter.ai/docs/llms.txt — docs index (pricing/models pages, OAuth, BYOK).
- Live probe: `GET https://openrouter.ai/api/v1/auth/key` and `/api/v1/key` both respond 401
  `{"error":{"message":"User not found.","code":401}}` for invalid bearer — the legacy path is
  still routed.

---

## 5. Vercel AI Gateway (pay-per-token; pi `vercel-ai-gateway` provider)

**Pricing model**: pay-as-you-go AI Gateway Credits, zero markup on list token prices; the free
tier gets a monthly included credit plus **lower per-model rate limits**; the paid tier has **no
gateway-level rate limits** (upstream provider limits still apply). Not a subscription plan, but
the 429/402 shapes matter to a router.

### Window lengths

- No fixed quota windows: rate limits are per-model request-rate caps (free tier, numbers not
  published — "this page describes behavior rather than fixed numbers").
- **Budgets** (spend caps you set, per team / project / API key / user) have refresh periods:
  `hourly` (top of the hour UTC), `daily` (midnight UTC), `weekly` (Monday midnight UTC),
  `monthly` (1st of month, midnight UTC), or `none` (cumulative, never resets).

### Rate-limit signal: the 429 shape

HTTP `429` from the gateway:

```json
{"error": {"message": "Rate limit exceeded", "type": "rate_limit_exceeded"}}
```

- Some 429s include a **`retry-after` header** (seconds or HTTP-date); honor it when present.
- A provider's 429 (BYOK or upstream) can carry that provider's own error body instead of the
  gateway shape.
- **No `X-RateLimit-*` utilization headers are documented** on 429 or success responses.
  **UNVERIFIED whether undocumented headers exist.**

### Budget 402 shape

HTTP `402` when a budget (team / project / API key / user) is exhausted; `type` is always
`quota_for_entity_exceeded`, and `message` names the scope with current spend and limit:

```json
{"error": {"message": "Project budget exceeded. Current spend: $200.00, limit: $200.00. Please contact your administrator to increase the budget.",
           "type": "quota_for_entity_exceeded"}}
```

API-key variant: `"Quota limit exceeded for \"api_key_id_<your_key_id>\". Current spend: $10.00, limit: $10.00. …"`.
Caveat: SDK error classes lie — budget 402s can surface as `GatewayInternalServerError` (AI SDK
7) or `ProviderInternalServerError` (Python beta); check the body before retrying.

### Computing utilization 0..1

No in-band utilization. Options: track spend per request via `GET /v1/generation`
(per-request cost by `generationId`) or the spend report `/v1/report` (paid add-on), and divide
by the budget limit you configured; budget alerts fire at 50/75/100% thresholds via email (at
most once per period each).

### On exhaustion

- 429: retry the unchanged request after `retry-after` or exponential backoff (AI SDK retries
  automatically, `maxRetries` default 2); keep retries bounded.
- 402 budget: back off until the budget refresh period resets, or raise the limit; identify the
  scope from the message (team / project / api_key / user).
- Router role: the gateway is the pay-per-token path (`https://ai-gateway.vercel.sh/v1`,
  OpenAI-compatible; model ids `creator/model`; per-token pricing from `GET /v1/models`) — treat
  as always-available with per-request cost, and use per-request `providerOptions.gateway`
  fallback chains so provider 429/5xx never surfaces to the agent.

### Sources (retrieved 2026-09-20)

- https://vercel.com/docs/ai-gateway/rate-limits.md (429 body, retry-after, free/paid tiers,
  budgets-vs-rate-limits table: `402` with `quota_for_entity_exceeded`, BYOK fallback behavior).
- https://vercel.com/docs/ai-gateway/observability-and-spend/budgets.md (refresh periods, 402
  shapes per scope, spend alerts, SDK error-class caveat).
- https://vercel.com/docs/ai-gateway.md (overview: endpoint, credits, zero markup).
- Local context cross-checked: `docs/research-notes.md` in this repo (catalog fields, `/v1/models`
  pricing, `providerOptions.gateway`, `GET /v1/generation`, `/v1/report`), retrieved earlier from
  vercel.com/docs/ai-gateway.

---

## Cross-cutting summary for the router

| Provider | Auth | Windows | Utilization signal | Scale | Exhaustion signal | Proactive signal |
| --- | --- | --- | --- | --- | --- | --- |
| Anthropic Pro/Max | OAuth (beta `oauth-2025-04-20`) | 5 h rolling + 7 d weekly (+ per-model weekly, overage bucket) | `anthropic-ratelimit-unified-{5h,7d,7d_oi}-utilization` headers; `GET /api/oauth/usage` (0–100) | headers 0..1; poll 0..100→/100 | 429 `rate_limit_error` + `-status: rejected` + `-reset` epochs (+`retry-after`) | `allowed_warning`, surpassed-threshold |
| OpenAI ChatGPT Plus/Pro (Codex) | OAuth | 5 h (primary, 300 min) + weekly (secondary, 10080 min) | `x-codex-{primary,secondary}-used-percent` headers; `GET /wham/usage` JSON | 0..100 → /100 | 429 `usage_limit_reached` + `x-codex-*` + `resets_at` | ≥ 90% switch prompt |
| xAI SuperGrok/Grok Build | OAuth (auth.x.ai, cli-chat-proxy.grok.com) | free: rolling 24 h; paid: shared weekly pool | none documented (UNVERIFIED) | — | 429 code `subscription:free-usage-exhausted` (24 h) or weekly pool message; `retry-after` | none — keep local accumulator |
| OpenRouter | API key/OAuth key (pay-per-token) | free-variant 20 RPM + 50/1000 RPD (UTC day) | `GET /api/v1/key` (`limit_remaining`, `free_model_daily_requests`) | per-key: `1 - remaining/limit` | 429 (`X-RateLimit-*`, `Retry-After`) / 402 (`limit_source`, `Retry-After` if in-flight) | poll `/api/v1/key` |
| Vercel AI Gateway | API key (pay-per-token) | none (budgets: hourly/daily/weekly/monthly/none, user-set) | none in-band; `/v1/generation`, `/v1/report` | — | 429 `rate_limit_exceeded` (+`retry-after`); 402 `quota_for_entity_exceeded` | budget email alerts 50/75/100% |
