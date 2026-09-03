import { homedir } from "node:os";
import { join } from "node:path";

export function defaultConfigPath(): string {
  return join(baseDir(), "config.json");
}

export function baseDir(): string {
  return join(homedir(), ".balance");
}

// Each account lives in its own isolated CLAUDE_CONFIG_DIR under here — so
// Claude Code reads the right credentials, sessions, and settings per account
// without touching the machine's default ~/.claude.
export function accountsDir(): string {
  return join(baseDir(), "accounts");
}

export function accountDir(name: string): string {
  return join(accountsDir(), name);
}
