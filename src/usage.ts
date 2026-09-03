import { refreshAccessToken } from "./oauth";
import { readCredentials, writeCredentials, type ClaudeCredentials } from "./credentials";
import { log } from "./log";

// Probe endpoint. count_tokens is cheap (no billing, no tools payload) and
// crucially still returns the anthropic-ratelimit-unified-* response headers
// on OAuth requests — same numbers Claude Code's /status displays.
const PROBE_URL = "https://api.anthropic.com/v1/messages/count_tokens?beta=true";

// The system-prompt fingerprint Anthropic's classifier needs to route the
// probe as subscription-metered (not extra-usage). Same shape balance's
// old proxy used to inject when it was faking Claude Code identity.
const IDENTITY_SYSTEM = [
  { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.259; cc_entrypoint=cli;" },
  { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
];

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface UsageWindow {
  utilization: number | null;   // 0.0..1.0
  resets_at: number | null;     // ms since epoch
  status: string | null;
}

export interface AccountUsage {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  seven_day_opus: UsageWindow;
  overage_status: string | null;
  fetched_at: number;
  error: string | null;
}

function emptyUsage(fetched_at: number, error: string | null = null): AccountUsage {
  return {
    five_hour: { utilization: null, resets_at: null, status: null },
    seven_day: { utilization: null, resets_at: null, status: null },
    seven_day_opus: { utilization: null, resets_at: null, status: null },
    overage_status: null,
    fetched_at,
    error,
  };
}

async function accessTokenFor(accountDir: string): Promise<string | null> {
  const creds = await readCredentials(accountDir);
  if (!creds) return null;
  const { accessToken, refreshToken, expiresAt, scopes } = creds.claudeAiOauth;
  if (expiresAt - REFRESH_MARGIN_MS > Date.now()) return accessToken;
  try {
    const t = await refreshAccessToken(refreshToken);
    const refreshed: ClaudeCredentials = {
      claudeAiOauth: {
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        expiresAt: t.expires_at,
        scopes,
      },
    };
    await writeCredentials(accountDir, refreshed);
    return t.access_token;
  } catch (err) {
    log.warn("token refresh failed while fetching usage", { err: String(err) });
    return null;
  }
}

function readWindow(headers: Headers, prefix: string): UsageWindow {
  const util = headers.get(`${prefix}utilization`);
  const reset = headers.get(`${prefix}reset`);
  const utilNum = util == null ? null : Number(util);
  const resetSec = reset == null ? null : Number(reset);
  return {
    utilization: Number.isFinite(utilNum) ? utilNum : null,
    resets_at: Number.isFinite(resetSec) && resetSec != null ? resetSec * 1000 : null,
    status: headers.get(`${prefix}status`),
  };
}

export async function fetchUsage(accountDir: string): Promise<AccountUsage> {
  const fetched_at = Date.now();
  const token = await accessTokenFor(accountDir);
  if (!token) return emptyUsage(fetched_at, "no valid token");

  try {
    const res = await fetch(PROBE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
        "user-agent": "claude-cli/2.1.259 (external, cli)",
        "x-app": "cli",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        system: IDENTITY_SYSTEM,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(4000),
    });

    // The response headers carry the subscription usage regardless of status —
    // even a 400 (e.g. count_tokens rejected the identity shim) still returns
    // the anthropic-ratelimit-unified-* headers when the OAuth is valid.
    const five_hour = readWindow(res.headers, "anthropic-ratelimit-unified-5h-");
    const seven_day = readWindow(res.headers, "anthropic-ratelimit-unified-7d-");
    const seven_day_opus = readWindow(res.headers, "anthropic-ratelimit-unified-7d_oi-");
    const overage_status = res.headers.get("anthropic-ratelimit-unified-overage-status");

    if (!res.ok && five_hour.utilization == null) {
      const text = await res.text().catch(() => "");
      return { ...emptyUsage(fetched_at, `HTTP ${res.status}: ${text.slice(0, 100)}`) };
    }

    return {
      five_hour,
      seven_day,
      seven_day_opus,
      overage_status,
      fetched_at,
      error: null,
    };
  } catch (err) {
    return emptyUsage(fetched_at, String(err));
  }
}
