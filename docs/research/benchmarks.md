# LLM quality benchmarks for the model router

Retrieved **2026-09-20** with `curl` + browser User-Agent. Machine-readable data: `docs/data/benchmarks.json`
(one row per model × benchmark with source URL + retrieval date). Sources per benchmark are listed
under each table; lab-reported vs independently-measured values are distinguished in the notes.

Context for interpreting these numbers:

- **Artificial Analysis (AA)** is the only source that independently evaluates *all 17 candidates on the
  same harnesses*. AA model pages (`https://artificialanalysis.ai/models/<slug>`) embed current values for
  the AA Intelligence Index (v4.3.2), GPQA Diamond, Terminal-Bench 2.1 / 4.0 / Hard, τ²-bench, τ³-Banking,
  LiveCodeBench, SciCode. Values below are the *current* AA values; note AA re-based the Intelligence Index
  during 2026, so release-time AA articles cite different absolute numbers (e.g. Fable 5.1 "66" at release vs
  53.35 now) — only the current scale is comparable across models.
- **OpenAI's site (openai.com) blocks curl (Cloudflare 403)**, so no OpenAI-published benchmark tables could be
  pulled directly; GPT-5.5's Codex-harness Terminal-Bench 2.1 number is quoted via Moonshot's Kimi K3 blog,
  which cites OpenAI.
- The 2026 SWE-agent ecosystem has largely moved from SWE-bench Verified to **DeepSWE v1.1 / FrontierSWE /
  SWE-Marathon**; several labs no longer report SWE-bench Verified at all.

---

## 1. Artificial Analysis Intelligence Index (v4.3.2)

Composite of ten evaluations (math, science, coding, reasoning; includes GPQA Diamond and LiveCodeBench).
Source: AA model pages, e.g. `https://artificialanalysis.ai/models/gpt-6-astra` (retrieved 2026-09-20).
Higher is better; scale is AA-internal.

| Model | Score | Note |
|---|---|---|
| `openai/gpt-6-astra` | 52.67 |  |
| `anthropic/claude-fable-5.1` | 53.35 |  |
| `anthropic/claude-opus-5` | 50.78 |  |
| `xai/grok-4.6` | 44.31 |  |
| `z-ai/glm-5.3` | 44.78 |  |
| `z-ai/glm-5.3-flash` | 41.81 |  |
| `moonshotai/kimi-k3` | 43.59 |  |
| `openai/gpt-5.5` | 38.36 |  |
| `deepseek/deepseek-v4.1-flash` | 39.46 |  |
| `google/gemini-3.7-flash` | 39.06 |  |
| `deepseek/deepseek-v4-pro` | 36 |  |
| `anthropic/claude-sonnet-5` | 38.16 |  |
| `google/gemini-3.5-flash` | 32.6 |  |
| `deepseek/deepseek-v4-flash` | 34.33 |  |
| `google/gemini-3.1-pro-preview` | 29.72 |  |
| `openai/gpt-5.4-mini` | 24.07 |  |
| `anthropic/claude-haiku-4.5` | 15.41 |  |

## 2. Artificial Analysis Coding Agent Index

Model **+ coding-agent harness** composite (e.g. "GPT-6 Astra in Codex"), covering Terminal-Bench v4.0,
SWE-Atlas-QnA and DeepSWE. Source: AA article `https://artificialanalysis.ai/articles/benchmarking-gpt-6-astra`
(2026-09-09). The live leaderboard (`https://artificialanalysis.ai/agents/coding`) loads data client-side
(encrypted manifest), so values exist only for the three models AA quoted in prose.

| Model | Score | Note |
|---|---|---|
| `openai/gpt-6-astra` | 62 | GPT-6 Astra (max) in Codex harness |
| `anthropic/claude-fable-5.1` | 62 | Claude Fable 5.1 (max, with fallback) in Claude Code harness |
| `anthropic/claude-opus-5` | 60 | Claude Opus 5 in Claude Code harness |
| `xai/grok-4.6` | null | live Coding Agent Index leaderboard loads data client-side; no per-model value published in accessible sources |
| `z-ai/glm-5.3` | null | live Coding Agent Index leaderboard loads data client-side; no per-model value published in accessible sources |
| `z-ai/glm-5.3-flash` | null | live Coding Agent Index leaderboard loads data client-side; no per-model value published in accessible sources |
| `moonshotai/kimi-k3` | null | live Coding Agent Index leaderboard loads data client-side; no per-model value published in accessible sources |
| `openai/gpt-5.5` | null | live Coding Agent Index leaderboard loads data client-side; no per-model value published in accessible sources |
| `deepseek/deepseek-v4.1-flash` | null | live Coding Agent Index leaderboard loads data client-side; no per-model value published in accessible sources |
| `google/gemini-3.7-flash` | null | live Coding Agent Index leaderboard loads data client-side; no per-model value published in accessible sources |
| `deepseek/deepseek-v4-pro` | null | live Coding Agent Index leaderboard loads data client-side; no per-model value published in accessible sources |
| `anthropic/claude-sonnet-5` | null | live Coding Agent Index leaderboard loads data client-side; no per-model value published in accessible sources |
| `google/gemini-3.5-flash` | null | live Coding Agent Index leaderboard loads data client-side; no per-model value published in accessible sources |
| `deepseek/deepseek-v4-flash` | null | live Coding Agent Index leaderboard loads data client-side; no per-model value published in accessible sources |
| `google/gemini-3.1-pro-preview` | null | live Coding Agent Index leaderboard loads data client-side; no per-model value published in accessible sources |
| `openai/gpt-5.4-mini` | null | live Coding Agent Index leaderboard loads data client-side; no per-model value published in accessible sources |
| `anthropic/claude-haiku-4.5` | null | live Coding Agent Index leaderboard loads data client-side; no per-model value published in accessible sources |

## 3. SWE-bench Verified (% resolved)

Sources: swebench.com Verified leaderboard (`https://swebench.com`, embedded JSON, retrieved 2026-09-20);
DeepSeek V4 model cards (`https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro` README). swebench.com's newest
submissions date to 2026-02 and none of the 2026 frontier models are listed.

| Model | Score | Note |
|---|---|---|
| `openai/gpt-6-astra` | null | no submission on swebench.com (leaderboard's newest entries date to 2026-02) and lab does not report it; the 2026 SWE ecosystem has moved to DeepSWE/FrontierSWE/SWE-Marathon |
| `anthropic/claude-fable-5.1` | null | no submission on swebench.com (leaderboard's newest entries date to 2026-02) and lab does not report it; the 2026 SWE ecosystem has moved to DeepSWE/FrontierSWE/SWE-Marathon |
| `anthropic/claude-opus-5` | null | no submission on swebench.com (leaderboard's newest entries date to 2026-02) and lab does not report it; the 2026 SWE ecosystem has moved to DeepSWE/FrontierSWE/SWE-Marathon |
| `xai/grok-4.6` | null | no submission on swebench.com (leaderboard's newest entries date to 2026-02) and lab does not report it; the 2026 SWE ecosystem has moved to DeepSWE/FrontierSWE/SWE-Marathon |
| `z-ai/glm-5.3` | null | no submission on swebench.com (leaderboard's newest entries date to 2026-02) and lab does not report it; the 2026 SWE ecosystem has moved to DeepSWE/FrontierSWE/SWE-Marathon |
| `z-ai/glm-5.3-flash` | null | no submission on swebench.com (leaderboard's newest entries date to 2026-02) and lab does not report it; the 2026 SWE ecosystem has moved to DeepSWE/FrontierSWE/SWE-Marathon |
| `moonshotai/kimi-k3` | null | no submission on swebench.com (leaderboard's newest entries date to 2026-02) and lab does not report it; the 2026 SWE ecosystem has moved to DeepSWE/FrontierSWE/SWE-Marathon |
| `openai/gpt-5.5` | null | no submission on swebench.com (leaderboard's newest entries date to 2026-02) and lab does not report it; the 2026 SWE ecosystem has moved to DeepSWE/FrontierSWE/SWE-Marathon |
| `deepseek/deepseek-v4.1-flash` | null | no submission on swebench.com (leaderboard's newest entries date to 2026-02) and lab does not report it; the 2026 SWE ecosystem has moved to DeepSWE/FrontierSWE/SWE-Marathon |
| `google/gemini-3.7-flash` | null | no submission on swebench.com (leaderboard's newest entries date to 2026-02) and lab does not report it; the 2026 SWE ecosystem has moved to DeepSWE/FrontierSWE/SWE-Marathon |
| `deepseek/deepseek-v4-pro` | 80.6 | DeepSeek V4-Pro Max; lab-reported (comparison table), mini-SWE-agent-style harness not specified |
| `anthropic/claude-sonnet-5` | null | no submission on swebench.com (leaderboard's newest entries date to 2026-02) and lab does not report it; the 2026 SWE ecosystem has moved to DeepSWE/FrontierSWE/SWE-Marathon |
| `google/gemini-3.5-flash` | null | no submission on swebench.com (leaderboard's newest entries date to 2026-02) and lab does not report it; the 2026 SWE ecosystem has moved to DeepSWE/FrontierSWE/SWE-Marathon |
| `deepseek/deepseek-v4-flash` | 79 | DeepSeek V4-Flash Max; lab-reported |
| `google/gemini-3.1-pro-preview` | 80.6 | 'Gemini-3.1-Pro High'; as measured by DeepSeek in V4 comparison table |
| `openai/gpt-5.4-mini` | null | no submission on swebench.com (leaderboard's newest entries date to 2026-02) and lab does not report it; the 2026 SWE ecosystem has moved to DeepSWE/FrontierSWE/SWE-Marathon |
| `anthropic/claude-haiku-4.5` | 66.6 | 'Claude 4.5 Haiku (high)', mini-SWE-agent, 2026-02-17 submission |

## 4. SWE-bench Pro (public) (% resolved)

Sources: Scale leaderboard `https://scale.com/leaderboard/swe_bench_pro_public` (retrieved 2026-09-20);
DeepSeek V4 model cards (lab-reported "SWE Pro (Resolved)").

| Model | Score | Note |
|---|---|---|
| `openai/gpt-6-astra` | null | not listed on Scale SWE-bench Pro public leaderboard and not reported by the lab |
| `anthropic/claude-fable-5.1` | null | not listed on Scale SWE-bench Pro public leaderboard and not reported by the lab |
| `anthropic/claude-opus-5` | null | not listed on Scale SWE-bench Pro public leaderboard and not reported by the lab |
| `xai/grok-4.6` | null | not listed on Scale SWE-bench Pro public leaderboard and not reported by the lab |
| `z-ai/glm-5.3` | null | not listed on Scale SWE-bench Pro public leaderboard and not reported by the lab |
| `z-ai/glm-5.3-flash` | null | not listed on Scale SWE-bench Pro public leaderboard and not reported by the lab |
| `moonshotai/kimi-k3` | null | not listed on Scale SWE-bench Pro public leaderboard and not reported by the lab |
| `openai/gpt-5.5` | null | not listed on Scale SWE-bench Pro public leaderboard and not reported by the lab |
| `deepseek/deepseek-v4.1-flash` | null | not listed on Scale SWE-bench Pro public leaderboard and not reported by the lab |
| `google/gemini-3.7-flash` | null | not listed on Scale SWE-bench Pro public leaderboard and not reported by the lab |
| `deepseek/deepseek-v4-pro` | 55.4 | V4-Pro Max; lab-reported |
| `anthropic/claude-sonnet-5` | null | not listed on Scale SWE-bench Pro public leaderboard and not reported by the lab |
| `google/gemini-3.5-flash` | null | not listed on Scale SWE-bench Pro public leaderboard and not reported by the lab |
| `deepseek/deepseek-v4-flash` | 52.6 | V4-Flash Max; lab-reported |
| `google/gemini-3.1-pro-preview` | 46.1 | 'gemini-3.1-pro (thinking)' on Scale public leaderboard |
| `openai/gpt-5.4-mini` | null | not listed on Scale SWE-bench Pro public leaderboard and not reported by the lab |
| `anthropic/claude-haiku-4.5` | null | not listed on Scale SWE-bench Pro public leaderboard and not reported by the lab |

## 5. Terminal-Bench 2.1 (% pass@1)

"Terminal-Bench 2" in the 2026 ecosystem is served as **Terminal-Bench 2.1**. tbench.ai now only publishes the
Terminal-Bench 4.0 leaderboard (2.x is archived; `https://tbench.ai/benchmarks`), so the per-model 2.1 numbers
come from AA's evaluation (`https://artificialanalysis.ai/evaluations/terminalbench-2-1`) via the AA model pages.
These are AA-run (Terminus-style reference harness), so they are directly comparable across models.

| Model | Score | Note |
|---|---|---|
| `openai/gpt-6-astra` | 88.39 |  |
| `anthropic/claude-fable-5.1` | 91.39 |  |
| `anthropic/claude-opus-5` | 89.14 |  |
| `xai/grok-4.6` | 88.39 |  |
| `z-ai/glm-5.3` | 83.9 |  |
| `z-ai/glm-5.3-flash` | 84.27 |  |
| `moonshotai/kimi-k3` | 85.02 |  |
| `openai/gpt-5.5` | 84.27 |  |
| `deepseek/deepseek-v4.1-flash` | null | AA has not run TB 2.1 for this model; lab-reported value: 90.6 (DeepSeek Harness Minimal, N=3) |
| `google/gemini-3.7-flash` | 85.77 |  |
| `deepseek/deepseek-v4-pro` | 78.65 |  |
| `anthropic/claude-sonnet-5` | 80.52 |  |
| `google/gemini-3.5-flash` | 78.65 |  |
| `deepseek/deepseek-v4-flash` | 78.65 |  |
| `google/gemini-3.1-pro-preview` | 73.78 |  |
| `openai/gpt-5.4-mini` | 59.18 |  |
| `anthropic/claude-haiku-4.5` | null | AA has not run TB 2.1 for this model; no lab-reported value found either |

**Lab-reported Terminal-Bench 2.1** (different harnesses — *not* directly comparable to the AA column):

| Model | Score | Harness / source |
|---|---|---|
| `deepseek/deepseek-v4.1-flash` | 90.6 | DeepSeek Harness "Minimal", N=3, no network (`https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash`) |
| `moonshotai/kimi-k3` | 88.3 | Kimi Code harness (`https://www.kimi.com/blog/kimi-k3`) |
| `z-ai/glm-5.3` | 88.2 | Claude Code 2.1.2 (`https://z.ai/blog/glm-5.3`) |
| `z-ai/glm-5.3-flash` | 84.3 | z.ai comparison table (`https://z.ai/blog/glm-5.3-flash`) |
| `openai/gpt-5.5` | 83.4 | Codex, per OpenAI as cited by Moonshot (`https://www.kimi.com/blog/kimi-k3`) |
| `xai/grok-4.6` | 88.4 | AA-measured, quoted in AA Grok 4.6 article |
| `anthropic/claude-opus-5` | 89.1 | DeepSeek-measured ("Opus-5.0", V4.1-Flash README) |
| `deepseek/deepseek-v4-pro` | 87.9 | DeepSeek/z.ai comparison tables |
| `deepseek/deepseek-v4-flash` | 82.7 | DeepSeek/z.ai comparison tables |
| `google/gemini-3.7-flash` | 85.8 | z.ai comparison table (matches AA's 85.77) |

## 6. Terminal-Bench 4.0 (% pass@1) — supplementary

Current official tbench.ai leaderboard (retrieved 2026-09-20) plus AA-measured values for models with no
official submission. This is where the frontier separates most sharply today.

AA-measured (all models, same harness):

| Model | Score | Note |
|---|---|---|
| `openai/gpt-6-astra` | 59.09 |  |
| `anthropic/claude-fable-5.1` | 52.02 |  |
| `anthropic/claude-opus-5` | 48.99 |  |
| `xai/grok-4.6` | 21.21 |  |
| `z-ai/glm-5.3` | 41.92 |  |
| `z-ai/glm-5.3-flash` | 32.83 |  |
| `moonshotai/kimi-k3` | 12.63 |  |
| `openai/gpt-5.5` | 14.65 |  |
| `deepseek/deepseek-v4.1-flash` | 26.77 |  |
| `google/gemini-3.7-flash` | 13.64 |  |
| `deepseek/deepseek-v4-pro` | 14.14 |  |
| `anthropic/claude-sonnet-5` | 14.14 |  |
| `google/gemini-3.5-flash` | 6.57 |  |
| `deepseek/deepseek-v4-flash` | 12.12 |  |
| `google/gemini-3.1-pro-preview` | 4.04 |  |
| `openai/gpt-5.4-mini` | 2.02 |  |
| `anthropic/claude-haiku-4.5` | null | not evaluated by AA on TB 4.0 |

Official tbench.ai submissions (max effort, agent harnesses as submitted):

| Model | Score | Note |
|---|---|---|
| `openai/gpt-6-astra` | 58.18 | official leaderboard, max effort, Codex/Claude Code-family harnesses as submitted |
| `anthropic/claude-fable-5.1` | 57.88 | official leaderboard, max effort, Codex/Claude Code-family harnesses as submitted |
| `anthropic/claude-opus-5` | 53.94 | official leaderboard, max effort, Codex/Claude Code-family harnesses as submitted |
| `xai/grok-4.6` | 20.3 | official leaderboard, max effort, Codex/Claude Code-family harnesses as submitted |
| `z-ai/glm-5.3` | 41.82 | official leaderboard, max effort, Codex/Claude Code-family harnesses as submitted |
| `z-ai/glm-5.3-flash` | null |  |
| `moonshotai/kimi-k3` | null |  |
| `openai/gpt-5.5` | null |  |
| `deepseek/deepseek-v4.1-flash` | null |  |
| `google/gemini-3.7-flash` | 11.21 | official leaderboard, max effort, Codex/Claude Code-family harnesses as submitted |
| `deepseek/deepseek-v4-pro` | null |  |
| `anthropic/claude-sonnet-5` | 12.42 | official leaderboard, max effort, Codex/Claude Code-family harnesses as submitted |
| `google/gemini-3.5-flash` | null |  |
| `deepseek/deepseek-v4-flash` | null |  |
| `google/gemini-3.1-pro-preview` | null |  |
| `openai/gpt-5.4-mini` | null |  |
| `anthropic/claude-haiku-4.5` | null |  |

## 7. Terminal-Bench Hard (AA, % pass@1) — supplementary

| Model | Score | Note |
|---|---|---|
| `openai/gpt-6-astra` | null |  |
| `anthropic/claude-fable-5.1` | null |  |
| `anthropic/claude-opus-5` | null |  |
| `xai/grok-4.6` | null | not evaluated by AA on TB Hard |
| `z-ai/glm-5.3` | null |  |
| `z-ai/glm-5.3-flash` | null |  |
| `moonshotai/kimi-k3` | null |  |
| `openai/gpt-5.5` | 60.61 |  |
| `deepseek/deepseek-v4.1-flash` | null | not evaluated by AA on TB Hard |
| `google/gemini-3.7-flash` | null |  |
| `deepseek/deepseek-v4-pro` | null |  |
| `anthropic/claude-sonnet-5` | null |  |
| `google/gemini-3.5-flash` | 40.91 |  |
| `deepseek/deepseek-v4-flash` | null |  |
| `google/gemini-3.1-pro-preview` | 53.79 |  |
| `openai/gpt-5.4-mini` | 52.27 |  |
| `anthropic/claude-haiku-4.5` | 27.27 |  |

## 8. Aider Polyglot (% correct, pass@2)

Source: `https://aider.chat/docs/leaderboards/` (retrieved 2026-09-20). The leaderboard was last updated
**2025-11-20**; its newest entries are gpt-5/o3-pro/gemini-2.5-pro era. **No candidate model appears**, so
every value is null. (For reference, the top of that stale board: gpt-5 (high) 88.0%, o3-pro (high) 84.9%.)

| Model | Score | Note |
|---|---|---|
| `openai/gpt-6-astra` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |
| `anthropic/claude-fable-5.1` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |
| `anthropic/claude-opus-5` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |
| `xai/grok-4.6` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |
| `z-ai/glm-5.3` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |
| `z-ai/glm-5.3-flash` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |
| `moonshotai/kimi-k3` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |
| `openai/gpt-5.5` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |
| `deepseek/deepseek-v4.1-flash` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |
| `google/gemini-3.7-flash` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |
| `deepseek/deepseek-v4-pro` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |
| `anthropic/claude-sonnet-5` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |
| `google/gemini-3.5-flash` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |
| `deepseek/deepseek-v4-flash` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |
| `google/gemini-3.1-pro-preview` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |
| `openai/gpt-5.4-mini` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |
| `anthropic/claude-haiku-4.5` | null | aider.chat leaderboard last updated 2025-11-20 (newest entry: gpt-5); no candidate model has been evaluated |

## 9. LiveCodeBench (% pass@1)

Sources: official site `https://livecodebench.github.io/leaderboard.html` + `performances_generation.json`
(retrieved 2026-09-20 — stale, stops at mid-2025 models); AA model pages; DeepSeek V4 model cards (lab-reported).

AA-measured / lab-reported values found:

| Model | Score | Source |
|---|---|---|
| `deepseek/deepseek-v4-pro` | 93.5 | lab-reported, V4-Pro Max (`https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro`) |
| `deepseek/deepseek-v4-flash` | 91.6 | lab-reported, V4-Flash Max (`https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash`) |
| `anthropic/claude-haiku-4.5` | 51.1 | AA-measured (`https://artificialanalysis.ai/models/claude-4-5-haiku`) |

All other candidates: **null** — not on the (stale) official leaderboard, not evaluated by AA, not reported
by the labs. (DeepSeek's V4 comparison table also lists LiveCodeBench for Opus-4.6 88.8, Gemini-3.1-Pro 91.7,
K2.6 89.6 — of our candidates only Gemini 3.1 Pro Preview applies: 91.7, DeepSeek-measured.)

## 10. GPQA Diamond (% pass@1)

Source: AA model pages (`https://artificialanalysis.ai/evaluations/gpqa-diamond`), retrieved 2026-09-20.
Lab-reported values where they exist are close but not identical (e.g. DeepSeek reports V4-Pro Max 90.1–92.4
vs AA's 92.8; Moonshot reports Kimi K3 93.5 = AA's 93.5; DeepSeek measured Opus-5 at 93.4 vs AA's 93.2;
DeepSeek measured GLM-5.3 at 88.1 vs AA's 91.7).

| Model | Score | Note |
|---|---|---|
| `openai/gpt-6-astra` | 96.06 |  |
| `anthropic/claude-fable-5.1` | 93.74 |  |
| `anthropic/claude-opus-5` | 93.23 |  |
| `xai/grok-4.6` | 94.95 |  |
| `z-ai/glm-5.3` | 91.72 |  |
| `z-ai/glm-5.3-flash` | 91.21 |  |
| `moonshotai/kimi-k3` | 93.54 |  |
| `openai/gpt-5.5` | 93.54 |  |
| `deepseek/deepseek-v4.1-flash` | null | AA has not run GPQA for this model; lab-reported value: 90.9 (DeepSeek-measured, max effort) |
| `google/gemini-3.7-flash` | 94.55 |  |
| `deepseek/deepseek-v4-pro` | 92.83 |  |
| `anthropic/claude-sonnet-5` | 91.11 |  |
| `google/gemini-3.5-flash` | 92.22 |  |
| `deepseek/deepseek-v4-flash` | 90.81 |  |
| `google/gemini-3.1-pro-preview` | 94.14 |  |
| `openai/gpt-5.4-mini` | 87.47 |  |
| `anthropic/claude-haiku-4.5` | 64.65 |  |

## 11. τ²-bench and τ³-Banking (agentic tool-use, % pass@1)

Source: AA model pages / evaluations `https://artificialanalysis.ai/evaluations/tau2-bench` and
`.../tau3-banking` (retrieved 2026-09-20). AA has τ²-bench results for only part of the field; τ³-Banking
(multi-turn customer-service tool use) is more broadly populated.

τ²-bench (AA):

| Model | Score | Note |
|---|---|---|
| `openai/gpt-6-astra` | null |  |
| `anthropic/claude-fable-5.1` | null |  |
| `anthropic/claude-opus-5` | null |  |
| `xai/grok-4.6` | null |  |
| `z-ai/glm-5.3` | null |  |
| `z-ai/glm-5.3-flash` | null |  |
| `moonshotai/kimi-k3` | null |  |
| `openai/gpt-5.5` | 93.86 |  |
| `deepseek/deepseek-v4.1-flash` | null |  |
| `google/gemini-3.7-flash` | null |  |
| `deepseek/deepseek-v4-pro` | null |  |
| `anthropic/claude-sonnet-5` | null |  |
| `google/gemini-3.5-flash` | 95.32 |  |
| `deepseek/deepseek-v4-flash` | null |  |
| `google/gemini-3.1-pro-preview` | 95.61 |  |
| `openai/gpt-5.4-mini` | 83.33 |  |
| `anthropic/claude-haiku-4.5` | 32.46 |  |

τ³-Banking (AA):

| Model | Score | Note |
|---|---|---|
| `openai/gpt-6-astra` | 41.44 |  |
| `anthropic/claude-fable-5.1` | 47.22 |  |
| `anthropic/claude-opus-5` | 42.06 |  |
| `xai/grok-4.6` | 50.72 |  |
| `z-ai/glm-5.3` | 50.31 |  |
| `z-ai/glm-5.3-flash` | 47.22 |  |
| `moonshotai/kimi-k3` | 45.98 |  |
| `openai/gpt-5.5` | 38.97 |  |
| `deepseek/deepseek-v4.1-flash` | null | not evaluated by AA; no lab-reported value found |
| `google/gemini-3.7-flash` | 32.78 |  |
| `deepseek/deepseek-v4-pro` | 39.59 |  |
| `anthropic/claude-sonnet-5` | 37.32 |  |
| `google/gemini-3.5-flash` | 32.16 |  |
| `deepseek/deepseek-v4-flash` | 39.38 |  |
| `google/gemini-3.1-pro-preview` | 21.44 |  |
| `openai/gpt-5.4-mini` | 25.57 |  |
| `anthropic/claude-haiku-4.5` | null | not evaluated by AA; no lab-reported value found |

## 12. DeepSWE v1.1 (% resolved) — supplementary

The de-facto 2026 successor to SWE-bench Verified for agentic coding (mini-SWE-agent / Claude Code / Codex
harnesses). Sources: lab blogs/model cards as noted; official leaderboard site `https://deepswe.datacurve.ai/`
was not directly reachable via curl.

| Model | Score | Note |
|---|---|---|
| `openai/gpt-6-astra` | 68 | AA article: GPT-6 Astra 68% (vs GPT-5.6 Sol 72%) in the AA Coding Agent Index run |
| `anthropic/claude-fable-5.1` | null | no value found in any accessible source (official leaderboard site not reachable via curl; not reported by the lab) |
| `anthropic/claude-opus-5` | 74 | Opus-5.0 as measured by DeepSeek |
| `xai/grok-4.6` | 65.9 | x.ai-reported |
| `z-ai/glm-5.3` | 66.9 | z.ai-reported, mini-swe-agent harness |
| `z-ai/glm-5.3-flash` | 63.4 | z.ai-reported |
| `moonshotai/kimi-k3` | 67.5 | Kimi Code harness (67.3 with mini-SWE-agent per official leaderboard) |
| `openai/gpt-5.5` | 67 | from official DeepSWE leaderboard as cited in Kimi K3 blog |
| `deepseek/deepseek-v4.1-flash` | 74.2 | DeepSeek-measured (74.2 mini-SWE; 69.8 Claude Code, 72.6 DSH Minimal) |
| `google/gemini-3.7-flash` | 65.3 | as measured by Z.ai in GLM-5.3-Flash comparison table |
| `deepseek/deepseek-v4-pro` | 62.7 | DeepSeek-measured |
| `anthropic/claude-sonnet-5` | null | no value found in any accessible source (official leaderboard site not reachable via curl; not reported by the lab) |
| `google/gemini-3.5-flash` | null | no value found in any accessible source (official leaderboard site not reachable via curl; not reported by the lab) |
| `deepseek/deepseek-v4-flash` | 54.4 | DeepSeek-measured |
| `google/gemini-3.1-pro-preview` | null | no value found in any accessible source (official leaderboard site not reachable via curl; not reported by the lab) |
| `openai/gpt-5.4-mini` | null | no value found in any accessible source (official leaderboard site not reachable via curl; not reported by the lab) |
| `anthropic/claude-haiku-4.5` | null | no value found in any accessible source (official leaderboard site not reachable via curl; not reported by the lab) |

## 13. LMArena agent leaderboard (supplementary)

`https://lmarena.ai/leaderboard` (retrieved 2026-09-20) now publishes an **agent leaderboard** (avgScore over
real sessions, higher is better; rank in unit field). Best/max-effort variant per model.

| Model | Score | Note |
|---|---|---|
| `openai/gpt-6-astra` | 0.1154 | LMArena agent leaderboard avgScore, best/max-effort variant |
| `anthropic/claude-fable-5.1` | 0.1371 | LMArena agent leaderboard avgScore, best/max-effort variant |
| `anthropic/claude-opus-5` | 0.1016 | LMArena agent leaderboard avgScore, best/max-effort variant |
| `xai/grok-4.6` | 0.0201 | LMArena agent leaderboard avgScore, best/max-effort variant |
| `z-ai/glm-5.3` | 0.0305 | LMArena agent leaderboard avgScore, best/max-effort variant |
| `z-ai/glm-5.3-flash` | 0.0115 | LMArena agent leaderboard avgScore, best/max-effort variant |
| `moonshotai/kimi-k3` | 0.0622 | LMArena agent leaderboard avgScore, best/max-effort variant |
| `openai/gpt-5.5` | 0.0503 | LMArena agent leaderboard avgScore, best/max-effort variant |
| `deepseek/deepseek-v4.1-flash` | 0.0488 | LMArena agent leaderboard avgScore, best/max-effort variant |
| `google/gemini-3.7-flash` | -0.0060 | LMArena agent leaderboard avgScore, best/max-effort variant |
| `deepseek/deepseek-v4-pro` | 0.0414 | LMArena agent leaderboard avgScore, best/max-effort variant |
| `anthropic/claude-sonnet-5` | 0.0597 | LMArena agent leaderboard avgScore, best/max-effort variant |
| `google/gemini-3.5-flash` | null | not listed on the LMArena agent leaderboard |
| `deepseek/deepseek-v4-flash` | 0.0180 | LMArena agent leaderboard avgScore, best/max-effort variant |
| `google/gemini-3.1-pro-preview` | null | not listed on the LMArena agent leaderboard |
| `openai/gpt-5.4-mini` | null | not listed on the LMArena agent leaderboard |
| `anthropic/claude-haiku-4.5` | null | not listed on the LMArena agent leaderboard |

## 14. HumanEval / MBPP (fallback check)

Neither is published for the 2026 frontier instruct models by any source found. Only DeepSeek publishes
HumanEval, and only for **base** models (V4 model cards): DeepSeek-V4-Pro-Base 76.8, V4-Flash-Base 69.5,
V4.1-Flash-Base 79.4 (0-shot pass@1). MBPP: not found for any candidate. With Terminal-Bench/DeepSWE/AA data
available, this fallback is not needed.

---

## Notes: which benchmarks best predict coding-agent quality

For a router that picks models for a *coding agent* (pi-style: long-lived sessions, file edits, shell use,
tool calls), the benchmarks rank roughly in this order of predictive value:

1. **AA Coding Agent Index** — closest proxy (it scores model *in a coding-agent harness*: Terminal-Bench v4.0,
   SWE-Atlas-QnA, DeepSWE), but coverage is thin (3 of 17 candidates) and the leaderboard itself is not
   statically accessible. Use the components instead (below).
2. **Terminal-Bench 2.1 / 4.0** — the single best covered, harness-consistent signal for terminal/agentic
   coding. TB 2.1 is saturated at the frontier (73–91%) and no longer separates leaders; **TB 4.0 spreads the
   field widely** (Grok 4.6: 20, Sonnet 5: 12, Gemini 3.7 Flash: 11 vs Astra/Fable ~58) and correlates with
   the LMArena agent rankings — prefer TB 4.0 for frontier routing decisions.
3. **DeepSWE v1.1** — best proxy for repo-level bug-fixing, but values come from *different labs with different
   harnesses*; treat cross-lab comparisons as ±5 points. SWE-bench Verified/Pro are effectively dead for the
   2026 frontier (swebench.com last updated 2026-02; only DeepSeek and Google still report them).
4. **τ²/τ³-bench** — the only widely-populated tool-use signal; predicts the "agent plumbing" failure mode
   (bad tool calls, lost state) that pure coding benchmarks miss. τ³-Banking covers 15/17 candidates.
5. **AA Intelligence Index** — useful as a general "frontier-ness" prior and for cost-per-task tradeoffs, but
   it mixes math/knowledge/multimodal with coding; two models within ~3 II points can differ hugely on TB 4.0
   (e.g. Gemini 3.7 Flash 39 II vs Grok 4.6 44 II, yet Grok doubles it on TB 4.0).
6. **GPQA Diamond** — nearly useless for router discrimination at the frontier: every candidate except
   GPT-5.4-mini and Haiku 4.5 sits in a 90–96% band.
7. **LiveCodeBench / Aider Polyglot** — low value here: LCB is partially stale and mostly unreported for
   candidates; Aider Polyglot has not been updated since 2025-11 and covers none of the candidates.

**Recommended router signals**: Terminal-Bench 4.0 (AA or official) as the primary quality axis, DeepSWE v1.1
as the repo-editing axis, τ³-Banking (or τ² where present) as the tool-use axis, and the AA Intelligence Index
for the cheap general prior. Watch out: AA re-bases its indices over time — pin values with their retrieval
date (as `docs/data/benchmarks.json` does) and re-scrape before tuning thresholds.

## Source log (all retrieved 2026-09-20)

| Source | URL | Used for |
|---|---|---|
| Artificial Analysis model pages | `https://artificialanalysis.ai/models/<slug>` (17 slugs) | II, GPQA, TB 2.1/4.0/Hard, τ², τ³-Banking, LCB |
| AA evaluations | `https://artificialanalysis.ai/evaluations/{gpqa-diamond, terminalbench-2-1, terminalbench-4-0, terminalbench-hard, tau2-bench, livecodebench}` | cross-checks |
| AA articles | `https://artificialanalysis.ai/articles/{benchmarking-gpt-6-astra, grok-4-6-benchmarks-and-analysis, claude-fable-5-1, claude-opus-5-leader-agentic-knowledge-work, claude-sonnet-5-agentic-cost, kimi-k3-achieves-3-..., deepseek-is-back-..., gemini-3-1-pro-preview-new-leader-in-ai, gemini-3-5-flash-everything-you-need-to-know, gemini-3-7-time-frontier, four-frontier-launches-...}` | Coding Agent Index, release-time claims, Grok τ³/TB 2.1 |
| swebench.com | `https://swebench.com` + `/verified.html` | SWE-bench Verified (state of leaderboard; Claude 4.5 Haiku 66.6) |
| Scale | `https://scale.com/leaderboard/swe_bench_pro_public` | SWE-bench Pro (Gemini 3.1 Pro 46.1) |
| tbench.ai | `https://tbench.ai`, `https://tbench.ai/benchmarks` | official Terminal-Bench 4.0 leaderboard; 2.x archived |
| aider.chat | `https://aider.chat/docs/leaderboards/` | Aider Polyglot (stale, 2025-11-20) |
| LiveCodeBench | `https://livecodebench.github.io/leaderboard.html`, `/performances_generation.json` | LCB (stale, mid-2025) |
| DeepSeek model cards | `https://huggingface.co/deepseek-ai/{DeepSeek-V4-Pro, DeepSeek-V4-Flash, DeepSeek-V4.1-Flash}` READMEs | SWE Verified/Pro, TB 2.0/2.1, GPQA, LCB, DeepSWE, HumanEval(base) |
| DeepSeek API docs news | `https://api-docs.deepseek.com/news/{news260813, news260910, news260424}` | release notes (benchmarks published as PNG images only) |
| Z.ai blogs | `https://z.ai/blog/glm-5.3`, `https://z.ai/blog/glm-5.3-flash` | GLM TB 2.1, DeepSWE, comparison tables |
| Moonshot | `https://www.kimi.com/blog/kimi-k3`, `https://huggingface.co/moonshotai/Kimi-K3`, `https://platform.kimi.ai/docs/guide/kimi-k3-quickstart` | Kimi K3 full benchmark table, TB 2.1 harness notes |
| xAI | `https://x.ai/news/grok-4-6` | Grok 4.6 table (TB v3.0 26%, DeepSWE 65.9%, AA II claim 61) |
| LMArena | `https://lmarena.ai/leaderboard` | agent leaderboard scores |
| openai.com | `https://openai.com/index/gpt-6-astra/` etc. | **blocked (Cloudflare 403)** — no direct numbers |
| deepmind.google | `https://deepmind.google/models/gemini/` | model pages exist but no benchmark tables; Google publishes no per-model benchmark pages found |
