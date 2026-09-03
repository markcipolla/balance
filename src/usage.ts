import { refreshAccessToken } from "./oauth";
import { readCredentials, writeCredentials, type ClaudeCredentials } from "./credentials";
import { log } from "./log";

// Anthropic returns per-account subscription usage on this endpoint. Meridian
// uses the same path to render its dashboard. Shape observed on Team plans:
//   {
//     "five_hour":     {"utilization": 0.34, "resets_at": "2026-..."},
//     "seven_day":     {"utilization": 0.07, "resets_at": "2026-..."},
//     "seven_day_opus":{"utilization": 0.13, "resets_at": "2026-..."}
//   }
// The exact key names have varied; we treat the whole thing as best-effort.
const USAGE_URL = "https://api.anthropic.com/v1/usage/quota";

export interface UsageWindow {
  utilization: number | null;
  resets_at: number | null;
}

export interface AccountUsage {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  seven_day_opus: UsageWindow;
  fetched_at: number;
  error: string | null;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

async function accessTokenFor(accountDir: string): Promise<string | null> {
  const creds = await readCredentials(accountDir);
  if (!creds) return null;
  const { accessToken, refreshToken, expiresAt } = creds.claudeAiOauth;
  if (expiresAt - REFRESH_MARGIN_MS > Date.now()) return accessToken;
  try {
    const t = await refreshAccessToken(refreshToken);
    const refreshed: ClaudeCredentials = {
      claudeAiOauth: {
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        expiresAt: t.expires_at,
        scopes: creds.claudeAiOauth.scopes,
      },
    };
    await writeCredentials(accountDir, refreshed);
    return t.access_token;
  } catch (err) {
    log.warn("token refresh failed while fetching usage", { err: String(err) });
    return null;
  }
}

function pickWindow(raw: unknown): UsageWindow {
  if (!raw || typeof raw !== "object") return { utilization: null, resets_at: null };
  const r = raw as Record<string, unknown>;
  const util =
    (typeof r.utilization === "number" && r.utilization) ??
    (typeof r.usage_ratio === "number" && r.usage_ratio) ??
    null;
  const resetIso = r.resets_at ?? r.reset_at ?? r.reset ?? null;
  const resetMs = typeof resetIso === "string" ? Date.parse(resetIso) : null;
  return {
    utilization: typeof util === "number" ? util : null,
    resets_at: Number.isFinite(resetMs) ? resetMs : null,
  };
}

export async function fetchUsage(accountDir: string): Promise<AccountUsage> {
  const fetched_at = Date.now();
  const empty: AccountUsage = {
    five_hour: { utilization: null, resets_at: null },
    seven_day: { utilization: null, resets_at: null },
    seven_day_opus: { utilization: null, resets_at: null },
    fetched_at,
    error: null,
  };

  const token = await accessTokenFor(accountDir);
  if (!token) return { ...empty, error: "no valid token" };

  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "balance",
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ...empty, error: `HTTP ${res.status}: ${text.slice(0, 100)}` };
    }
    const body = (await res.json()) as Record<string, unknown>;
    return {
      five_hour: pickWindow(body.five_hour),
      seven_day: pickWindow(body.seven_day),
      seven_day_opus: pickWindow(body.seven_day_opus),
      fetched_at,
      error: null,
    };
  } catch (err) {
    return { ...empty, error: String(err) };
  }
}
