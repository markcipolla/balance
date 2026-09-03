import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { refreshAccessToken } from "./oauth";
import { readCredentials, writeCredentials, type ClaudeCredentials } from "./credentials";
import { log } from "./log";

// The endpoint Claude Code itself hits for /status. Verified by extracting
// strings from the shipped native binary (/opt/homebrew/Caskroom/claude-code/*).
// Free — doesn't consume tokens.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const CACHE_FILE = "usage-cache.json";
const CACHE_TTL_MS = 60 * 1000;
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
  overage_disabled_reason: string | null;
  fetched_at: number;
  error: string | null;
  // Full raw payload — the shape has moved before and will move again; leaving
  // an escape hatch makes it easier to add new columns without another chase.
  raw: unknown;
}

function emptyUsage(fetched_at: number, error: string | null = null): AccountUsage {
  return {
    five_hour: { utilization: null, resets_at: null, status: null },
    seven_day: { utilization: null, resets_at: null, status: null },
    seven_day_opus: { utilization: null, resets_at: null, status: null },
    overage_status: null,
    overage_disabled_reason: null,
    fetched_at,
    error,
    raw: null,
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

// Parse a window from whichever shape the response happens to use. Anthropic's
// unofficial usage endpoint has renamed fields historically (e.g. "utilization"
// vs "utilization_pct" vs "used_ratio"), so try a few common candidates.
function extractWindow(node: unknown): UsageWindow {
  if (!node || typeof node !== "object") return { utilization: null, resets_at: null, status: null };
  const n = node as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // The API returns utilization as a percentage (0-100), not a ratio (0-1).
  // Normalize to 0-1 so the renderer's `Math.round(v * 100)` produces the
  // right number. Values that happen to already be ≤1 are treated as ratios
  // (rare, but safe).
  const asRatio = (v: number | null): number | null => (v == null ? null : v > 1 ? v / 100 : v);
  const isoOrEpoch = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) {
      return v < 1e12 ? v * 1000 : v;
    }
    if (typeof v === "string") {
      const parsed = Date.parse(v);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };
  return {
    utilization: asRatio(num(n.utilization) ?? num(n.utilization_pct) ?? num(n.used_ratio) ?? num(n.used) ?? null),
    resets_at: isoOrEpoch(n.resets_at) ?? isoOrEpoch(n.reset_at) ?? isoOrEpoch(n.reset) ?? isoOrEpoch(n.window_end) ?? null,
    status: typeof n.status === "string" ? n.status : null,
  };
}

async function readCache(accountDir: string): Promise<AccountUsage | null> {
  const path = join(accountDir, CACHE_FILE);
  if (!existsSync(path)) return null;
  try {
    const cached = JSON.parse(await readFile(path, "utf8")) as AccountUsage;
    if (Date.now() - cached.fetched_at < CACHE_TTL_MS) return cached;
    return null;
  } catch {
    return null;
  }
}

async function writeCache(accountDir: string, usage: AccountUsage): Promise<void> {
  try {
    await writeFile(join(accountDir, CACHE_FILE), JSON.stringify(usage) + "\n", "utf8");
  } catch { /* best-effort */ }
}

export async function fetchUsage(accountDir: string, opts: { force?: boolean } = {}): Promise<AccountUsage> {
  if (!opts.force) {
    const cached = await readCache(accountDir);
    if (cached) return cached;
  }

  const fetched_at = Date.now();
  const token = await accessTokenFor(accountDir);
  if (!token) return emptyUsage(fetched_at, "no valid token");

  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
        "user-agent": "claude-cli/2.1.259 (external, cli)",
        "x-app": "cli",
      },
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const usage = emptyUsage(fetched_at, `HTTP ${res.status}: ${text.slice(0, 100)}`);
      await writeCache(accountDir, usage);
      return usage;
    }

    const raw = (await res.json()) as Record<string, unknown>;
    // The payload wraps usage-window details in some nested shape. Try a few
    // plausible keys and use extractWindow to normalize whichever we find.
    const wrap = (k1: string, ...alts: string[]): unknown => {
      for (const k of [k1, ...alts]) if (raw[k]) return raw[k];
      return null;
    };
    const usage: AccountUsage = {
      five_hour: extractWindow(wrap("five_hour", "5h", "session")),
      seven_day: extractWindow(wrap("seven_day", "7d", "weekly", "week")),
      seven_day_opus: extractWindow(wrap("seven_day_opus", "7d_oi", "weekly_opus")),
      overage_status: typeof raw.overage_status === "string" ? raw.overage_status : null,
      overage_disabled_reason: typeof raw.overage_disabled_reason === "string" ? raw.overage_disabled_reason : null,
      fetched_at,
      error: null,
      raw,
    };
    await writeCache(accountDir, usage);
    return usage;
  } catch (err) {
    return emptyUsage(fetched_at, String(err));
  }
}
