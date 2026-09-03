import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readCredentials, writeCredentials } from "./credentials";
import { refreshAccessToken } from "./oauth";
import { log } from "./log";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Fetch a fresh access token for the account, refreshing on disk if the
// current one is within the expiry margin. Returns null if the account has
// no credentials yet (e.g. added but never OAuth'd).
async function accessTokenFor(accountDir: string): Promise<string | null> {
  const creds = await readCredentials(accountDir);
  if (!creds) return null;
  const { accessToken, refreshToken, expiresAt, scopes } = creds.claudeAiOauth;
  if (expiresAt - REFRESH_MARGIN_MS > Date.now()) return accessToken;
  try {
    log.info("refreshing access token", { dir: accountDir });
    const t = await refreshAccessToken(refreshToken);
    await writeCredentials(accountDir, {
      claudeAiOauth: {
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        expiresAt: t.expires_at,
        scopes,
      },
    });
    return t.access_token;
  } catch (err) {
    log.warn("token refresh failed — Claude Code may prompt for a fresh login", { err: String(err) });
    return accessToken; // return the stale token; Claude Code will surface the auth error
  }
}

// Launch Claude Code as a specific account. On macOS Claude Code checks the
// Keychain for OAuth before falling back to `<CLAUDE_CONFIG_DIR>/.credentials.json`,
// so setting CLAUDE_CONFIG_DIR alone isn't enough to force a specific account
// — CLAUDE_CODE_OAUTH_TOKEN bypasses Keychain entirely and takes precedence.
// stdio is inherited so the user sees Claude Code's TUI directly; balance
// exits with Claude Code's exit code once it's done.
export async function launchClaudeCode(
  claudeConfigDir: string,
  extraArgs: string[] = [],
  binary: string = "claude",
): Promise<void> {
  if (!existsSync(claudeConfigDir)) {
    log.error("account directory not found", { dir: claudeConfigDir });
    process.exit(1);
  }

  const accessToken = await accessTokenFor(claudeConfigDir);
  if (!accessToken) {
    log.error("account has no credentials — run: balance account add", { dir: claudeConfigDir });
    process.exit(1);
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CLAUDE_HOME: claudeConfigDir,
    // Bypass Keychain and any pre-existing login: this token wins.
    CLAUDE_CODE_OAUTH_TOKEN: accessToken,
  };

  const child = spawn(binary, extraArgs, {
    stdio: "inherit",
    env,
  });

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });

  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      log.error(`${binary} not found on PATH — install Claude Code first (npm i -g @anthropic-ai/claude-code)`);
      process.exit(127);
    }
    log.error("failed to launch Claude Code", { err: String(err) });
    process.exit(1);
  });
}
