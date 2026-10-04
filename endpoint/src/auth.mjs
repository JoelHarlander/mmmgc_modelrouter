import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Credentials the endpoint reads. Claude subscription accounts need none here: the Claude CLI
 * holds its own login in the account's config dir. The rest come from pi's `auth.json`, read at
 * request time so a login in pi is picked up without a restart. A secret is returned to the caller
 * that sends it and is never logged.
 *
 * An OAuth login (xAI's SuperGrok, OpenRouter) expires. pi refreshes it only while pi runs, so the
 * endpoint refreshes it itself, through pi's own code: `AuthStorage.modify` holds pi's lock on
 * `auth.json` (so the two never race and lose a rotated refresh token) and pi-ai's provider module
 * knows the provider's token endpoint. Nothing about any provider's OAuth is reimplemented here.
 */

/** Refresh this long before expiry, so a token never lapses mid-request. */
const REFRESH_SKEW_MS = 2 * 60 * 1000;

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The installed pi package, which holds the auth code the endpoint borrows: `PI_PACKAGE_DIR`, else the
 * package behind the `pi` on PATH. Undefined when pi is not installed.
 */
export function piPackageDir() {
  if (process.env.PI_PACKAGE_DIR) return process.env.PI_PACKAGE_DIR;
  try {
    const bin = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
    // .../pi-coding-agent/dist/bundle/cli.js (or dist/cli.js): walk up to the package.json.
    let dir = dirname(realpathSync(bin));
    for (let i = 0; i < 4; i++, dir = dirname(dir)) {
      if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "dist", "core", "auth-storage.js"))) return dir;
    }
  } catch {
    // no pi on PATH
  }
  return undefined;
}

/**
 * A usable token for pi's `provider`: an API key as is, an OAuth access token refreshed first when it
 * is about to expire. Throws with a reason a person can act on.
 * @param {string} authPath
 * @param {string} provider
 * @param {{ now?: number, piDir?: string, refreshImpl?: (provider: string, authPath: string) => Promise<any> }} [opts]
 * @returns {Promise<{ token: string, refreshed?: boolean }>}
 */
export async function piToken(authPath, provider, opts = {}) {
  const cred = readJson(authPath)[provider];
  if (!cred) throw new Error(`pi auth has no ${provider} credential (log in with pi's /login)`);
  if (cred.key) return { token: cred.key };
  if (!cred.access) throw new Error(`pi auth ${provider} has no key or access token`);
  const now = opts.now ?? Date.now();
  if (!cred.expires || cred.expires - now > REFRESH_SKEW_MS) return { token: cred.access };
  const refreshed = await (opts.refreshImpl ?? refreshWithPi)(provider, authPath, opts.piDir);
  if (!refreshed?.access) throw new Error(`${provider} login expired and could not be refreshed; open pi once to refresh it`);
  return { token: refreshed.access, refreshed: true };
}

/** Refresh through pi's AuthStorage (pi's lock on auth.json) and pi-ai's provider OAuth module. */
async function refreshWithPi(provider, authPath, piDir = piPackageDir()) {
  if (!piDir) throw new Error(`${provider} login expired, and pi is not installed where its refresh code can be found (set PI_PACKAGE_DIR)`);
  const imp = (p) => import(pathToFileURL(p).href);
  let AuthStorage;
  let oauth;
  try {
    ({ AuthStorage } = await imp(join(piDir, "dist", "core", "auth-storage.js")));
    const mod = await imp(join(piDir, "node_modules", "@earendil-works", "pi-ai", "dist", "auth", "oauth", `${provider}.js`));
    oauth = Object.values(mod).find((v) => v && typeof v === "object" && typeof v.refresh === "function");
  } catch (err) {
    throw new Error(`${provider} login expired, and this pi version's refresh code was not found (${err.message.slice(0, 120)})`);
  }
  if (!AuthStorage || !oauth) throw new Error(`${provider} login expired, and pi has no refresh for it`);
  const store = AuthStorage.create(authPath);
  return store.modify(provider, async (current) => {
    // Another process (pi itself) may have refreshed while this one waited for the lock.
    if (current?.expires && current.expires - Date.now() > REFRESH_SKEW_MS) return current;
    const next = await oauth.refresh(current, AbortSignal.timeout(20_000));
    return { ...current, ...next };
  });
}

export function knownBaseUrl(provider) {
  return {
    xai: "https://api.x.ai/v1",
    openrouter: "https://openrouter.ai/api/v1",
    openai: "https://api.openai.com/v1",
    groq: "https://api.groq.com/openai/v1",
  }[provider];
}
