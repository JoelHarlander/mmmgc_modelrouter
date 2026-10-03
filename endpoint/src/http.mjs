/** Small HTTP helpers shared by the routes. */

export const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** An error with the status code to send. Anything else a handler throws is a 500 with no detail. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

export function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** An error in the shape the client's own protocol uses, so its SDK can read it. */
export function fail(res, protocol, status, message, headers) {
  json(res, status, protocol === "anthropic" ? { type: "error", error: { type: "api_error", message } } : { error: { message, type: "server_error" } }, headers);
}
