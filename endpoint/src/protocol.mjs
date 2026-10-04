/**
 * The two wire formats the endpoint speaks to clients: OpenAI `chat/completions` and Anthropic
 * `messages`. Everything here is pure string and object shaping.
 */

/** Text of a message `content`, whichever shape: a string, or blocks of text and tool results. */
export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text ?? "";
      if (block?.type === "tool_result") return contentText(block.content);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * What the classifier reads: the latest user message as `request`, and the turns before it as `recent`.
 * A short steer ("commit") is only classifiable against the work it refers to, and that work is in the
 * earlier turns. Mirrors the pi extension's routing state, trimmed so the payload stays small.
 * @param {any} body
 * @param {{ recentMessages?: number, maxChars?: number }} [opts]
 * @returns {{ request: string, recent: { role: string, text: string }[] }}
 */
export function routingState(body, { recentMessages = 6, maxChars = 500 } = {}) {
  const messages = body?.messages ?? [];
  let requestAt = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && contentText(messages[i].content).trim()) { requestAt = i; break; }
  }
  const request = requestAt < 0 ? "" : contentText(messages[requestAt].content).slice(0, 6000);
  const recent = [];
  for (let i = requestAt - 1; i >= 0 && recent.length < recentMessages; i--) {
    const message = messages[i];
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = contentText(message.content).trim();
    if (!text) continue;
    recent.unshift({ role: message.role, text: text.length > maxChars ? `${text.slice(0, maxChars)} …` : text });
  }
  return { request, recent };
}

/** The latest user message. */
export function lastUserText(body) {
  for (let i = (body.messages ?? []).length - 1; i >= 0; i--) {
    const message = body.messages[i];
    if (message.role !== "user") continue;
    const text = contentText(message.content);
    if (text.trim()) return text;
  }
  return "";
}

export function hasTools(body) {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

const sse = (event, data) => (event ? `event: ${event}\ndata: ${JSON.stringify(data)}\n\n` : `data: ${JSON.stringify(data)}\n\n`);

// ---- OpenAI ----------------------------------------------------------------

/** @param {{ toolCalls?: any[], usage?: import("./types.js").TokenUsage }} [extra] */
export function openaiCompletion(text, model, extra = {}) {
  const { toolCalls, usage } = extra;
  const message = { role: "assistant", content: toolCalls?.length ? (text || null) : text };
  if (toolCalls?.length) message.tool_calls = toolCalls;
  const u = usage ?? { input_tokens: 0, output_tokens: 0 };
  return {
    id: `chatcmpl-router-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls?.length ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens, total_tokens: u.input_tokens + u.output_tokens },
  };
}

/** Incremental chat-completions chunks: `start()`, `delta(text)` per piece, `end(usage)`. */
export function openaiStream(model) {
  const id = `chatcmpl-router-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish, extra = {}) => sse(null, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
  return {
    start: () => chunk({ role: "assistant", content: "" }, null),
    delta: (text) => chunk({ content: text }, null),
    end: (usage) => {
      const u = usage ?? { input_tokens: 0, output_tokens: 0 };
      return chunk({}, "stop", { usage: { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens, total_tokens: u.input_tokens + u.output_tokens } }) + "data: [DONE]\n\n";
    },
  };
}

// ---- Anthropic -------------------------------------------------------------

/** @param {{ toolUses?: any[], usage?: import("./types.js").TokenUsage }} [extra] */
export function anthropicMessage(text, model, extra = {}) {
  const { toolUses, usage } = extra;
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const use of toolUses ?? []) content.push(use);
  return {
    id: `msg_router_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: toolUses?.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: usage ?? { input_tokens: 0, output_tokens: 0 },
  };
}

/** Incremental Anthropic events for one text block: `start()`, `delta(text)`, `end(usage)`. */
export function anthropicStream(model) {
  const message = anthropicMessage("", model);
  return {
    start: () =>
      sse("message_start", { type: "message_start", message: { ...message, content: [] } }) +
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    delta: (text) => sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    end: (usage) =>
      sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usage?.output_tokens ?? 0 } }) +
      sse("message_stop", { type: "message_stop" }),
  };
}

/** A whole Anthropic message (text and tool_use blocks) as an event stream, for a reply that was not streamed. */
export function anthropicEventsOf(message) {
  let out = sse("message_start", { type: "message_start", message: { ...message, content: [] } });
  message.content.forEach((block, index) => {
    if (block.type === "tool_use") {
      out += sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      out += sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    } else {
      out += sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      if (block.text) out += sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    }
    out += sse("content_block_stop", { type: "content_block_stop", index });
  });
  out += sse("message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage?.output_tokens ?? 0 } });
  return out + sse("message_stop", { type: "message_stop" });
}

// ---- translation -----------------------------------------------------------

/** Anthropic messages request -> OpenAI chat-completions request (tools included). */
export function anthropicToOpenaiBody(body, model) {
  const messages = [];
  const system = contentText(body.system);
  if (system) messages.push({ role: "system", content: system });
  for (const message of body.messages ?? []) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const uses = blocks.filter((b) => b.type === "tool_use");
    if (uses.length > 0) {
      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: uses.map((u) => ({ id: u.id, type: "function", function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) } })),
      });
    } else if (text) messages.push({ role: message.role, content: text });
    for (const r of blocks.filter((b) => b.type === "tool_result")) {
      messages.push({ role: "tool", tool_call_id: r.tool_use_id, content: contentText(r.content) });
    }
  }
  const tools = (body.tools ?? []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? { type: "object", properties: {} } },
  }));
  const out = { model, messages, max_tokens: body.max_tokens ?? 4096, stream: false };
  if (tools.length) out.tools = tools;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  return out;
}

/** A non-streamed OpenAI reply -> an Anthropic message. */
export function openaiReplyToAnthropic(json, model) {
  const choice = json.choices?.[0]?.message ?? {};
  const toolUses = (choice.tool_calls ?? []).map((call) => ({
    type: "tool_use",
    id: call.id,
    name: call.function?.name,
    input: parseJson(call.function?.arguments),
  }));
  const usage = { input_tokens: json.usage?.prompt_tokens ?? 0, output_tokens: json.usage?.completion_tokens ?? 0 };
  return anthropicMessage(typeof choice.content === "string" ? choice.content : "", model, { toolUses, usage });
}

function parseJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}
