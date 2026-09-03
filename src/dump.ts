import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "./types";
import { log } from "./log";

interface DumpEntry {
  ts: string;
  direction: "request" | "response";
  method?: string;
  path?: string;
  status?: number;
  headers: Record<string, string>;
  body?: string;
}

// Never write these header values verbatim to the dump file — they auth
// against Anthropic and shouldn't leak into a debug artifact the user might
// share. Header key is preserved so we can see IF the header was present.
const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "cookie"]);

function redactHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of h.entries()) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) {
      out[k] = `<redacted len=${v.length}>`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function append(path: string, entry: DumpEntry): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    log.warn("dump write failed", { err: String(err) });
  }
}

export async function dumpRequest(
  path: string,
  method: string,
  urlPath: string,
  headers: Headers,
  body: string | null,
): Promise<void> {
  await append(path, {
    ts: new Date().toISOString(),
    direction: "request",
    method,
    path: urlPath,
    headers: redactHeaders(headers),
    body: body ?? undefined,
  });
}

export async function dumpResponse(
  path: string,
  status: number,
  urlPath: string,
  headers: Headers,
  body: string | null,
): Promise<void> {
  await append(path, {
    ts: new Date().toISOString(),
    direction: "response",
    path: urlPath,
    status,
    headers: redactHeaders(headers),
    body: body ?? undefined,
  });
}

// Log the request balance is about to send upstream, AFTER all transformations
// (billing header injection, identity injection, auth swap, header spoofing).
// Used by `--dump-forwarded` so you can see exactly what Anthropic receives.
export async function dumpForwarded(
  path: string,
  account: string,
  method: string,
  url: string,
  headers: Headers,
  body: string | null,
): Promise<void> {
  await append(path, {
    ts: new Date().toISOString(),
    direction: "request",
    method,
    path: `[forwarded via ${account}] ${url}`,
    headers: redactHeaders(headers),
    body: body ?? undefined,
  });
}

// A truly transparent proxy for use in --dump-requests mode: no auth swap,
// no path canonicalization, no identity-prompt injection. Forwards the raw
// request to upstream, dumps both directions, returns whatever came back.
export async function transparentForward(
  cfg: Config,
  method: string,
  urlPath: string,
  headers: Headers,
  body: string | null,
  dumpPath: string,
): Promise<Response> {
  await dumpRequest(dumpPath, method, urlPath, headers, body);

  const forwardHeaders = new Headers();
  for (const [k, v] of headers.entries()) {
    const lower = k.toLowerCase();
    if (lower === "host" || lower === "content-length") continue;
    forwardHeaders.set(k, v);
  }

  const url = new URL(urlPath, cfg.upstream).toString();
  const res = await fetch(url, {
    method,
    headers: forwardHeaders,
    body,
    redirect: "manual",
  });

  // Buffer the response body so we can dump it AND return it downstream.
  // Streaming responses (SSE) will still be captured whole — acceptable for
  // a diagnostic mode; you can turn it off if bytes matter.
  const bodyText = await res.text();
  await dumpResponse(dumpPath, res.status, urlPath, res.headers, bodyText);

  const outHeaders = new Headers(res.headers);
  outHeaders.delete("content-encoding");
  outHeaders.delete("content-length");
  return new Response(bodyText, { status: res.status, headers: outHeaders });
}
