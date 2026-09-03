export type LogLevel = "debug" | "info" | "warn" | "error";

// One Claude Code account managed by balance. Credentials live in an isolated
// per-account CLAUDE_CONFIG_DIR (accountDir(name)); this record is just the
// tracking metadata.
export interface Account {
  name: string;
  email: string | null;
  last_used_at: number | null;
  added_at: number;
}

export interface Config {
  active: string | null;      // name of the account to default to when `balance run` gets no arg
  claude_binary: string;      // path or command name for Claude Code (default "claude")
  log_level: LogLevel;
  accounts: Account[];
}
