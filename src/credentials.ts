import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readKeychainCredsFor, writeKeychainCreds } from "./keychain";
import { log } from "./log";
import { refreshAccessToken } from "./oauth";

// Claude Code's native credentials file. When CLAUDE_CONFIG_DIR points at a
// directory containing this, Claude Code reads OAuth creds from here instead
// of the machine's default location — the mechanism that lets one machine
// hold several isolated Claude Code accounts side-by-side.
export interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
  };
}

export async function writeCredentials(dir: string, creds: ClaudeCredentials): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, ".credentials.json");
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(creds, null, 2) + "\n", "utf8");
  await rename(tmp, path);
  // Match Claude Code's expected file mode — creds should not be world-readable.
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

export async function readCredentials(dir: string): Promise<ClaudeCredentials | null> {
  const path = join(dir, ".credentials.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as ClaudeCredentials;
  } catch {
    return null;
  }
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// The account's current credentials, refreshed if near expiry. Every reader
// goes through here so the file, the Keychain and the refresh token stay in
// step — refresh tokens are single-use, so two diverging copies means one dies.
export async function freshCredentials(dir: string): Promise<ClaudeCredentials | null> {
  let creds = await readCredentials(dir);
  const kc = await readKeychainCredsFor(dir);
  if (kc && (!creds || kc.claudeAiOauth.expiresAt > creds.claudeAiOauth.expiresAt)) {
    creds = kc;
    await writeCredentials(dir, creds);
  }
  if (!creds) return null;
  const { refreshToken, expiresAt, scopes } = creds.claudeAiOauth;
  if (expiresAt - REFRESH_MARGIN_MS > Date.now()) return creds;

  log.info("refreshing access token", { dir });
  const t = await refreshAccessToken(refreshToken);
  const refreshed: ClaudeCredentials = {
    claudeAiOauth: { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: t.expires_at, scopes },
  };
  await writeCredentials(dir, refreshed);
  // We just revoked the refresh token the Keychain holds — hand it the new one.
  if (kc) await writeKeychainCreds(refreshed);
  return refreshed;
}
