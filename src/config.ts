import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { Account, Config, LogLevel } from "./types";
import { accountDir, baseDir } from "./paths";
import { writeCredentials } from "./credentials";
import { log } from "./log";

const DEFAULTS: Omit<Config, "accounts"> = {
  active: null,
  claude_binary: "claude",
  log_level: "info",
};

// Old (v0.x) config shape balance used when it was a proxy. Migrated to the
// new per-account-dir layout on load — credentials get lifted into isolated
// CLAUDE_CONFIG_DIRs and the inline tokens are dropped from config.json.
interface LegacyConfig {
  claude?: {
    subscriptions?: Array<{
      name: string;
      access_token: string;
      refresh_token: string;
      expires_at: number;
    }>;
  };
  accounts?: unknown;
}

export function emptyConfig(): Config {
  return { ...DEFAULTS, accounts: [] };
}

async function migrateLegacy(raw: LegacyConfig): Promise<Config> {
  const migrated = emptyConfig();
  const subs = raw.claude?.subscriptions ?? [];
  const now = Date.now();
  for (const s of subs) {
    if (!s.name || !s.access_token || !s.refresh_token) continue;
    const dir = accountDir(s.name);
    await writeCredentials(dir, {
      claudeAiOauth: {
        accessToken: s.access_token,
        refreshToken: s.refresh_token,
        expiresAt: s.expires_at ?? 0,
        scopes: ["user:profile", "user:inference"],
      },
    });
    migrated.accounts.push({
      name: s.name,
      email: null,
      last_used_at: null,
      added_at: now,
    });
    log.info("migrated legacy subscription into isolated account dir", { name: s.name, dir });
  }
  if (migrated.accounts.length > 0) migrated.active = migrated.accounts[0]!.name;
  return migrated;
}

function isLegacy(parsed: unknown): parsed is LegacyConfig {
  if (!parsed || typeof parsed !== "object") return false;
  const p = parsed as Record<string, unknown>;
  return "claude" in p && !Array.isArray(p.accounts);
}

export async function loadConfig(path: string): Promise<Config> {
  if (!existsSync(path)) return emptyConfig();
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (isLegacy(parsed)) {
    const migrated = await migrateLegacy(parsed as LegacyConfig);
    await writeConfig(path, migrated);
    log.info("migrated legacy config.json to the new per-account-dir layout");
    return migrated;
  }

  const cfg = parsed as Partial<Config>;
  return {
    ...DEFAULTS,
    ...cfg,
    accounts: Array.isArray(cfg.accounts) ? cfg.accounts : [],
  };
}

export async function writeConfig(path: string, cfg: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

export function findAccount(cfg: Config, name: string): Account | null {
  return cfg.accounts.find((a) => a.name === name) ?? null;
}

export function addAccount(cfg: Config, account: Account): Account {
  const existing = new Set(cfg.accounts.map((a) => a.name));
  if (existing.has(account.name)) {
    let n = 2;
    while (existing.has(`${account.name}-${n}`)) n += 1;
    account.name = `${account.name}-${n}`;
  }
  cfg.accounts.push(account);
  if (!cfg.active) cfg.active = account.name;
  return account;
}

export function removeAccount(cfg: Config, name: string): boolean {
  const before = cfg.accounts.length;
  cfg.accounts = cfg.accounts.filter((a) => a.name !== name);
  if (cfg.active === name) cfg.active = cfg.accounts[0]?.name ?? null;
  return cfg.accounts.length < before;
}

export function envOverride(cfg: Config): Config {
  const claude_binary = process.env.BALANCE_CLAUDE_BINARY ?? cfg.claude_binary;
  const log_level = (process.env.BALANCE_LOG_LEVEL as LogLevel | undefined) ?? cfg.log_level;
  return { ...cfg, claude_binary, log_level };
}

// Kept for compatibility with tools that still call these — no-ops now that
// we no longer refresh tokens from within balance's own state.
export function persistSubscriptionUpdate(): Promise<void> { return Promise.resolve(); }
export function loadConfigLoose(path: string): Promise<Config> { return loadConfig(path); }
export function initConfig(path: string): Promise<void> { return writeConfig(path, emptyConfig()); }
