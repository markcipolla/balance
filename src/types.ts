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
