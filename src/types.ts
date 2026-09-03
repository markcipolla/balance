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

export interface UnifiedWindow {
  utilization: number | null;   // 0.0..1.0
  reset_at: number | null;      // ms since epoch
  status: string | null;        // "allowed" | "warning" | "rejected" | ...
}

export interface RateLimitState {
  requests_remaining: number | null;
  requests_limit: number | null;
  requests_reset_at: number | null;
  tokens_remaining: number | null;
  tokens_limit: number | null;
  tokens_reset_at: number | null;
  cooldown_until: number | null;
  last_error: string | null;
  // Subscription usage from `anthropic-ratelimit-unified-*` response headers.
  // OAuth Messages responses surface these; API-tier responses don't.
  unified: {
    status: string | null;              // overall
    representative_claim: string | null;
    five_hour: UnifiedWindow;
    seven_day: UnifiedWindow;
    seven_day_opus: UnifiedWindow;      // model-specific weekly window ("7d_oi")
    overage_status: string | null;
    overage_disabled_reason: string | null;
  };
  // Every anthropic-ratelimit-* header the upstream last sent, verbatim.
  // Escape hatch for windows we don't parse into named fields yet.
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
