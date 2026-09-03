import { existsSync } from "node:fs";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ApiKeyConfig,
  ClaudeAccountsConfig,
  Config,
  LegacyConfigShape,
  LogLevel,
  SubscriptionConfig,
} from "./types";
import { log } from "./log";

const DEFAULTS: Omit<Config, "claude"> = {
  host: "127.0.0.1",
  port: 8787,
  upstream: "https://api.anthropic.com",
  auth_token: null,
  inject_claude_code_identity: true,
  log_level: "info",
};

const EMPTY_CLAUDE: ClaudeAccountsConfig = {
  subscriptions: [],
  api_keys: [],
};

function normalizeClaude(
  parsed: (Partial<Config> & LegacyConfigShape) | undefined,
): ClaudeAccountsConfig {
  const claude = parsed?.claude ?? { ...EMPTY_CLAUDE };
  const legacy = parsed?.accounts;
  const subs = claude.subscriptions ?? [];
  const migrated = legacy && subs.length === 0 ? legacy : subs;
  return {
    subscriptions: migrated ?? [],
    api_keys: claude.api_keys ?? [],
  };
}

export function emptyConfig(): Config {
  return { ...DEFAULTS, claude: { subscriptions: [], api_keys: [] } };
}

export function parseConfig(raw: string): Config {
  const parsed = JSON.parse(raw) as (Partial<Config> & LegacyConfigShape) | undefined;
  return {
    ...DEFAULTS,
    ...parsed,
    claude: normalizeClaude(parsed),
  };
}

export async function loadConfigLoose(path: string): Promise<Config> {
  if (!existsSync(path)) return emptyConfig();
  return parseConfig(await readFile(path, "utf8"));
}

export async function loadConfig(path: string): Promise<Config> {
  if (!existsSync(path)) {
    throw new Error(
      `Config not found at ${path}. Add an account first: balance claude subscription add`,
    );
  }
  const cfg = parseConfig(await readFile(path, "utf8"));
  const total = cfg.claude.subscriptions.length + cfg.claude.api_keys.length;
  if (total === 0) {
    throw new Error(
      `Config at ${path} has no Claude accounts. Add one with: balance claude subscription add`,
    );
  }
  for (const s of cfg.claude.subscriptions) {
    if (!s.name) throw new Error("Every subscription must have a name.");
    if (!s.access_token) throw new Error(`Subscription ${s.name} missing access_token.`);
    if (!s.refresh_token) throw new Error(`Subscription ${s.name} missing refresh_token.`);
    if (typeof s.expires_at !== "number") s.expires_at = 0;
  }
  for (const k of cfg.claude.api_keys) {
    if (!k.name) throw new Error("Every API key must have a name.");
    if (!k.key) throw new Error(`API key ${k.name} missing 'key'.`);
  }
  return cfg;
}

function serialize(cfg: Config): string {
  const clean: Config = {
    host: cfg.host,
    port: cfg.port,
    upstream: cfg.upstream,
    auth_token: cfg.auth_token,
    inject_claude_code_identity: cfg.inject_claude_code_identity,
    log_level: cfg.log_level,
    claude: {
      subscriptions: cfg.claude.subscriptions,
      api_keys: cfg.claude.api_keys,
    },
  };
  return JSON.stringify(clean, null, 2) + "\n";
}

export async function writeConfig(path: string, cfg: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, serialize(cfg), "utf8");
  await rename(tmp, path);
}

let saveInFlight: Promise<void> = Promise.resolve();

export function persistSubscriptionUpdate(
  path: string,
  name: string,
  patch: Partial<SubscriptionConfig>,
): Promise<void> {
  saveInFlight = saveInFlight.then(async () => {
    try {
      const cfg = await loadConfigLoose(path);
      const idx = cfg.claude.subscriptions.findIndex((a) => a.name === name);
      if (idx === -1) return;
      cfg.claude.subscriptions[idx] = { ...cfg.claude.subscriptions[idx]!, ...patch };
      await writeConfig(path, cfg);
    } catch (err) {
      log.error("failed to persist subscription update", { name, err: String(err) });
    }
  });
  return saveInFlight;
}

export async function initConfig(path: string): Promise<void> {
  if (existsSync(path)) {
    throw new Error(`${path} already exists.`);
  }
  await writeConfig(path, emptyConfig());
}

export function envOverride(cfg: Config): Config {
  const port = process.env.BALANCE_PORT ? Number(process.env.BALANCE_PORT) : cfg.port;
  const host = process.env.BALANCE_HOST ?? cfg.host;
  const auth_token = process.env.BALANCE_AUTH_TOKEN ?? cfg.auth_token;
  const log_level = (process.env.BALANCE_LOG_LEVEL as LogLevel | undefined) ?? cfg.log_level;
  return { ...cfg, port, host, auth_token, log_level };
}

export function addSubscriptionUnique(
  cfg: Config,
  sub: SubscriptionConfig,
): SubscriptionConfig {
  const existing = new Set(cfg.claude.subscriptions.map((s) => s.name));
  if (existing.has(sub.name)) {
    let n = 2;
    while (existing.has(`${sub.name}-${n}`)) n += 1;
    sub.name = `${sub.name}-${n}`;
  }
  cfg.claude.subscriptions.push(sub);
  return sub;
}

export function addApiKeyUnique(cfg: Config, key: ApiKeyConfig): ApiKeyConfig {
  const existing = new Set(cfg.claude.api_keys.map((k) => k.name));
  if (existing.has(key.name)) {
    let n = 2;
    while (existing.has(`${key.name}-${n}`)) n += 1;
    key.name = `${key.name}-${n}`;
  }
  cfg.claude.api_keys.push(key);
  return key;
}
