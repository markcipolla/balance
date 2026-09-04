import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Account, Config } from "./types";
import {
  addAccount,
  emptyConfig,
  envOverride,
  findAccount,
  loadConfig,
  removeAccount,
  writeConfig,
} from "./config";
import { accountDir, defaultConfigPath } from "./paths";
import { writeCredentials } from "./credentials";
import { runOAuthLogin } from "./login";
import { launchClaudeCode } from "./launcher";
import { pickAccount } from "./picker";
import { fetchUsage } from "./usage";
import { formatDuration } from "./format";
import { bold, dim, green, red, yellow } from "./tty";

// ---------- shared helpers ----------

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
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      if (!skip.has(a)) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

// Args after a literal `--` separator — forwarded to Claude Code as-is.
export function passThroughArgs(args: string[]): string[] {
  const sep = args.indexOf("--");
  return sep >= 0 ? args.slice(sep + 1) : [];
}

function configPathOf(args: string[]): string {
  return resolve(flag(args, "--config") ?? defaultConfigPath());
}

async function loadOrEmpty(path: string): Promise<Config> {
  if (!existsSync(path)) return emptyConfig();
  return loadConfig(path);
}

// ---------- account: add / list / remove / switch ----------

export async function runAccountAdd(args: string[]): Promise<number> {
  const configPath = configPathOf(args);
  const name = flag(args, "--name") ?? null;
  const noOpen = args.includes("--no-browser");

  // Named an account that already exists? Say so before the browser opens —
  // this run re-authenticates it rather than adding a second copy.
  if (name && findAccount(await loadOrEmpty(configPath), name)) {
    console.log(`Account "${name}" already exists — re-authenticating it in place.`);
    console.log(dim(`Its Claude Code profile in ${accountDir(name)} is kept; only the credentials change.`));
  }

  const result = await runOAuthLogin({ name, open: !noOpen });

  const cfg = await loadOrEmpty(configPath);
  // Snapshot before addAccount — on the replace path it mutates this entry.
  const previous = name ? findAccount(cfg, name) : null;
  const replacing = previous !== null;
  const previousEmail = previous?.email ?? null;
  const account: Account = {
    name: result.name,
    email: result.email,
    last_used_at: null,
    added_at: Date.now(),
  };
  const added = addAccount(cfg, account, { replace: name !== null });

  await writeCredentials(accountDir(added.name), result.credentials);
  await writeConfig(configPath, cfg);

  const who = result.email ? ` (${result.email})` : "";
  if (replacing) {
    if (previousEmail && result.email && previousEmail !== result.email) {
      console.log(`\n${yellow("⚠")} "${added.name}" was ${previousEmail} — it now points at ${result.email}.`);
    }
    console.log(`\nReplaced the credentials for account "${added.name}"${who}.`);
  } else {
    console.log(`\nAdded account "${added.name}"${who}.`);
  }
  console.log(`Credentials: ${accountDir(added.name)}`);
  console.log(`\nLaunch it with: balance run ${added.name}`);
  console.log(`Or run bare 'balance' to pick from all accounts.`);
  return 0;
}

export async function runAccountList(args: string[]): Promise<number> {
  const configPath = configPathOf(args);
  const cfg = await loadOrEmpty(configPath);
  if (cfg.accounts.length === 0) {
    console.log("No accounts. Add one with: balance account add");
    return 0;
  }
  const withUsage = args.includes("--usage") || args.includes("-u");
  console.log(`${cfg.accounts.length} account${cfg.accounts.length === 1 ? "" : "s"}:\n`);
  for (const a of cfg.accounts) {
    const marker = a.name === cfg.active ? green("●") : dim("○");
    const email = a.email ? dim(` <${a.email}>`) : "";
    const lastUsed = a.last_used_at ? dim(` used ${formatDuration(a.last_used_at - Date.now())} ago`) : dim(" never used");
    console.log(`  ${marker} ${bold(a.name)}${email}${lastUsed}`);
    if (withUsage) {
      const u = await fetchUsage(accountDir(a.name));
      if (u.error) {
        console.log(`      ${red("⚠")} ${u.error}`);
      } else {
        const fmt = (label: string, util: number | null, reset: number | null) => {
          if (util == null) return `${dim(label)} —`;
          const pct = `${Math.round(util * 100)}%`;
          const color = util >= 0.9 ? red : util >= 0.7 ? yellow : green;
          const resetIn = reset ? dim(` (${formatDuration(reset - Date.now())})`) : "";
          return `${dim(label)} ${color(pct)}${resetIn}`;
        };
        console.log(`      ${fmt("5h", u.five_hour.utilization, u.five_hour.resets_at)}   ${fmt("7d", u.seven_day.utilization, u.seven_day.resets_at)}`);
      }
    }
  }
  if (!withUsage) console.log(`\n${dim("re-run with --usage to fetch live 5h/7d utilization")}`);
  return 0;
}

export async function runAccountRemove(args: string[]): Promise<number> {
  const name = positional(args)[0];
  if (!name) {
    console.error("usage: balance account remove <name>");
    return 2;
  }
  const configPath = configPathOf(args);
  const cfg = await loadOrEmpty(configPath);
  if (!findAccount(cfg, name)) {
    console.error(`No account named "${name}".`);
    return 1;
  }
  removeAccount(cfg, name);
  await writeConfig(configPath, cfg);
  // Also delete the account dir — leaving it behind would keep Claude Code
  // sessions and cached creds on disk for an account balance no longer knows.
  try { await rm(accountDir(name), { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`Removed account "${name}".`);
  return 0;
}

export async function runAccountSwitch(args: string[]): Promise<number> {
  const name = positional(args)[0];
  if (!name) {
    console.error("usage: balance account switch <name>");
    return 2;
  }
  const configPath = configPathOf(args);
  const cfg = await loadOrEmpty(configPath);
  if (!findAccount(cfg, name)) {
    console.error(`No account named "${name}".`);
    return 1;
  }
  cfg.active = name;
  await writeConfig(configPath, cfg);
  console.log(`Active account is now "${name}".`);
  return 0;
}

// ---------- run: launch Claude Code for a picked account ----------

export async function runRun(args: string[]): Promise<number> {
  const configPath = configPathOf(args);
  // Keep the on-disk config separate from the env-overridden view — we mutate
  // and persist the former, and use the latter for runtime behavior.
  const persistent = await loadOrEmpty(configPath);
  const runtime = envOverride(persistent);
  if (persistent.accounts.length === 0) {
    console.error("No accounts yet. Add one with: balance account add");
    return 1;
  }

  const forwardedArgs = passThroughArgs(args);
  const pos = positional(args);
  const explicit = pos[0] ? findAccount(persistent, pos[0]) : null;
  if (pos[0] && !explicit) {
    console.error(`No account named "${pos[0]}".`);
    return 1;
  }

  let chosen: Account | null = explicit;
  if (!chosen && persistent.accounts.length === 1) chosen = persistent.accounts[0]!;
  if (!chosen) chosen = await pickAccount(persistent.accounts);
  if (!chosen) return 1;

  chosen.last_used_at = Date.now();
  persistent.active = chosen.name;
  await writeConfig(configPath, persistent);

  const dir = accountDir(chosen.name);
  console.log(dim(`Launching Claude Code as "${chosen.name}" (${dir})`));
  await launchClaudeCode(dir, forwardedArgs, runtime.claude_binary);
  return 0; // never reached — launcher takes over the process
}

// ---------- usage / dispatch ----------

export function usage(): string {
  return `balance — pick a Claude account and launch Claude Code with it

usage:
  balance                                      show usage per account, pick one, launch Claude Code
  balance run [<name>] [-- <claude args>...]  launch Claude Code as <name> (or pick if omitted)

  balance account add   [--name <n>] [--no-browser]   OAuth login, save as isolated Claude account
                                                      (an existing --name is re-authenticated in place)
  balance account list  [--usage]                     list accounts (add --usage for live 5h/7d)
  balance account switch <name>                       change default account
  balance account remove <name>                       delete an account (removes credentials on disk)

flags:
  --config <path>   config file (default: ~/.balance/config.json)

env:
  BALANCE_CLAUDE_BINARY   path to the claude executable (default: "claude" on PATH)
  BALANCE_LOG_LEVEL       debug | info | warn | error

Each balance account is an isolated Claude Code profile — its own OAuth
credentials in ~/.balance/accounts/<name>/. When you 'balance run' an
account, balance launches Claude Code with CLAUDE_CONFIG_DIR pointed at
that directory, so it signs in as that account without touching your
machine's default ~/.claude.
`;
}
