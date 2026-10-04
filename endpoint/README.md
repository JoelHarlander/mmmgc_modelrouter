# router-endpoint

One local model, `auto`, for pi, OpenCode and anything else that speaks OpenAI `chat/completions` or Anthropic
`messages`. It takes the same decisions as the pi extension in the parent directory (Laya classifies, usage gates
and a pay-per-token backup pick the account), but as a service, so a tool that has no extension API can use them.

```
client ──► /v1/chat/completions  or  /v1/messages     (model: "auto", bearer token)
              │
              ├─ classify the turn:   Laya (local) → TypeSafe Jev → heuristic
              ├─ pick an account:     preference · tiers · usage gates · round-robin · cooldowns
              └─ run it:              claude CLI (subscription)  |  any OpenAI-compatible URL  |  pi's auth.json providers
```

Web UI at `http://127.0.0.1:8788/` (it asks for the token once and keeps it in the browser).

## Accounts

| kind | what it is | tools | usage gates |
| --- | --- | --- | --- |
| `claude-code` | A Claude subscription, served by running the official `claude` CLI headless with that account's `CLAUDE_CONFIG_DIR` | no | yes: the CLI reports its own utilization |
| `pi-auth` | A provider whose login pi already holds in `~/.pi/agent/auth.json` (xAI's SuperGrok, OpenRouter, OpenAI, Groq), read at request time; an OAuth login near expiry is refreshed through pi's own code, under pi's lock on the file | yes | no |
| `openai` | Any OpenAI-compatible base URL, with an optional key | yes | no |
| `echo` | A stand-in that needs nothing, for trying the plumbing | yes | no |

Accounts that serve the same **series** (`opus`, `sonnet`, `fable`, `haiku`, or any name you use) share its turns
round-robin, so several cheap plans absorb a burst that one large plan would be sized for. A refusal cools that account
until the provider says it resets (`retry-after`, or the reset the CLI reports), and the same request moves on to the next.
A refusal about one model (`Fable 5.1 requires usage credits`) cools that series on that account only.

**Claude accounts use the CLI, not an OAuth token.** Anthropic can refuse or bill extra for subscription tokens used
outside Claude Code (pi-claude-bridge's README warns of exactly this), so the endpoint never calls the API with one and
never presents itself as Claude Code. It runs `claude -p` the way pi-claude-bridge does: no tools, no persisted
session, none of your hooks (`--setting-sources ""`). The price is that the CLI cannot hand a client's tool definitions
back as tool calls, so **a request that carries `tools` skips Claude accounts** and is served by an account that can.
Everything else (chat, summaries, titles, one-shot questions) goes through them, streamed.

### Which model

- **Latest, by default.** A Claude account passes the series name (`opus`) to the CLI, which resolves it to the newest
  model. An OpenAI-compatible account lists its `/models` (cached an hour) and takes the newest id matching the series, or
  `modelGlob` (for example `z-ai/glm-*`; a tie on version prefers the shorter id).
- **Exactly one model.** Pin it: `models: { "opus": "claude-opus-5" }`. That account serves that model and nothing newer, ever.
  `latest: false` forbids guessing, so an account with no pin is an error rather than a surprise.

### Usage gates

`gates: [{ "series": "opus", "at": 0.5, "then": "sonnet" }]` moves an account off a series once it has used that share of
the highest quota window that bounds it (`5h`, `7d`, and the model's own weekly window when the CLI reports one).
It is judged **per account**: an account under its gate keeps the series while a gated one is skipped. Gates are soft: when
everything is past its gate, the least-used account still beats the backup.

The numbers come from the CLI's own `rate_limit_event` on every call, so an account has none until it has answered once,
and a gate acts on evidence only. It trips on the turn after the usage was reported, never on a guess.

`tiers` optionally gives each classifier tier its own series list (`{ "light": ["sonnet"], "heavy": ["opus"] }`);
a tier with no entry uses `preference`.

### The backup

One account marked `backup` (usually a pay-per-token OpenRouter login with `modelGlob: "z-ai/glm-*"`) serves only when no
subscription account can: all cooling, none serving the series, or none able to carry the request's tools. It is
configured like any other account, so it can be any provider.

### Effort

The classifier's tier sets the reasoning effort, as it does in the pi extension: `thinking` maps light, standard and heavy
to `low`, `medium` and `high` by default (any of `off low medium high xhigh max`). It goes to the Claude CLI as `--effort`, to xAI
and OpenAI as `reasoning_effort`, and to OpenRouter as `reasoning.effort`; an upstream whose spelling is unknown gets none
unless the account sets `effortParam`. It is only sent where changing effort mid-conversation is known to keep the
prompt cache: Claude and xAI by default, anything else only when the account sets `effortCacheSafe: true`. OpenAI's
top-level `reasoning.effort` rewrites the hidden prefix, so it stays off. A client that sets its own effort keeps it. A model that refuses the parameter is
asked again without it rather than failing over. `x-router-effort` says what was sent.

## Classifier

`LAYA_URL` (default `http://127.0.0.1:8787`) is tried first; if it is down, TypeSafe Jev (`jev-latest`) using
`TYPESAFE_API_KEY` or the `typesafe` entry in pi's `auth.json`; if that is missing or fails, a low-confidence heuristic.
Every decision records which one answered and why the earlier ones did not (the UI's *Recent turns*).

A classifier that failed is skipped for a while (Laya 30 s, the hosted Jev 60 s), so a stopped Laya and a slow Jev cost
one failure rather than seconds on every turn. At start the router warms Laya in the background, retrying until it
answers, because Laya's first prediction is slow and the two services start together at boot.

## Clients

The UI prints these with your token filled in.

```jsonc
// pi: ~/.pi/agent/models.json
{ "providers": { "router": { "baseUrl": "http://127.0.0.1:8788/v1", "api": "openai-completions", "apiKey": "<token>",
  "models": [{ "id": "auto", "name": "Auto", "reasoning": false, "input": ["text"], "contextWindow": 200000, "maxTokens": 8192,
               "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }] } } }
```

```jsonc
// OpenCode: opencode.json
{ "model": "router/auto",
  "provider": { "router": { "npm": "@ai-sdk/openai-compatible", "name": "Router",
    "options": { "baseURL": "http://127.0.0.1:8788/v1", "apiKey": "<token>" },
    "models": { "auto": { "name": "Auto", "tool_call": true } } } } }
```

Responses carry `x-router-account`, `x-router-model`, `x-router-tier`, `x-router-via` (which classifier) and `x-router-route` headers.
`x-router-route` is `open`, `gate:opus>sonnet`, `soft`, or `backup`; `backup` is the one that costs money.

## Install as a service

```bash
endpoint/deploy/install.sh              # per-user service: no root, starts at boot via linger
sudo endpoint/deploy/install.sh --system --run-as "$USER"   # system service, starts at boot
endpoint/deploy/install.sh doctor       # what the installer sees on this machine
endpoint/deploy/install.sh status
endpoint/deploy/install.sh token
endpoint/deploy/install.sh uninstall    # --purge also removes config, the app copy and the Laya venv
```

It copies the app out of the checkout (so a branch switch cannot change what is running), writes a private env file,
installs Laya into its own virtualenv (`--no-laya` skips it; `--laya-cpu` uses the smaller CPU torch wheel; a GPU below
compute capability 7.5 automatically gets the CUDA 12.6 index, see JoelHarlander/laya#1), writes the service files, starts
them, and prints the URL and token. Re-running updates the app and keeps your edits to the env file.

What it adapts to:

| detected | behaviour |
| --- | --- |
| systemd | user units in `~/.config/systemd/user` (with `loginctl enable-linger`), or system units in `/etc/systemd/system` with modest sandboxing |
| OpenRC (Alpine, Gentoo) | `/etc/init.d` scripts under `supervise-daemon`, run as `--run-as` (system only) |
| runit (Void) | `/etc/sv/*/run` with `chpst`, linked into the service directory (system only) |
| launchd (macOS) | LaunchAgents in `~/Library/LaunchAgents`, logs in `~/Library/Logs` |
| none | writes the run wrapper and tells you the command |
| immutable roots (Fedora Atomic, Silverblue, Bazzite, MicroOS, NixOS) | nothing under `/usr`; Node hints point at a user-level install, brew, or a toolbox instead of a layered package |
| SELinux enforcing | a `restorecon` hint for system installs |
| missing or old Node | stops before writing anything, with the install command for the detected package manager |

`--dry-run` prints every file it would write; `--stage DIR` writes under `DIR` and touches no service manager.
The test suite drives the script through 13 distro fixtures and every init profile this way.

Logs go to stdout, one line per event (`journalctl --user -u router-endpoint -f`): which account and model answered a turn
and why (`turn account=claude-main series=sonnet model=sonnet route=gate:opus>sonnet tier=light via=laya ms=1208`),
refusals with their cooldown, and admin edits. A line never carries a prompt, a response or a credential.
`ROUTER_LOG=0` silences it.

State (accounts, the token) is `~/.pi/agent/router-endpoint.json`, mode 0600, never overwritten if it cannot be parsed.
Secrets are read from where they already live (pi's `auth.json`, each Claude config dir) and are never copied, echoed
by the API, or logged. The service binds `127.0.0.1` only; `/api/*` and `/v1/*` need the bearer token.

## Limits you should know about

- **Claude accounts answer text-only requests.** Coding agents send tool definitions on nearly every turn (pi and OpenCode
  both do, including in headless mode), so with only Claude accounts and a pay-per-token backup configured, **their agent
  turns land on the backup and spend its credits**, not your subscriptions. Titles, summaries and one-shot questions, which
  carry no tools, do use the subscriptions. Ways to get what you want:
  - in **pi**, use the extension in the parent directory instead of this endpoint: it keeps pi-claude-bridge and its tool
    bridging, so Claude turns stay on the subscription;
  - add a tool-capable account the endpoint can use (an API-key provider);
  - or take the backup out of the endpoint if you would rather it refuse than spend: `x-router-route: backup` in a response
    (and `route=backup` in the journal) marks every such turn.

  Bridging a client's tools through the CLI the way pi-claude-bridge does would lift this, but it is a project of its own
  (a session that stays alive across HTTP requests, so a tool result can reach the model that asked for it).
- `openai-codex` is not proxied: its subscription protocol is not `chat/completions`. Keep it as a pi provider.
- A gate learns an account's usage on that account's first turn; it cannot see usage from other tools until then.
- Streams from a Claude account are real, token by token. A stream from an OpenAI-compatible account is passed through
  untouched, so its `model` field names the upstream model, not `auto` (the `x-router-model` header says the same).
- Requests carrying only the last user turn's worth of history to a Claude account are sent as a transcript, since the
  CLI takes one prompt.

## Layout

| file | job |
| --- | --- |
| `src/main.mjs` | the service entry point |
| `src/server.mjs` | wiring: auth, routing, the HTTP server, shutdown |
| `src/turn.mjs` | one turn: classify, pick, call, fail over |
| `src/select.mjs` | which account: preference, tiers, gates, round-robin, cooldowns (pure) |
| `src/dispatch.mjs`, `src/claude-cli.mjs` | calling an account: OpenAI-compatible HTTP, or the Claude CLI |
| `src/models.mjs`, `src/series.mjs`, `policy.mjs` | which model: pinned, alias, or newest listed; ordering shared with the pi extension |
| `src/classifier.mjs` | Laya, then Jev, then a heuristic, with circuit breakers |
| `src/respond.mjs`, `src/protocol.mjs`, `src/http.mjs` | the two wire formats, streaming, errors |
| `src/admin.mjs`, `src/store.mjs`, `src/usage.mjs`, `src/log.mjs`, `src/auth.mjs` | admin API, state file, quota windows, logs, pi credentials |
| `src/types.d.ts` | the shared shapes, checked by `tsc -p endpoint/tsconfig.json` (part of `npm run check`) |

## Development

```bash
npm test                       # from the repo root: extension tests and these
node --test endpoint/test/*.test.mjs
npm run lint:deploy            # shellcheck on the installer
```

`test/fake-claude.mjs` is a stand-in `claude` that emits the stream-json shapes the real CLI does (captured from 2.1.284),
including the entitlement refusal and a spent five-hour window.
