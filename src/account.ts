import type {
  AccountKind,
  ApiKeyConfig,
  RateLimitState,
  SubscriptionConfig,
} from "./types";
import { refreshAccessToken } from "./oauth";
import { persistSubscriptionUpdate } from "./config";
import { log } from "./log";

// Refresh a few minutes before the token actually expires so we don't race with
// upstream when a request starts near the boundary.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface Common {
  readonly name: string;
  readonly kind: AccountKind;
}

abstract class BaseAccount implements Common {
  abstract readonly kind: AccountKind;
  readonly name: string;

  protected inFlight = 0;
  protected totalRequests = 0;
  protected lastUsedAt = 0;
  protected ratelimit: RateLimitState = {
    requests_remaining: null,
    requests_reset_at: null,
    tokens_remaining: null,
    tokens_reset_at: null,
    cooldown_until: null,
    last_error: null,
  };

  constructor(name: string) {
    this.name = name;
  }

  isAvailable(now: number = Date.now()): boolean {
    if (this.ratelimit.cooldown_until && this.ratelimit.cooldown_until > now) return false;
    return true;
  }

  cooldownRemainingMs(now: number = Date.now()): number {
    if (!this.ratelimit.cooldown_until) return 0;
    return Math.max(0, this.ratelimit.cooldown_until - now);
  }

  inFlightCount(): number { return this.inFlight; }
  lastUsed(): number { return this.lastUsedAt; }

  begin(): void {
    this.inFlight += 1;
    this.totalRequests += 1;
    this.lastUsedAt = Date.now();
  }

  end(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  recordUpstreamHeaders(headers: Headers): void {
    const readInt = (h: string): number | null => {
      const v = headers.get(h);
      if (v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const readIso = (h: string): number | null => {
      const v = headers.get(h);
      if (!v) return null;
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : null;
    };
    this.ratelimit.requests_remaining = readInt("anthropic-ratelimit-requests-remaining");
    this.ratelimit.requests_reset_at = readIso("anthropic-ratelimit-requests-reset");
    this.ratelimit.tokens_remaining = readInt("anthropic-ratelimit-tokens-remaining");
    this.ratelimit.tokens_reset_at = readIso("anthropic-ratelimit-tokens-reset");
  }

  markLimited(seconds: number, reason: string): void {
    const until = Date.now() + Math.max(1, seconds) * 1000;
    this.ratelimit.cooldown_until = until;
    this.ratelimit.last_error = reason;
    log.warn("account marked limited", {
      account: this.name,
      kind: this.kind,
      cooldown_s: seconds,
      reason,
    });
  }

  clearCooldownIfExpired(): void {
    if (this.ratelimit.cooldown_until && this.ratelimit.cooldown_until <= Date.now()) {
      this.ratelimit.cooldown_until = null;
    }
  }

  snapshot(): Record<string, unknown> {
    const now = Date.now();
    return {
      name: this.name,
      kind: this.kind,
      available: this.isAvailable(now),
      in_flight: this.inFlight,
      total_requests: this.totalRequests,
      cooldown_ms: this.cooldownRemainingMs(now),
      ratelimit: this.ratelimit,
    };
  }

  abstract applyAuth(headers: Headers): Promise<void>;
}

export class SubscriptionAccount extends BaseAccount {
  override readonly kind = "subscription" as const;
  private accessToken: string;
  private refreshToken: string;
  private expiresAt: number;
  private refreshInFlight: Promise<string> | null = null;

  constructor(cfg: SubscriptionConfig, private readonly configPath: string) {
    super(cfg.name);
    this.accessToken = cfg.access_token;
    this.refreshToken = cfg.refresh_token;
    this.expiresAt = cfg.expires_at;
  }

  override snapshot(): Record<string, unknown> {
    return { ...super.snapshot(), expires_in_ms: this.expiresAt - Date.now() };
  }

  async token(): Promise<string> {
    const now = Date.now();
    if (this.expiresAt - REFRESH_MARGIN_MS > now && this.accessToken) {
      return this.accessToken;
    }
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      try {
        log.info("refreshing token", { account: this.name });
        const t = await refreshAccessToken(this.refreshToken);
        this.accessToken = t.access_token;
        this.refreshToken = t.refresh_token;
        this.expiresAt = t.expires_at;
        await persistSubscriptionUpdate(this.configPath, this.name, {
          access_token: t.access_token,
          refresh_token: t.refresh_token,
          expires_at: t.expires_at,
        });
        return t.access_token;
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  async applyAuth(headers: Headers): Promise<void> {
    const t = await this.token();
    headers.set("authorization", `Bearer ${t}`);
    // OAuth-authenticated Messages requests require this beta header.
    const existing = headers.get("anthropic-beta");
    const parts = new Set<string>(["oauth-2025-04-20"]);
    if (existing) for (const p of existing.split(",")) { const t = p.trim(); if (t) parts.add(t); }
    headers.set("anthropic-beta", Array.from(parts).join(","));
  }
}

export class ApiKeyAccount extends BaseAccount {
  override readonly kind = "api_key" as const;
  private readonly key: string;

  constructor(cfg: ApiKeyConfig) {
    super(cfg.name);
    this.key = cfg.key;
  }

  async applyAuth(headers: Headers): Promise<void> {
    headers.set("x-api-key", this.key);
    // API-key auth does NOT need the oauth beta. Leave any beta headers the
    // client sent in place.
  }
}

export type Account = SubscriptionAccount | ApiKeyAccount;
