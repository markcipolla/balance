export type LogLevel = "debug" | "info" | "warn" | "error";

export interface SubscriptionConfig {
  name: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export interface ApiKeyConfig {
  name: string;
  key: string;
}

export interface ClaudeAccountsConfig {
  subscriptions: SubscriptionConfig[];
  api_keys: ApiKeyConfig[];
}

export interface Config {
  host: string;
  port: number;
  upstream: string;
  auth_token: string | null;
  inject_claude_code_identity: boolean;
  log_level: LogLevel;
  claude: ClaudeAccountsConfig;
}

// Backwards-compat wire shape: old configs stored subscriptions at the top
// level as `accounts`. We accept and migrate that on load.
export interface LegacyConfigShape {
  accounts?: SubscriptionConfig[];
}

export type AccountKind = "subscription" | "api_key";

export interface RateLimitState {
  requests_remaining: number | null;
  requests_reset_at: number | null;
  tokens_remaining: number | null;
  tokens_reset_at: number | null;
  cooldown_until: number | null;
  last_error: string | null;
  // Every anthropic-ratelimit-* header the upstream last sent, verbatim.
  // Anthropic surfaces subscription usage windows (5-hour / weekly on OAuth)
  // and unified limits as headers whose exact names change over time — this is
  // the escape hatch that lets `subscription list` render them without our
  // code needing to know the specific names in advance.
  raw: Record<string, string>;
}

export interface AttemptResult {
  ok: boolean;
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  retryable: boolean;
  cooldownSeconds: number | null;
  errorText: string | null;
}
