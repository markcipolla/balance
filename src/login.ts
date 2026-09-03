import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { SubscriptionConfig } from "./types";

// Claude Code's OAuth client. Public — ships in the Claude Code binary.
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
// The "manual paste" redirect URI Anthropic hosts — the browser lands there,
// shows the code, the user copies it back to the terminal. Avoids binding a
// local port and works over SSH.
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = ["org:create_api_key", "user:profile", "user:inference"];

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function openInBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open"
    : platform() === "win32" ? "cmd"
    : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // Fall through — the user still sees the URL printed and can open it manually.
  }
}

async function prompt(question: string): Promise<string> {
  process.stdout.write(question);
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
    const so_far = Buffer.concat(chunks).toString("utf8");
    if (so_far.includes("\n")) break;
  }
  return Buffer.concat(chunks).toString("utf8").split("\n")[0]!.trim();
}

export interface LoginResult {
  account: SubscriptionConfig;
  email: string | null;
}

export async function runOAuthLogin(opts: {
  name: string | null;
  open: boolean;
}): Promise<LoginResult> {
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(24));

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  const authorizeUrl = url.toString();

  process.stdout.write("\n");
  process.stdout.write("Open this URL in a browser, sign in to the Claude account you want to add,\n");
  process.stdout.write("then paste the code (the value after 'code=' on the resulting page).\n");
  process.stdout.write("\n");
  process.stdout.write(`  ${authorizeUrl}\n`);
  process.stdout.write("\n");

  if (opts.open) openInBrowser(authorizeUrl);

  const raw = await prompt("Paste code#state (or just code): ");
  if (!raw) throw new Error("no code entered");

  // Anthropic's callback page shows the code as `<code>#<state>`. Accept
  // either form and verify state if present.
  let code = raw;
  let pastedState: string | null = null;
  const hashIdx = raw.indexOf("#");
  if (hashIdx > 0) {
    code = raw.slice(0, hashIdx);
    pastedState = raw.slice(hashIdx + 1);
  }
  if (pastedState && pastedState !== state) {
    throw new Error("state mismatch — did you paste from a different login?");
  }

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "balance/0.1" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      state,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    throw new Error(`token exchange failed: HTTP ${tokenRes.status} ${body.slice(0, 300)}`);
  }

  const body = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    account?: { email_address?: string; uuid?: string };
  };

  if (!body.access_token || !body.refresh_token || typeof body.expires_in !== "number") {
    throw new Error("token exchange returned unexpected payload");
  }

  const email = body.account?.email_address ?? null;
  const accountName = opts.name ?? email ?? `account-${Date.now()}`;

  return {
    account: {
      name: accountName,
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: Date.now() + body.expires_in * 1000,
    },
    email,
  };
}
