import { readFileSync } from "node:fs";

/**
 * Credentials the endpoint reads. Claude subscription accounts need none here: the Claude CLI
 * holds its own login in the account's config dir. The rest come from pi's `auth.json`, read at
 * request time so a login or refresh in pi is picked up without a restart. A secret is returned
 * to the caller that sends it and is never logged.
 */

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** pi's `auth.json` entry for `provider`: an API key, or the access token of an OAuth login. */
export function piCredential(authPath, provider) {
  const cred = readJson(authPath)[provider];
  if (!cred) throw new Error(`pi auth has no ${provider} credential`);
  const token = cred.key || cred.access;
  if (!token) throw new Error(`pi auth ${provider} has no key or access token`);
  return { token };
}

export function knownBaseUrl(provider) {
  return {
    xai: "https://api.x.ai/v1",
    openrouter: "https://openrouter.ai/api/v1",
    openai: "https://api.openai.com/v1",
    groq: "https://api.groq.com/openai/v1",
  }[provider];
}
