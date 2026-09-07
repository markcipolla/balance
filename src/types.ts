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

// How much of ~/.balance/shared each launch pushes down into the account dir.
// Inert until that directory exists — `balance shared init` creates it.
export interface SharedSettings {
  enabled: boolean;    // master switch for the whole layer
  dirs: string[];      // subdirectories symlinked into every account (skills, agents, commands, plugins)
  mcp: boolean;        // pass shared/mcp.json via --mcp-config
  strict_mcp: boolean; // ...and --strict-mcp-config, ignoring every other MCP source
  connectors: boolean; // hoist each account's claude.ai connectors into shared/mcp.json (implies strict_mcp)
  connector_ttl_hours: number; // how stale an account's connector listing may get before a re-sync
  settings: boolean;   // pass shared/settings.json via --settings
  memory: boolean;     // symlink projects/<slug>/memory at the launch directory
  projects: boolean;   // carry per-project MCP approvals and trust between accounts
}

export interface Config {
  active: string | null;      // name of the account to default to when `balance run` gets no arg
  claude_binary: string;      // path or command name for Claude Code (default "claude")
  log_level: LogLevel;
  shared: SharedSettings;
  accounts: Account[];
}
