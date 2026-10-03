/**
 * Series: a family of models named by one word (`opus`, `sonnet`). An account serves a series
 * and the endpoint resolves the newest model in it, unless that account pins one model.
 */

export const SERIES_ID = {
  fable: /fable/i,
  opus: /opus/i,
  sonnet: /sonnet/i,
  haiku: /haiku/i,
};

/** The newest Claude models, used when an account cannot list its own. */
export const STATIC_MODEL = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-4-5-20251001",
};

/** Quota windows (Anthropic's unified names) that bound a series. A gate reads the highest of them. */
export const WINDOWS_FOR = {
  fable: ["5h", "7d", "7d_oi"],
  opus: ["5h", "7d", "7d_opus"],
  sonnet: ["5h", "7d", "7d_sonnet"],
  haiku: ["5h", "7d"],
};

export function matcherFor(series) {
  return SERIES_ID[series] ?? new RegExp(series.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}
