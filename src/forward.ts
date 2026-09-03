import type { Account } from "./account";
import type { AccountPool } from "./pool";
import type { AttemptResult, Config } from "./types";
import { injectClaudeCodeIdentity } from "./transform";
import { getClaudeVersion } from "./claude-version";
import { dumpForwarded } from "./dump";
import { log } from "./log";

// Set by index.ts when serve is started with --dump-forwarded. Every attempt
// logs its transformed outgoing request to this file.
let forwardedDumpPath: string | null = null;
export function setForwardedDumpPath(p: string | null): void {
  forwardedDumpPath = p;
}

// Headers we always drop from the incoming request before forwarding: hop-by-hop
// per RFC 7230, plus client-auth headers that our proxy replaces per-account.
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "authorization",
  "x-api-key",
  "anthropic-organization-id",
]);

async function buildUpstreamHeaders(
  incoming: Headers,
  account: Account,
): Promise<Headers> {
  const h = new Headers();
  for (const [k, v] of incoming.entries()) {
    if (STRIPPED_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    h.set(k, v);
  }
  if (!h.has("anthropic-version")) h.set("anthropic-version", "2023-06-01");
  if (!h.has("user-agent")) h.set("user-agent", `claude-cli/${getClaudeVersion()} (external, cli)`);
  // applyAuth may overwrite user-agent (subscriptions do, so Anthropic routes
  // as Claude Code subscription usage instead of paid extra usage).
  await account.applyAuth(h);
  return h;
}

function parseRetryAfter(headers: Headers): number | null {
  const ra = headers.get("retry-after");
  if (!ra) return null;
  const n = Number(ra);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(ra);
  if (Number.isFinite(t)) return Math.max(1, Math.round((t - Date.now()) / 1000));
  return null;
}

function parseRateLimitReset(headers: Headers): number | null {
  const iso = headers.get("anthropic-ratelimit-unified-reset")
    ?? headers.get("anthropic-ratelimit-requests-reset")
    ?? headers.get("anthropic-ratelimit-tokens-reset");
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(1, Math.round((t - Date.now()) / 1000));
}

async function readErrorText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return "";
  }
}

interface AnthropicErrorInfo {
  type: string | null;
  message: string | null;
}

function parseAnthropicError(body: string): AnthropicErrorInfo {
  try {
    const parsed = JSON.parse(body) as { error?: { type?: string; message?: string } };
    return {
      type: parsed.error?.type ?? null,
      message: parsed.error?.message ?? null,
    };
  } catch {
    return { type: null, message: body || null };
  }
}

// Some upstream errors mean the account can't serve this request or any other
// one until its billing / quota window changes, but Anthropic returns them as
// plain 400s / 403s (not 429). Recognize the common shapes so the pool marks
// the account unusable and retries on the next available account instead of
// bubbling the error up to the client on the first attempt.
function classifyAccountUnusable(
  status: number,
  info: AnthropicErrorInfo,
): { unusable: true; reason: string; cooldownSeconds: number } | null {
  if (status !== 400 && status !== 402 && status !== 403) return null;
  const msg = (info.message ?? "").toLowerCase();

  // API key: pay-as-you-go account with no balance.
  if (msg.includes("credit balance") || msg.includes("credits balance") || msg.includes("insufficient credit")) {
    return { unusable: true, reason: "no credit", cooldownSeconds: 10 * 60 };
  }

  // OAuth subscription: exhausted for the current billing / weekly / 5-hour window.
  // Anthropic phrases these several ways — match on the recurring stems.
  const subscriptionExhausted =
    msg.includes("out of") && (msg.includes("usage") || msg.includes("extra")) ||
    msg.includes("quota exceeded") ||
    msg.includes("reached your") && msg.includes("limit") ||
    msg.includes("workspace admin") ||
    msg.includes("usage limit") ||
    info.type === "permission_error" && msg.includes("subscription");
  if (subscriptionExhausted) {
    return { unusable: true, reason: "quota exhausted", cooldownSeconds: 10 * 60 };
  }

  return null;
}

async function attempt(
  account: Account,
  cfg: Config,
  upstreamPath: string,
  method: string,
  headers: Headers,
  body: string | null,
): Promise<AttemptResult> {
  const forwardHeaders = await buildUpstreamHeaders(headers, account);
  const url = new URL(upstreamPath, cfg.upstream).toString();

  if (forwardedDumpPath) {
    await dumpForwarded(forwardedDumpPath, account.name, method, url, forwardHeaders, body);
  }

  account.begin();
  try {
    const res = await fetch(url, {
      method,
      headers: forwardHeaders,
      body,
      redirect: "manual",
    });
    account.recordUpstreamHeaders(res.headers);

    if (res.ok) {
      return {
        ok: true,
        status: res.status,
        headers: res.headers,
        body: res.body,
        retryable: false,
        cooldownSeconds: null,
        errorText: null,
      };
    }

    if (res.status === 429 || res.status === 529) {
      const retryAfter = parseRetryAfter(res.headers) ?? parseRateLimitReset(res.headers) ?? 60;
      const errorText = await readErrorText(res);
      account.markLimited(retryAfter, `HTTP ${res.status}`);
      return {
        ok: false,
        status: res.status,
        headers: res.headers,
        body: null,
        retryable: true,
        cooldownSeconds: retryAfter,
        errorText,
      };
    }

    if (res.status === 401) {
      // Token was rejected — force a refresh next time and take this account
      // out of rotation briefly so we don't hot-loop on it.
      const errorText = await readErrorText(res);
      account.markLimited(30, "HTTP 401");
      return {
        ok: false,
        status: res.status,
        headers: res.headers,
        body: null,
        retryable: true,
        cooldownSeconds: 30,
        errorText,
      };
    }

    if (res.status >= 500) {
      const errorText = await readErrorText(res);
      return {
        ok: false,
        status: res.status,
        headers: res.headers,
        body: null,
        retryable: true,
        cooldownSeconds: null,
        errorText,
      };
    }

    // Some 400/403 responses mean the account itself is spent for now (subs
    // out of usage, API keys with no credit). Recognize them and treat like a
    // long-cooldown 429 so the pool moves to the next account.
    if (res.status === 400 || res.status === 402 || res.status === 403) {
      const errorText = await readErrorText(res);
      const info = parseAnthropicError(errorText);
      const verdict = classifyAccountUnusable(res.status, info);
      if (verdict) {
        account.markLimited(verdict.cooldownSeconds, verdict.reason);
        return {
          ok: false,
          status: res.status,
          headers: res.headers,
          body: null,
          retryable: true,
          cooldownSeconds: verdict.cooldownSeconds,
          errorText,
        };
      }
      // Not an account-unusable error — surface as a normal client error.
      return {
        ok: false,
        status: res.status,
        headers: res.headers,
        body: null,
        retryable: false,
        cooldownSeconds: null,
        errorText,
      };
    }

    // Other 4xx: client error, don't retry on another account —
    // the same request will fail the same way there. Surface it upstream.
    return {
      ok: false,
      status: res.status,
      headers: res.headers,
      body: res.body,
      retryable: false,
      cooldownSeconds: null,
      errorText: null,
    };
  } finally {
    account.end();
  }
}

// Attempt a request across the pool. For streaming responses we return the
// first non-retryable body directly — retrying mid-stream is not possible.
export async function forwardWithPool(
  pool: AccountPool,
  cfg: Config,
  upstreamPath: string,
  method: string,
  headers: Headers,
  rawBody: string | null,
): Promise<{ result: AttemptResult; accountName: string | null; attempts: number }> {
  let outgoing: string | null = rawBody;
  let parsedBody: Record<string, unknown> | null = null;
  const isJson = (headers.get("content-type") ?? "").toLowerCase().includes("application/json");

  if (isJson && rawBody && cfg.inject_claude_code_identity) {
    try {
      parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
      const transformed = injectClaudeCodeIdentity(parsedBody, getClaudeVersion());
      outgoing = JSON.stringify(transformed);
    } catch {
      // Not valid JSON despite the header — forward as-is.
      outgoing = rawBody;
    }
  }

  const order = pool.nextOrder();
  let attempts = 0;
  let lastResult: AttemptResult | null = null;
  let lastAccount: string | null = null;

  const hasAnyAvailable = order.some((a) => a.isAvailable());
  if (!hasAnyAvailable) {
    const cooldownMs = pool.minCooldownMs();
    const retryAfter = Math.max(1, Math.ceil(cooldownMs / 1000));
    const h = new Headers({ "content-type": "application/json", "retry-after": String(retryAfter) });
    return {
      result: {
        ok: false,
        status: 429,
        headers: h,
        body: null,
        retryable: true,
        cooldownSeconds: retryAfter,
        errorText: `all ${pool.size()} accounts on cooldown (soonest reset in ${retryAfter}s)`,
      },
      accountName: null,
      attempts: 0,
    };
  }

  for (const account of order) {
    if (!account.isAvailable() && lastResult && lastResult.retryable) {
      // We already exhausted available accounts and are now looking at ones
      // still on cooldown — stop and let the caller surface the last error.
      break;
    }
    attempts += 1;
    lastAccount = account.name;
    log.debug("forwarding", { account: account.name, attempt: attempts });
    try {
      const r = await attempt(account, cfg, upstreamPath, method, headers, outgoing);
      lastResult = r;
      if (r.ok || !r.retryable) return { result: r, accountName: account.name, attempts };
      log.warn("attempt failed, will retry on next account", {
        account: account.name,
        status: r.status,
        error: r.errorText ?? "",
      });
    } catch (err) {
      log.error("attempt threw", { account: account.name, err: String(err) });
      lastResult = {
        ok: false,
        status: 502,
        headers: new Headers(),
        body: null,
        retryable: true,
        cooldownSeconds: null,
        errorText: String(err),
      };
    }
  }

  return {
    result: lastResult ?? {
      ok: false,
      status: 503,
      headers: new Headers(),
      body: null,
      retryable: false,
      cooldownSeconds: null,
      errorText: "no accounts available",
    },
    accountName: lastAccount,
    attempts,
  };
}
