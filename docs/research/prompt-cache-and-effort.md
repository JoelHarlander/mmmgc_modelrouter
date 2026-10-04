# Does changing reasoning effort break the prompt cache?

Research date: **2026-10-04**. Primary docs only, fetched that day.

- xAI: [How It Works](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works), [What Breaks Caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/multi-turn), [Reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning)
- OpenAI: [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), sections "Which settings affect the cached prefix" and "Change reasoning effort without rewriting the prefix"

## xAI (Grok)

The cache matches the **start of the messages array**. A hit is an exact prefix match; anything that edits, removes, or reorders an earlier message misses from that point. For reasoning models the documented top cause of a miss is omitting `reasoning_content` from earlier responses, not a request parameter.

`reasoning_effort` is a request parameter, not a message. It is absent from "What Breaks Caching", and the documented miss cases are all message edits. So changing it does not rewrite the cached prefix the way editing a message does.

Measured on `grok-4.7` the same day, one stable 5,252-token prefix, `reasoning_effort` varied low → low → high → high → low: cached tokens were 1,152, 1,152, 1,152, 5,248, 5,248. The switch to high did not drop the cached count, and the prefix written at high was reused on the return to low. xAI warns caching is not guaranteed (eviction, server routing); `x-grok-conv-id` raises the hit rate.

## OpenAI

Documented directly, and the opposite of xAI. `reasoning.effort` "can change model-side reasoning instructions", and changing the top-level setting "can rewrite instructions in the hidden system instructions", which invalidates the cached prefix.

GPT-6 and later can avoid that: append a `configuration_update` input item (`{ "type": "configuration_update", "reasoning": { "effort": "high" } }`) and **leave the top-level `reasoning.effort` at its original value**. The latest such item controls the effort, and the earlier prefix stays reusable. There is no equivalent for models before GPT-6.

For models before GPT-5.6, reasoning effort also changes the minimum cacheable input length, alongside tools, images, output schemas, and verbosity. From GPT-5.6 the minimum is a flat 1,024 tokens.

## What this means here

The endpoint sets effort per turn from the classifier tier, as a top-level parameter (`reasoning_effort` for xAI, `reasoning.effort` for OpenAI). On Grok that is safe for the cache. On a GPT-6 model reached through the Responses API it is exactly the change OpenAI says rewrites the hidden prefix, unless it is sent as a `configuration_update` with the top-level value held constant. The endpoint does not do that today, and it does not speak the Responses API at all: `openai-codex` stays on pi's own provider.
