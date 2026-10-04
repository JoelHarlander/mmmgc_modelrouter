import { Readable } from "node:stream";
import { fail, json } from "./http.mjs";
import { anthropicEventsOf, anthropicMessage, anthropicStream, openaiCompletion, openaiReplyToAnthropic, openaiStream } from "./protocol.mjs";

/** Headers that say how a turn was routed. `x-router-route` is `open`, `gate:a>b`, `soft` or `backup`; `backup` costs money. */
export function routeHeaders(decision) {
  return {
    "x-router-account": decision?.account ?? "",
    "x-router-model": decision?.model ?? "",
    "x-router-tier": decision?.tier ?? "",
    "x-router-effort": decision?.effort ?? "",
    "x-router-via": decision?.via ?? "",
    "x-router-route": decision?.route ?? "",
  };
}

const SSE = { "content-type": "text/event-stream", "cache-control": "no-cache" };

/** Send an answered turn to the client in the protocol it asked in. */
export async function respond(res, protocol, body, result) {
  const headers = routeHeaders(result.decision);
  const stream = Boolean(body.stream);

  if (result.kind === "http") return passThrough(res, result.res, stream, headers);

  if (result.kind === "buffered") {
    const message = openaiReplyToAnthropic(result.json, "auto");
    if (!stream) return json(res, 200, message, headers);
    res.writeHead(200, { ...SSE, ...headers });
    return res.end(anthropicEventsOf(message));
  }

  // kind "events": text pieces from the Claude CLI (or the echo stand-in)
  return stream ? streamEvents(res, protocol, result.events, headers) : collectEvents(res, protocol, result.events, headers);
}

/** An OpenAI-compatible reply to an OpenAI client goes through untouched, streamed or not. */
function passThrough(res, upstream, stream, headers) {
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json", ...(stream ? { "cache-control": "no-cache" } : {}), ...headers });
  if (!upstream.body) return res.end();
  const readable = Readable.fromWeb(upstream.body);
  readable.on("error", () => res.destroy());
  readable.pipe(res);
  return undefined;
}

async function collectEvents(res, protocol, events, headers) {
  let text = "";
  let usage;
  let failed;
  for await (const e of events) {
    if (e.text) text += e.text;
    if (e.done) {
      usage = e.usage;
      failed = e.isError ? e.error : undefined;
    }
  }
  if (failed) return fail(res, protocol, 502, failed, headers);
  return json(res, 200, protocol === "anthropic" ? anthropicMessage(text, "auto", { usage }) : openaiCompletion(text, "auto", { usage }), headers);
}

async function streamEvents(res, protocol, events, headers) {
  const renderer = protocol === "anthropic" ? anthropicStream("auto") : openaiStream("auto");
  res.writeHead(200, { ...SSE, ...headers });
  res.write(renderer.start());
  let usage;
  for await (const e of events) {
    if (e.text) res.write(renderer.delta(e.text));
    if (e.done) {
      usage = e.usage;
      // Headers are sent: the only way left to say the stream failed is in the stream.
      if (e.isError) res.write(`data: ${JSON.stringify({ error: { message: e.error, type: "upstream_error" } })}\n\n`);
    }
  }
  return res.end(renderer.end(usage));
}
