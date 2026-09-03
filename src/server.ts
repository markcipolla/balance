import type { Config } from "./types";

type BunServer = ReturnType<typeof Bun.serve>;
import { AccountPool } from "./pool";
import { forwardWithPool } from "./forward";
import { log } from "./log";

const PROXIED_PATH_PREFIXES = ["/v1/messages", "/v1/complete"];

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "unauthorized" },
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

function checkAuth(cfg: Config, req: Request): boolean {
  if (!cfg.auth_token) return true;
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${cfg.auth_token}`) return true;
  const key = req.headers.get("x-api-key");
  if (key === cfg.auth_token) return true;
  return false;
}

function stripHopByHopResponseHeaders(h: Headers): Headers {
  const out = new Headers();
  const skip = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-encoding", // Bun's fetch already decodes; passing this through would confuse the downstream client
    "content-length",   // may be wrong once we've buffered/streamed
  ]);
  for (const [k, v] of h.entries()) {
    if (skip.has(k.toLowerCase())) continue;
    out.set(k, v);
  }
  return out;
}

function statusJson(pool: AccountPool): Response {
  const body = {
    accounts: pool.all().map((a) => a.snapshot()),
    now: new Date().toISOString(),
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json" },
  });
}

function staticModels(): Response {
  const body = {
    data: [
      { id: "claude-opus-4-5", type: "model" },
      { id: "claude-sonnet-4-5", type: "model" },
      { id: "claude-haiku-4-5", type: "model" },
      { id: "claude-3-7-sonnet-latest", type: "model" },
      { id: "claude-3-5-haiku-latest", type: "model" },
    ],
    has_more: false,
    first_id: null,
    last_id: null,
  };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function isProxied(pathname: string): boolean {
  return PROXIED_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export function startServer(cfg: Config, pool: AccountPool): BunServer {
  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    idleTimeout: 255, // seconds; Bun caps at 255. Long-running streams need this.
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const started = Date.now();

      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ ok: true, accounts: pool.size() }), {
          headers: { "content-type": "application/json" },
        });
      }

      if (url.pathname === "/status") {
        if (!checkAuth(cfg, req)) return unauthorized();
        return statusJson(pool);
      }

      if (url.pathname === "/v1/models" && req.method === "GET") {
        if (!checkAuth(cfg, req)) return unauthorized();
        return staticModels();
      }

      if (!isProxied(url.pathname)) {
        return new Response(
          JSON.stringify({ type: "error", error: { type: "not_found_error", message: `no route for ${url.pathname}` } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      if (!checkAuth(cfg, req)) return unauthorized();

      const bodyText = req.method === "GET" || req.method === "HEAD"
        ? null
        : await req.text();

      const upstreamPath = url.pathname + url.search;
      const { result, accountName, attempts } = await forwardWithPool(
        pool,
        cfg,
        upstreamPath,
        req.method,
        req.headers,
        bodyText,
      );

      const durationMs = Date.now() - started;
      log.info("request", {
        method: req.method,
        path: url.pathname,
        status: result.status,
        account: accountName ?? "-",
        attempts,
        ms: durationMs,
      });

      if (!result.ok && result.status === 429) {
        const headers = stripHopByHopResponseHeaders(result.headers);
        headers.set("content-type", "application/json");
        return new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "rate_limit_error",
              message: `all accounts rate-limited (last: ${result.errorText ?? ""})`.trim(),
            },
          }),
          { status: 429, headers },
        );
      }

      if (result.body) {
        const headers = stripHopByHopResponseHeaders(result.headers);
        return new Response(result.body, { status: result.status, headers });
      }

      const errText = result.errorText ?? "";
      return new Response(
        errText || JSON.stringify({ type: "error", error: { type: "api_error", message: `HTTP ${result.status}` } }),
        {
          status: result.status,
          headers: errText.startsWith("{")
            ? { "content-type": "application/json" }
            : { "content-type": "text/plain" },
        },
      );
    },
  });

  log.info("balance listening", {
    url: `http://${cfg.host}:${cfg.port}`,
    accounts: pool.size(),
  });
  return server;
}
