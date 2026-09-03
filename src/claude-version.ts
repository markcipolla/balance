import { log } from "./log";

// Public npm URL for the Claude Code CLI. Returns JSON like
// `{"name":"@anthropic-ai/claude-code","version":"2.1.236",...}`.
const NPM_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";

// Baked-in fallback used until the first fetch resolves, or forever if the
// user has no network. Bumped occasionally when releasing balance.
const FALLBACK = "2.1.236";

// Re-check npm at most once per hour when a request happens to notice the
// cache is stale — cheap enough to not warrant a background timer, refreshed
// often enough that the version doesn't drift more than an hour.
const REFRESH_MS = 60 * 60 * 1000;

let cached = FALLBACK;
let lastFetchAt = 0;
let inFlight: Promise<string> | null = null;

async function fetchLatest(): Promise<string> {
  const res = await fetch(NPM_URL, {
    headers: { "user-agent": "balance/version-lookup" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`npm registry HTTP ${res.status}`);
  const body = (await res.json()) as { version?: string };
  if (!body.version || typeof body.version !== "string") {
    throw new Error("npm registry returned no version");
  }
  return body.version;
}

function refresh(): Promise<string> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const v = await fetchLatest();
      cached = v;
      lastFetchAt = Date.now();
      log.info("claude-code version resolved", { version: v });
      return v;
    } catch (err) {
      log.warn("claude-code version fetch failed, using fallback", {
        err: String(err),
        fallback: cached,
      });
      // Poison the timestamp lightly so we retry on next call, but not on
      // every request — 60s cooldown between failed refresh attempts.
      lastFetchAt = Date.now() - REFRESH_MS + 60_000;
      return cached;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// Called once during serve startup. Fire-and-forget: the first requests use
// the fallback, then applyAuth picks up the real version transparently as
// soon as this resolves.
export function primeClaudeVersion(): void {
  refresh().catch(() => {});
}

// Synchronous accessor for hot paths. Kicks off a background refresh if the
// cache is stale, but always returns immediately.
export function getClaudeVersion(): string {
  if (Date.now() - lastFetchAt > REFRESH_MS && !inFlight) refresh().catch(() => {});
  return cached;
}
