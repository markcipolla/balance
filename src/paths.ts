import { homedir } from "node:os";
import { join } from "node:path";

export function defaultConfigPath(): string {
  return join(baseDir(), "config.json");
}

// Everything balance owns lives under here. BALANCE_HOME relocates the lot,
// which is what lets the test suite run against a temp dir instead of the
// real ~/.balance — and is a useful escape hatch besides.
export function baseDir(): string {
  return process.env.BALANCE_HOME ?? join(homedir(), ".balance");
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
