# Model preference & real-world usage signals

**Purpose.** Human-preference rankings and real-world coding-agent usage signals for the models a coding-agent router chooses between.
**Retrieval date for every number: 2026-09-20.** Machine-readable copy of every data point: [`docs/data/preference.json`](../data/preference.json) (126 records, each with `source_url` and `retrieved`).

Models covered (router IDs): `openai/gpt-6-astra`, `openai/gpt-5.5`, `anthropic/claude-fable-5.1`, `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`, `anthropic/claude-haiku-4.5`, `xai/grok-4.6`, `z-ai/glm-5.3`, `z-ai/glm-5.3-flash`, `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash`, `google/gemini-3.7-flash`, `google/gemini-3.1-pro-preview`, `moonshotai/kimi-k3`.

## Sources & method notes

| Source | URL used | Notes |
|---|---|---|
| LMArena (now **arena.ai**) | https://arena.ai/leaderboard/text, https://arena.ai/leaderboard/code/webdev, https://arena.ai/leaderboard | `lmarena.ai` 301-redirects to `arena.ai`. Leaderboards are server-rendered; Elo, rank, votes, CI scraped from the rendered tables (403 text rows, 129 WebDev rows, 696-model Text Arena Overview). |
| LMArena HF Space fallback | https://huggingface.co/spaces/lmarena-ai/chatbot-arena-leaderboard | **Stale** — last `elo_results_*.pkl` / `leaderboard_table_*.csv` update is 2025-08-29; none of the 14 models of interest appear. Not used for numbers. |
| OpenRouter rankings (programming) | Page: https://openrouter.ai/rankings?category=programming · Data API: https://openrouter.ai/api/frontend/v1/rankings/models?category=programming (`view=week` / `view=month`) | The rankings page SSRs the unfiltered board; the category filter is applied client-side via the frontend API. Token shares below are computed over all programming-category models (7-day total ≈ 1.283e14 tokens over 499 model slugs; 30-day total ≈ 5.099e14 over 523 slugs). Data license CC BY 4.0 (attribution: OpenRouter rankings). |
| Vercel AI Gateway leaderboards | Page: https://vercel.com/ai-gateway/leaderboards · Export: https://vercel.com/api/ai/leaderboard-export?modality=text | Leaderboard page is client-rendered; data taken from the public export endpoint (license CC-BY-4.0, dataset "models", text modality). Publishes only the top-10 named models per metric plus an "Other" bucket; models outside the top 10 are recorded as `null` with that note. Latest date in export: 2026-09-20. |
| Routing docs | OpenCode, oh-my-openagent (OmO), Cline, Aider, Cursor docs | See "Task tiering heuristics" below. |

**Variant mapping caveat.** Arena entries are named by serving variant (e.g. `gpt-6-astra-max`, `claude-opus-5-high`, `grok-4.6-high`, `glm-5.3-max`, `kimi-k3-max`, `deepseek-v4-flash-high`). The closest entry per router model was recorded; the exact arena entry name is in each JSON record's `notes`.

## 1. LMArena — human preference (crowd-voted Elo)

### Text Arena (https://arena.ai/leaderboard/text, retrieved 2026-09-20)

| Router model | Arena entry | Elo | CI (95%) | Votes | Rank |
|---|---|---:|---|---:|---:|
| anthropic/claude-fable-5.1 | claude-fable-5.1-max | **1498** | ±8 | 5,783 | **5** |
| anthropic/claude-opus-5 | claude-opus-5-high | 1493 | ±4 | 42,617 | 10 |
| google/gemini-3.7-flash | gemini-3.7-flash-high | 1490 | ±8 (preliminary) | 5,640 | 12 |
| google/gemini-3.1-pro-preview | gemini-3.1-pro-preview | 1487 | ±3 | 106,951 | 15 |
| moonshotai/kimi-k3 | kimi-k3-max | 1485 | ±5 | 20,987 | 17 |
| z-ai/glm-5.3 | glm-5.3-max | 1483 | ±6 | 10,960 | 19 |
| openai/gpt-5.5 | gpt-5.5 | 1476 | ±4 | 66,317 | 28 |
| z-ai/glm-5.3-flash | glm-5.3-flash | 1475 | ±7 | 10,038 | 29 |
| openai/gpt-6-astra | gpt-6-astra-max | 1480 | ±12 | 2,693 | 24 |
| deepseek/deepseek-v4-pro | deepseek-v4-pro | 1457 | ±4 | 54,130 | 57 |
| anthropic/claude-sonnet-5 | claude-sonnet-5-high | 1461 | ±5 | 35,301 | 51 |
| xai/grok-4.6 | grok-4.6-high | 1456 | ±6 | 15,521 | 63 |
| deepseek/deepseek-v4-flash | deepseek-v4-flash | 1436 | ±4 | 48,887 | 92 |
| anthropic/claude-haiku-4.5 | claude-haiku-4-5-20251001 | 1415 | ±3 | 129,278 | 129 |

Context: overall leader is `claude-fable-5-high` at Elo 1506 (±5, 30,057 votes); `claude-opus-4-6-high` 1505; `claude-opus-4-7-high` 1504. `claude-fable-5.1-max` (the router's fable) is 5th; `gpt-5.5-high` sits 20th (1482 ±4) and `gpt-5.5-instant` 32nd (1474).

### Text Arena Overview category ranks (696 models, retrieved 2026-09-20)

| Router model | Overall rank | Coding rank | Math rank | Instruction-following rank |
|---|---:|---:|---:|---:|
| anthropic/claude-fable-5.1 | 5 | 32 | 4 | 6 |
| anthropic/claude-opus-5 | 10 | 12 | 2 | 5 |
| google/gemini-3.7-flash | 12 | 26 | 5 | 12 |
| google/gemini-3.1-pro-preview | 15 | 28 | 22 | 16 |
| moonshotai/kimi-k3 | 17 | **7** | 12 | 13 |
| z-ai/glm-5.3 | 19 | 22 | 10 | 17 |
| openai/gpt-5.5 | 28 | 50 | 13 | 24 |
| z-ai/glm-5.3-flash | 29 | 20 | 7 | 29 |
| openai/gpt-6-astra | 24 | **6** | – | 43 |
| anthropic/claude-sonnet-5 | 51 | 27 | 36 | 34 |
| deepseek/deepseek-v4-pro | 57 | 65 | 70 | 54 |
| xai/grok-4.6 | 63 | 54 | 78 | 53 |
| deepseek/deepseek-v4-flash | 92 | 92 | 104 | 85 |
| anthropic/claude-haiku-4.5 | 129 | 96 | 147 | 104 |

Takeaway for a router: chat-preference strength (fable-5.1, opus-5, gemini flash/pro) does **not** track coding preference — kimi-k3 and gpt-6-astra are top-10 on Coding while sitting 17th/24th overall; conversely fable-5.1 is #5 overall but only #32 on Coding.

### WebDev Arena (https://arena.ai/leaderboard/code/webdev, retrieved 2026-09-20)

| Router model | Arena entry | Elo | CI | Votes | Rank |
|---|---|---:|---|---:|---:|
| openai/gpt-6-astra | gpt-6-astra-max | **1800** | +16/−16 | 2,281 | **1** |
| anthropic/claude-fable-5.1 | claude-fable-5.1-max | 1758 | +14/−14 | 3,036 | 2 |
| anthropic/claude-opus-5 | claude-opus-5-max | 1687 | +7/−7 | 12,087 | 3 |
| moonshotai/kimi-k3 | kimi-k3-max | 1674 | +11/−11 | 4,547 | 5 |
| anthropic/claude-opus-5 (high) | claude-opus-5-high | 1660 | +7/−7 | 12,566 | 7 |
| anthropic/claude-fable-5 (prev gen) | claude-fable-5-high | 1628 | +7/−7 | 10,081 | 10 |
| xai/grok-4.6 | grok-4.6-high | 1618 | +10/−10 | 4,282 | 13 |
| z-ai/glm-5.3 | glm-5.3-max | 1614 | +11/−11 | 3,725 | 15 |
| z-ai/glm-5.3-flash | glm-5.3-flash | 1607 | +12/−12 | 2,925 | 17 |
| google/gemini-3.7-flash | gemini-3.7-flash-high | 1587 | +12/−12 (preliminary) | 3,007 | 20 |
| deepseek/deepseek-v4-flash | deepseek-v4-flash-high | 1580 | +10/−10 | 4,723 | 22 |
| anthropic/claude-sonnet-5 | claude-sonnet-5-high | 1537 | +7/−7 | 9,296 | 33 |
| openai/gpt-5.5 | gpt-5.5 (codex-harness) | 1458 | +6/−6 | 15,012 | 56 |
| google/gemini-3.1-pro-preview | gemini-3.1-pro-preview | 1447 | +5/−5 | 22,891 | 57 |
| deepseek/deepseek-v4-pro | deepseek-v4-pro | 1446 | +6/−6 | 13,183 | 59 |
| anthropic/claude-haiku-4.5 | claude-haiku-4-5-20251001 | 1329 | +5/−5 | 27,785 | 104 |

WebDev-specific notes: `gpt-5.5-xhigh (codex-harness)` reaches 1510 (rank 41) and `gpt-5.5-high (codex-harness)` 1487 (rank 47); `deepseek-v4-pro-high-20260813` reaches 1581 (rank 21). WebDev Elo ordering differs sharply from text: gpt-6-astra is #1 (vs #24 on text), kimi-k3 top-5, and gemini-3.1-pro / deepseek-v4-pro fall to the mid-50s.

## 2. OpenRouter — real-world usage (programming category)

Token share of all programming-category traffic on OpenRouter, computed from https://openrouter.ai/api/frontend/v1/rankings/models?category=programming (retrieved 2026-09-20; data for the 7 days ending 2026-09-19 and the 30 days ending 2026-09-19; shares computed over all 499/523 model slugs in the dataset).

| Router model | OpenRouter slug | 7-day share | 7d rank | 30-day share | 30d rank | 7d requests |
|---|---|---:|---:|---:|---:|---:|
| z-ai/glm-5.3-flash | z-ai/glm-5.3-flash-20260826 | **10.11%** | 2 | 8.24% | 4 | 353,115,680 |
| deepseek/deepseek-v4-flash | deepseek/deepseek-v4-flash-20260731 | 8.46% | 5 | **9.86%** | **1** | 528,679,333 |
| z-ai/glm-5.3 | z-ai/glm-5.3-20260816 | 2.31% | 10 | 1.94% | 12 | 34,901,102 |
| openai/gpt-6-astra | openai/gpt-6-astra-20260903 | 1.33% | 14 | 0.49% | 30 | 21,971,774 |
| anthropic/claude-sonnet-5 | anthropic/claude-sonnet-5-20260630 | 1.19% | 17 | 1.12% | 20 | 29,377,775 |
| moonshotai/kimi-k3 | moonshotai/kimi-k3-20260715 | 1.13% | 19 | 1.34% | 16 | 25,584,677 |
| deepseek/deepseek-v4-pro | deepseek/deepseek-v4-pro-20260813 | 0.89% | 22 | 0.90% | 24 | 28,835,604 |
| anthropic/claude-opus-5 | anthropic/claude-opus-5-20260723 | 0.88% | 23 | 1.18% | 17 | 14,969,469 |
| google/gemini-3.7-flash | google/gemini-3.7-flash-20260813 | 0.47% | 32 | 1.61% | 14 | 35,248,391 |
| anthropic/claude-fable-5.1 | anthropic/claude-fable-5.1-20260831 | 0.38% | 36 | 0.22% | 49 | 3,951,835 |
| xai/grok-4.6 | x-ai/grok-4.6-20260810 | 0.26% | 47 | 0.33% | 37 | 6,081,261 |
| google/gemini-3.1-pro-preview | google/gemini-3.1-pro-preview-20260219 | 0.20% | 53 | 0.18% | 57 | 18,155,437 |
| anthropic/claude-haiku-4.5 | anthropic/claude-4.5-haiku-20251001 | 0.19% | 56 | 0.20% | 52 | 44,549,069 |
| openai/gpt-5.5 | openai/gpt-5.5-20260423 | 0.05% | 91 | 0.10% | 75 | 3,722,380 |

Context: the programming category is dominated by cheap workhorses — `deepseek/deepseek-v4.1-flash-20260910` (11.36% 7d), `z-ai/glm-5.3-flash` (#2), `openai/gpt-5.6-luna` (#3, 9.7%), `tencent/hy4-preview` (#4), `deepseek-v4-flash-0731` (#5). Older `deepseek-v4-pro-20260423` still runs 0.90% (7d rank 21). Author-level market share (all text, week of 2026-09-07): openai 23.6%, deepseek 22.6%, google 18.6%, z-ai 7.0%, anthropic 2.5%.

**Interpretation for a router:** actual coding traffic inverts the preference tables. Cheap flash-tier models (glm-5.3-flash, deepseek-v4-flash) carry ~10% of programming tokens each; the strongest preference models (fable-5.1, gpt-6-astra) are niche (<1.5%). gpt-5.5 is near-dead in production coding traffic (0.05%), likely displaced by the gpt-5.6 family.

## 3. Vercel AI Gateway — usage by requests & spend

Share of Vercel AI Gateway **text** traffic, 2026-09-20 (from https://vercel.com/api/ai/leaderboard-export?modality=text; the public leaderboard at https://vercel.com/ai-gateway/leaderboards publishes only the top 10 named models per metric plus "Other" — models not listed are `null` / below threshold).

| Router model | % of requests (rank) | % of spend (rank) | % of tokens (rank) |
|---|---|---|---|
| z-ai/glm-5.3-flash | 6.34% (4) | null | 4.85% (3) |
| deepseek/deepseek-v4-flash | 4.38% (6) | null | 2.01% (5) |
| moonshotai/kimi-k3 | 1.18% (9) | 6.22% (7) | 1.79% (7) |
| anthropic/claude-opus-5 | 0.52% (11) | 11.17% (4) | null |
| anthropic/claude-sonnet-5 | null | 3.73% (8) | null |
| anthropic/claude-fable-5.1 | null | 2.51% (9) | null |
| openai/gpt-6-astra | null | **12.63% (3)** | null |
| xai/grok-4.6 | null | null | null |
| google/gemini-3.7-flash | null | null | null |
| google/gemini-3.1-pro-preview | null | null | null |
| deepseek/deepseek-v4-pro | null | null | null |
| anthropic/claude-haiku-4.5 | null | null | null |
| z-ai/glm-5.3 | null | null | null |
| openai/gpt-5.5 | null | null | null |

Context (top of the same boards): requests are led by DeepSeek V4.1 Flash 36.1% and Gemini 3.1 Flash Lite 7.4%; spend is led by Claude Opus 4.8 22.5%, GPT-6 Astra 12.6%, Claude Opus 5 11.2%, GPT 5.6 Sol 7.0%; tokens led by DeepSeek V4.1 Flash 70.8%.

**Interpretation:** gateway traffic shows the same barbell as OpenRouter — request volume concentrates on cheap flash models, spend concentrates on frontier models (astra, opus tier). glm-5.3 and grok-4.6 are below the gateway's top-10 visibility threshold there, and gpt-5.5 has no measurable gateway presence.

## 4. Task tiering heuristics (published routing guidance)

Summary of how real coding-agent tools split cheap vs strong models across task types (planning, exploration, edits, review). All guidance retrieved 2026-09-20.

### OpenCode (https://opencode.ai/docs/agents/)
- Two primary agents: **Build** (all tools; the doer) and **Plan** (read-only-ish: file edits and bash set to `ask`; analysis, review, planning without changes).
- Three built-in subagents: **General** (parallel multi-step work), **Explore** ("a fast, read-only agent for exploring codebases … quickly find files by patterns, search code" — i.e. the speed/cheap slot), **Scout** (read-only external docs / dependency research).
- Hidden system agents (compaction, title, summary) are the natural "small model" slots; every agent takes its own `model` config, but OpenCode ships no hardcoded model tiers — tiering is left to config/distributions like OmO.

### oh-my-openagent / OmO (https://github.com/code-yeongyu/oh-my-openagent — README, `docs/guide/overview.md`, `docs/guide/agent-model-matching.md`)
OmO is the concrete tiering matrix on top of OpenCode. Delegation picks a **category**, and the category maps to a model + reasoning effort:

| Task type | Category / agent | Default model (effort) | Fallback chain |
|---|---|---|---|
| Architecture consult / plan | `architect` (consult lane) | anthropic/claude-fable-5.1 (max) | – |
| Plan gap analysis | `plan-consultant` | anthropic/claude-opus-5 (high) | – |
| Plan review | `plan-reviewer` | openai/gpt-6-astra (xhigh) | – |
| Hard logic, architecture decisions | `ultrabrain` | openai/gpt-6-astra (max) | gpt-5.6-sol (max) |
| Deep multi-domain work | `deep` | openai/gpt-6-astra (high) | gpt-5.6-sol (medium) |
| Unspecified hard work | `unspecified-high` | openai/gpt-6-astra (high) | – |
| Unspecified cheap work | `unspecified-low` | xai/grok-4.6 (xhigh) | gpt-5.6-terra, then DeepSeek V4 Flash/Pro |
| UI/UX, frontend, visual | `visual-engineering` | anthropic/claude-fable-5.1 (max) | claude-opus-5, kimi-k3 |
| Prose/design polish | `artistry` / `writing` | claude-fable-5.1 (max / medium) | – |
| Quick single-file edits, typos | `quick` | kimi-for-coding-highspeed | DeepSeek V4 Flash/Pro |
| Fast codebase grep (exploration) | `explore` | openai/gpt-5.6-luna-fast (low) | deepseek-v4-flash |
| Docs / OSS code search | `librarian` | openai/gpt-5.6-luna-fast (low) | deepseek-v4-flash |

Main-agent **model profiles** (pick by intent, chain walked until a provider serves one):
- **Capable** (default): claude-fable-5.1 (max) → claude-opus-5 (max) → kimi-k3 (max) → glm-5.3 (max).
- **Simple work**: gpt-5.6-luna-fast (low) → deepseek-v4-flash → claude-haiku-4.5.
- **Deep work**: gpt-6-astra (high) → gpt-5.6-sol (medium).

Heuristics worth copying into a router: strongest tier (fable/opus/astra, high+ effort) for planning, architecture and review; fast+cheap tier (luna-fast, deepseek-v4-flash, haiku-4.5) for exploration and doc lookup; mid cheap (kimi highspeed, grok-4.6) for quick bounded edits; models below the "recommended tier" are explicitly unsupported as main agent ("a prompt cannot fix a model").

### Cline (https://docs.cline.bot/core-workflows/plan-and-act)
- **Plan mode** = explore/architect/decide (read-only); **Act mode** = implement. Explicit per-mode model split: "use a stronger reasoning model for planning and a faster model for implementation."
- Published example configs: Cost optimization → Plan **GLM 4.6** + Act **Grok Code Fast**; Maximum quality → Plan **Claude Opus** + Act **Claude Sonnet**; Speed-focused → Plan **Gemini 3 Flash** + Act **Cerebras**.
- Task-size tiering: **small** tasks (typos, imports, renames) → Act mode only, no planning; **medium** (multi-file features) → Plan → Act; **large** (multi-session, architectural) → `/deep-planning` extended planning (prompt auto-tuned per model family).
- Plan-mode scenarios listed: new features with unclear approach, tricky debugging, architectural decisions, code review/security analysis, learning a codebase. Act-mode scenarios: routine changes, established patterns, running tests, quick fixes.

### Aider (https://aider.chat/docs/usage/modes.html, https://aider.chat/docs/llms.html)
- Chat modes: `code` (edit files), `ask` (discuss only — the "exploration/review" slot), `architect` (architect model proposes; a separate **editor model** translates the proposal into file edits — set via `--editor-model`, with built-in per-main-model defaults), `help`.
- Rationale: "certain LLMs aren't able to propose coding solutions and specify detailed file edits all in one go" — i.e. pair a strong reasoner with a cheaper/faster editor model; costs two LLM requests.
- Model-quality tiering: warns aider "may not work well with less capable models" and points to its LLM leaderboards; its "Best models" list on the LLMs page is stale (still names Gemini 2.5 Pro / Claude 3.7 Sonnet / o3).

### Cursor (https://cursor.com/docs/cursor-router.md, https://cursor.com/docs/subagents.md)
- **Cursor Router** (the "Auto" model): a classifier runs on each agent request and routes by task type and complexity — "simple requests go to fast, efficient models while complex work goes to the most capable ones," picking "the most cost-effective model that still produces comparable quality." Modes: **Cost**, **Balance**, **Intelligence**. Notably, the router *requires* a cheap-but-strong workhorse in the pool (Cursor Grok 4.6 must be enabled) "to create cost savings."
- **Subagents**: the built-in **Explore** subagent "uses a faster model to run many parallel searches" (token-heavy exploration is isolated from the main context); `model: inherit` default, or pin any model ID. Team admins can force Auto for everyone.

### Cross-tool synthesis (heuristic table)

| Task type | Tier the tools assign | Typical models named |
|---|---|---|
| Planning / architecture / plan review | Strongest tier, high/max effort, read-only tools | claude-fable-5.1/opus-5, gpt-6-astra (xhigh/max), claude-opus |
| Hard implementation / agentic deep work | Strong tier, high effort | gpt-6-astra (high), gpt-5.6-sol |
| Bounded edits / routine code | Mid tier, fast | kimi-k3 highspeed, grok-4.6, glm-5.3 |
| Exploration / codebase search / docs | Fast+cheap, parallelizable | gemini-flash-class, gpt-5.6-luna-fast, deepseek-v4-flash, claude-haiku-4.5 |
| Title / summary / compaction | Smallest tier | (system agents, small models) |

Consensus pattern: **plan and review with the strongest model, explore with the cheapest fast model, edit with a mid/cheap model**, and keep at least one cheap-but-strong workhorse always available in the pool.

## Caveats
- LMArena `gpt-6-astra-max` (2,693 votes) and `gemini-3.7-flash-high` (5,640, marked Preliminary) have wide CIs and low vote counts; treat their Elo as provisional. `claude-fable-5.1-max` also has relatively few votes (5,783).
- OpenRouter shares are aggregated per versioned slug; older snapshots (e.g. `deepseek-v4-flash-20260423`, 3.0% 7d) are listed separately from the current releases.
- Vercel leaderboard only exposes the top 10 named models; "null" means "below the publication threshold", not "zero usage".
- All numbers are point-in-time snapshots from 2026-09-20 and will drift; re-pull via the JSON `source_url` fields.