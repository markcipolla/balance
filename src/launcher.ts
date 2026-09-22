import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { freshCredentials, readCredentials, type ClaudeCredentials } from "./credentials";
import { writeKeychainCreds, setKeychainOwner, isMac } from "./keychain";
import { log } from "./log";

// Returns null if the account has no credentials yet. On refresh failure,
// returns the stale creds so Claude Code surfaces the auth error itself.
async function loadFreshCredentials(accountDir: string): Promise<ClaudeCredentials | null> {
  try {
    return await freshCredentials(accountDir);
  } catch (err) {
    log.warn("token refresh failed — Claude Code may prompt for a fresh login", { err: String(err) });
    return readCredentials(accountDir);
  }
}

// Launch Claude Code as a specific account.
//
// Auth precedence Claude Code TUI uses on macOS:
//   1. macOS Keychain entry ("Claude Code-credentials" service).
//   2. `<CLAUDE_CONFIG_DIR>/.credentials.json` — only checked if Keychain is empty.
//   Env vars like CLAUDE_CODE_OAUTH_TOKEN are honored by SDK/headless mode but
//   NOT by the interactive TUI (verified empirically — the TUI still prompts).
//
// So on macOS we WRITE the account's creds into the Keychain slot before
// launching. There's only one such slot per Mac user, so this also affects
// standalone `claude` invocations outside balance — that's inherent to Claude
// Code's design. On Linux/Windows the file in CLAUDE_CONFIG_DIR is enough.
//
// stdio is inherited; balance exits with Claude Code's exit code.
export async function launchClaudeCode(
  claudeConfigDir: string,
  extraArgs: string[] = [],
  binary: string = "claude",
): Promise<void> {
  if (!existsSync(claudeConfigDir)) {
    log.error("account directory not found", { dir: claudeConfigDir });
    process.exit(1);
  }

  const creds = await loadFreshCredentials(claudeConfigDir);
  if (!creds) {
    log.error("account has no credentials — run: balance account add", { dir: claudeConfigDir });
    process.exit(1);
  }

  if (isMac()) {
    const ok = await writeKeychainCreds(creds);
    if (ok) await setKeychainOwner(claudeConfigDir);
    if (!ok) {
      log.warn("could not update Keychain — Claude Code may launch as a different account or prompt for login");
    }
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CLAUDE_HOME: claudeConfigDir,
    // Belt-and-suspenders: also expose the token via env for SDK/headless paths.
    CLAUDE_CODE_OAUTH_TOKEN: creds.claudeAiOauth.accessToken,
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
