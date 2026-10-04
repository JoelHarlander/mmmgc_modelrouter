/** Shapes shared across the endpoint. Runtime code is plain `.mjs`; these are checked by `tsc -p endpoint/tsconfig.json`. */

export type Tier = "light" | "standard" | "heavy";
export type Effort = "off" | "low" | "medium" | "high" | "xhigh" | "max";
export type AccountKind = "claude-code" | "pi-auth" | "openai" | "echo";

/** A usage gate: past `at` (0..1) of the highest window bounding `series`, an account moves to `then`. */
export interface Gate {
  series: string;
  at: number;
  then?: string;
}

/** One quota window: utilization 0..1, and when it resets (epoch ms). */
export interface UsageWindow {
  u?: number;
  reset?: number;
}

/** What an account has used of its quota windows, as its CLI last reported. */
export interface QuotaUsage {
  windows: Record<string, UsageWindow>;
  at?: number;
}

export interface Account {
  id: string;
  kind: AccountKind;
  enabled?: boolean;
  /** The series this account serves, or `["backup"]` for the pay-per-token backup. */
  series?: string[];
  /** series -> the exact model to use, instead of the latest. */
  models?: Record<string, string>;
  backup?: boolean;
  /** `false` forbids resolving a latest model: an account with no pin is then an error. */
  latest?: boolean;
  /** How this upstream takes an effort: `reasoning_effort`, OpenRouter's `reasoning`, or `none`. Defaults by provider. */
  effortParam?: "reasoning_effort" | "reasoning" | "none";
  /** Overrides the default: a claude-code account cannot return tool calls, the others can. */
  tools?: boolean;
  planUsd?: number;
  configDir?: string;
  cli?: string;
  baseUrl?: string;
  provider?: string;
  modelGlob?: string;
  apiKey?: string;
  note?: string;
  served?: number;
  lastOkAt?: number;
  lastError?: string;
  cooldownUntil?: number;
  coolSeries?: Record<string, number>;
  usage?: QuotaUsage;
}

export interface Decision {
  account?: string;
  series?: string;
  model?: string;
  how?: string;
  route?: string;
  tier?: Tier;
  effort?: string;
  via?: string;
  confidence?: number;
  classifierErrors?: string[];
  attempts?: Attempt[];
  error?: string;
  at?: number;
}

export interface Attempt {
  id: string;
  series?: string;
  model?: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface State {
  host: string;
  port: number;
  token: string;
  layaUrl: string;
  preference: string[];
  gates: Gate[];
  tiers: Partial<Record<Tier, string[]>>;
  /** Reasoning effort per tier. */
  thinking: Record<Tier, Effort>;
  cooldownFallbackMs: number;
  accounts: Account[];
  rr: Record<string, number>;
  decisions: Decision[];
}

export type Protocol = "openai" | "anthropic";

/** Tokens a turn used, as the clients report them. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

/** What the Claude CLI (or the echo stand-in) yields: text pieces, then one terminal event. */
export interface StreamEvent {
  text?: string;
  done?: boolean;
  isError?: boolean;
  error?: string;
  usage?: TokenUsage;
}

export interface Failure {
  ok: false;
  status: number;
  error: string;
  /** A refusal that means "wait", as opposed to a plain failure. */
  quota: boolean;
  /** `series`: only that model's entitlement refused; `account`: the whole account. */
  scope?: "account" | "series";
  resetAt?: number;
  cooldownMs?: number;
}

export interface EventsResult {
  ok: true;
  kind: "events";
  events: AsyncIterable<StreamEvent>;
}

export interface HttpResult {
  ok: true;
  kind: "http";
  res: Response;
}

export interface BufferedResult {
  ok: true;
  kind: "buffered";
  json: any;
}

export type DispatchResult = Failure | EventsResult | HttpResult | BufferedResult;

/** A turn's outcome: a dispatch success with its decision, or a failure with the status to send. */
export type TurnResult = (EventsResult | HttpResult | BufferedResult) & { decision: Decision } | { ok: false; status: number; error: string; decision: Decision };

export interface Classification {
  tier: Tier;
  confidence: number;
  via: string;
  model?: string;
  needsTools?: number;
  stakes?: number;
  errors?: string[];
}

export interface Breakers {
  laya: number;
  jev: number;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** The shared pieces a request handler needs. */
export interface App {
  state: State;
  authPath: string;
  fetchImpl: typeof fetch;
  spawnImpl?: typeof import("node:child_process").spawn;
  typesafeUrl?: string;
  breakers: Breakers;
  log: Logger;
  persist(): void;
  authorized(req: import("node:http").IncomingMessage): boolean;
}
