import { log } from "./log";

// Claude Code's public OAuth client id. This is not a secret — it ships in the
// Claude Code CLI binary and is the same for every install.
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";

export interface RefreshedToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<RefreshedToken> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "balance/0.1",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLAUDE_CODE_CLIENT_ID,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token refresh failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!body.access_token || !body.refresh_token || typeof body.expires_in !== "number") {
    throw new Error("token refresh returned unexpected payload");
  }

  const expires_at = Date.now() + body.expires_in * 1000;
  log.debug("token refreshed", { expires_in: body.expires_in });

  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at,
  };
}
