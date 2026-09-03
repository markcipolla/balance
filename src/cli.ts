import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ApiKeyConfig, Config, SubscriptionConfig } from "./types";
import {
  addApiKeyUnique,
  addSubscriptionUnique,
  initConfig,
  loadConfig,
  loadConfigLoose,
  writeConfig,
} from "./config";
import { defaultConfigPath } from "./paths";
import { runOAuthLogin } from "./login";

interface ClaudeCredentialsFile {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
  };
}

async function readMaybeStdin(path: string): Promise<string> {
  if (path === "-") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
  return readFile(path, "utf8");
}

function parseSubscriptionFromCreds(raw: string): SubscriptionConfig | null {
  const parsed = JSON.parse(raw) as ClaudeCredentialsFile | Record<string, unknown>;
  const oauth = (parsed as ClaudeCredentialsFile).claudeAiOauth;
  if (oauth?.accessToken && oauth.refreshToken) {
    return {
      name: "imported",
      access_token: oauth.accessToken,
      refresh_token: oauth.refreshToken,
      expires_at: oauth.expiresAt ?? 0,
    };
  }
  const flat = parsed as Partial<SubscriptionConfig>;
  if (flat.access_token && flat.refresh_token) {
    return {
      name: flat.name ?? "imported",
      access_token: flat.access_token,
      refresh_token: flat.refresh_token,
      expires_at: flat.expires_at ?? 0,
    };
  }
  return null;
}

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

export function positional(args: string[]): string[] {
  const out: string[] = [];
  const skip = new Set(["--no-browser"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (!skip.has(a)) i += 1; // skip its value
      continue;
    }
    out.push(a);
  }
  return out;
}

function configPathOf(args: string[]): string {
  return resolve(flag(args, "--config") ?? defaultConfigPath());
}

async function loadOrEmpty(path: string): Promise<Config> {
  return loadConfigLoose(path);
}

async function promptLine(question: string): Promise<string> {
  process.stdout.write(question);
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
    const soFar = Buffer.concat(chunks).toString("utf8");
    if (soFar.includes("\n")) break;
  }
  return Buffer.concat(chunks).toString("utf8").split("\n")[0]!.trim();
}

// ---------- init ----------

export async function runInit(args: string[]): Promise<number> {
  const path = resolve(positional(args)[0] ?? defaultConfigPath());
  await initConfig(path);
  console.log(`Created ${path}. Add a subscription with: balance claude subscription add`);
  return 0;
}

// ---------- subscription: list / add / import / remove ----------

export async function runSubscriptionList(args: string[]): Promise<number> {
  const cfg = await loadConfig(configPathOf(args));
  const subs = cfg.claude.subscriptions;
  if (subs.length === 0) {
    console.log("No Claude subscriptions.");
    return 0;
  }
  const now = Date.now();
  console.log(`Claude subscriptions (${subs.length}):`);
  for (const s of subs) {
    const exp = s.expires_at ? `expires in ${Math.round((s.expires_at - now) / 1000)}s` : "no expiry set";
    console.log(`  - ${s.name.padEnd(24)} ${exp}`);
  }
  return 0;
}

export async function runSubscriptionAdd(args: string[]): Promise<number> {
  const configPath = configPathOf(args);
  const name = flag(args, "--name") ?? null;
  const noOpen = args.includes("--no-browser");

  const result = await runOAuthLogin({ name, open: !noOpen });

  const cfg = await loadOrEmpty(configPath);
  addSubscriptionUnique(cfg, result.account);
  await writeConfig(configPath, cfg);
  const who = result.email ? ` (${result.email})` : "";
  console.log(`\nAdded subscription "${result.account.name}"${who} to ${configPath} (${cfg.claude.subscriptions.length} total).`);
  return 0;
}

export async function runSubscriptionImport(args: string[]): Promise<number> {
  const pos = positional(args);
  const src = pos[0];
  if (!src) {
    console.error("usage: balance claude subscription import <path-to-credentials.json>|- [--name <name>] [--config <path>]");
    return 2;
  }
  const configPath = configPathOf(args);
  const name = flag(args, "--name");

  const raw = await readMaybeStdin(src);
  const sub = parseSubscriptionFromCreds(raw);
  if (!sub) {
    console.error("Could not find OAuth credentials in the input.");
    console.error("Expected: {\"claudeAiOauth\":{\"accessToken\":\"...\",\"refreshToken\":\"...\",\"expiresAt\":...}}");
    return 2;
  }
  if (name) sub.name = name;

  const cfg = await loadOrEmpty(configPath);
  addSubscriptionUnique(cfg, sub);
  await writeConfig(configPath, cfg);
  console.log(`Added subscription "${sub.name}" to ${configPath} (${cfg.claude.subscriptions.length} total).`);
  return 0;
}

export async function runSubscriptionRemove(args: string[]): Promise<number> {
  const name = positional(args)[0];
  if (!name) {
    console.error("usage: balance claude subscription remove <name> [--config <path>]");
    return 2;
  }
  const configPath = configPathOf(args);
  const cfg = await loadConfigLoose(configPath);
  const before = cfg.claude.subscriptions.length;
  cfg.claude.subscriptions = cfg.claude.subscriptions.filter((s) => s.name !== name);
  if (cfg.claude.subscriptions.length === before) {
    console.error(`No subscription named "${name}".`);
    return 1;
  }
  await writeConfig(configPath, cfg);
  console.log(`Removed subscription "${name}" (${cfg.claude.subscriptions.length} remaining).`);
  return 0;
}

// ---------- api: list / add / remove ----------

function maskKey(key: string): string {
  if (key.length <= 12) return "***";
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

export async function runApiList(args: string[]): Promise<number> {
  const cfg = await loadConfig(configPathOf(args));
  const keys = cfg.claude.api_keys;
  if (keys.length === 0) {
    console.log("No API keys.");
    return 0;
  }
  console.log(`Claude API keys (${keys.length}):`);
  for (const k of keys) {
    console.log(`  - ${k.name.padEnd(24)} ${maskKey(k.key)}`);
  }
  return 0;
}

export async function runApiAdd(args: string[]): Promise<number> {
  const configPath = configPathOf(args);
  const name = flag(args, "--name");
  const keyFromFlag = flag(args, "--key");
  const pos = positional(args);
  // Order of precedence: --key flag > first positional > stdin.
  let key = keyFromFlag ?? pos[0] ?? null;
  if (!key) {
    key = await promptLine("Paste API key (sk-ant-api03-...): ");
  }
  if (!key || !key.startsWith("sk-ant-")) {
    console.error("That doesn't look like an Anthropic API key (expected sk-ant-...).");
    return 2;
  }

  const chosenName = name ?? `key-${new Date().toISOString().slice(0, 10)}`;
  const entry: ApiKeyConfig = { name: chosenName, key };

  const cfg = await loadOrEmpty(configPath);
  addApiKeyUnique(cfg, entry);
  await writeConfig(configPath, cfg);
  console.log(`Added API key "${entry.name}" (${maskKey(entry.key)}) to ${configPath} (${cfg.claude.api_keys.length} total).`);
  return 0;
}

export async function runApiRemove(args: string[]): Promise<number> {
  const name = positional(args)[0];
  if (!name) {
    console.error("usage: balance claude api remove <name> [--config <path>]");
    return 2;
  }
  const configPath = configPathOf(args);
  const cfg = await loadConfigLoose(configPath);
  const before = cfg.claude.api_keys.length;
  cfg.claude.api_keys = cfg.claude.api_keys.filter((k) => k.name !== name);
  if (cfg.claude.api_keys.length === before) {
    console.error(`No API key named "${name}".`);
    return 1;
  }
  await writeConfig(configPath, cfg);
  console.log(`Removed API key "${name}" (${cfg.claude.api_keys.length} remaining).`);
  return 0;
}

// ---------- usage / dispatch ----------

export function usage(): string {
  return `balance — pool multiple Claude accounts behind an Anthropic-compatible endpoint

usage:
  balance serve   [--config <path>]                            start the proxy server
  balance init    [<config-path>]                              create an empty config.json
  balance status  [--config <path>]                            live pool status (queries running server)

  balance claude subscription list                             list Claude subscriptions
  balance claude subscription add    [--name <n>] [--no-browser]  run OAuth flow, add a subscription
  balance claude subscription import <file>|- [--name <n>]     import a Claude Code credentials file
  balance claude subscription remove <name>                    remove a subscription

  balance claude api list                                      list Claude API keys (masked)
  balance claude api add    [<key>|--key <key>] [--name <n>]   add an API key (prompts if omitted)
  balance claude api remove <name>                             remove an API key

aliases (flat):
  balance login    → balance claude subscription add
  balance list     → shows subscriptions AND api keys
  balance add      → balance claude subscription import
  balance remove   → removes by name from whichever bucket contains it

flags:
  --config <path>  config file (default: ~/.balance/config.json, auto-created on first write)

env:
  BALANCE_PORT, BALANCE_HOST, BALANCE_AUTH_TOKEN, BALANCE_LOG_LEVEL

point a client at http://127.0.0.1:8787 with:
  ANTHROPIC_BASE_URL=http://127.0.0.1:8787
  ANTHROPIC_API_KEY=any-value      (or the auth_token from config)
`;
}

// ---------- flat aliases ----------

export async function runFlatList(args: string[]): Promise<number> {
  await runSubscriptionList(args);
  console.log();
  await runApiList(args);
  return 0;
}

export async function runFlatRemove(args: string[]): Promise<number> {
  const name = positional(args)[0];
  if (!name) {
    console.error("usage: balance remove <name> [--config <path>]");
    return 2;
  }
  const configPath = configPathOf(args);
  const cfg = await loadConfigLoose(configPath);
  const subHit = cfg.claude.subscriptions.some((s) => s.name === name);
  const keyHit = cfg.claude.api_keys.some((k) => k.name === name);
  if (subHit && keyHit) {
    console.error(`"${name}" exists as both a subscription and an API key. Use 'balance claude subscription remove' or 'balance claude api remove'.`);
    return 2;
  }
  if (subHit) return runSubscriptionRemove(args);
  if (keyHit) return runApiRemove(args);
  console.error(`No subscription or API key named "${name}".`);
  return 1;
}
