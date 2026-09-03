#!/usr/bin/env bun
import { resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { envOverride, loadConfig } from "./config";
import { defaultConfigPath } from "./paths";
import { AccountPool } from "./pool";
import { startServer } from "./server";
import { setLogLevel, setLogSink, log } from "./log";
import { shouldUseDashboard, startDashboard } from "./dashboard";

const VERSION = pkg.version;
import {
  flag,
  runApiAdd,
  runApiList,
  runApiRemove,
  runFlatList,
  runFlatRemove,
  runInit,
  runOpencodeInstall,
  runSubscriptionAdd,
  runSubscriptionImport,
  runSubscriptionList,
  runSubscriptionRemove,
  usage,
} from "./cli";
import { findExistingOpencodeConfig, opencodeGlobalPath, wireOpencode } from "./opencode";
import { primeClaudeVersion } from "./claude-version";

async function runServe(args: string[]): Promise<never> {
  const configPath = resolve(flag(args, "--config") ?? defaultConfigPath());
  const raw = await loadConfig(configPath);
  const cfg = envOverride(raw);
  setLogLevel(cfg.log_level);
  const pool = new AccountPool(cfg.claude, configPath);
  const dumpPath = flag(args, "--dump-requests") ?? null;
  const server = startServer(cfg, pool, dumpPath ? resolve(dumpPath) : null);

  if (dumpPath) {
    log.warn("dump mode active — pool bypassed, every request forwarded verbatim + logged", { path: resolve(dumpPath) });
  }

  primeClaudeVersion();
  await maybeWireOpencode(cfg, args);

  const wantTui = !args.includes("--no-tui") && shouldUseDashboard();
  const dashboard = wantTui ? (setLogSink("buffer", 200), startDashboard(pool, cfg)) : null;

  return new Promise<never>((_resolve, _reject) => {
    const shutdown = (signal: string) => {
      dashboard?.stop();
      setLogSink("console");
      log.info("shutting down", { signal });
      server.stop(true);
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });
}

// If --wire-opencode is passed, install/update the opencode config to point at
// this server. Otherwise, if opencode has a config on disk but it doesn't
// point at us yet, print a one-line hint so the user knows they can wire it.
async function maybeWireOpencode(
  cfg: { host: string; port: number; auth_token: string | null },
  args: string[],
): Promise<void> {
  // opencode's Anthropic provider treats baseURL as already ending in /v1.
  const baseURL = `http://${cfg.host}:${cfg.port}/v1`;
  const apiKey = cfg.auth_token ?? "any-value";

  if (args.includes("--wire-opencode")) {
    const path = args.includes("--project")
      ? resolve("opencode.jsonc")
      : opencodeGlobalPath();
    try {
      const result = await wireOpencode({ path, baseURL, apiKey });
      log.info("opencode wired", { path: result.path, action: result.action });
    } catch (err) {
      log.warn("opencode wire failed", { err: String(err) });
    }
    return;
  }

  const existing = findExistingOpencodeConfig();
  if (!existing) return;
  try {
    const raw = await Bun.file(existing).text();
    if (raw.includes(baseURL)) return;   // already wired; nothing to say
    log.info("hint: opencode config detected but not pointed at balance", {
      path: existing,
      fix: "balance opencode install",
    });
  } catch {
    // best-effort hint; ignore read failures
  }
}

async function runStatus(args: string[]): Promise<number> {
  const configPath = resolve(flag(args, "--config") ?? defaultConfigPath());
  const cfg = envOverride(await loadConfig(configPath));
  const url = `http://${cfg.host}:${cfg.port}/status`;
  const headers: Record<string, string> = {};
  if (cfg.auth_token) headers["authorization"] = `Bearer ${cfg.auth_token}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
  return res.ok ? 0 : 1;
}

type Handler = (args: string[]) => Promise<number>;
type Node = Handler | { [k: string]: Node };

const CLAUDE_TREE: Node = {
  subscription: {
    list: runSubscriptionList,
    ls: runSubscriptionList,
    add: runSubscriptionAdd,
    import: runSubscriptionImport,
    remove: runSubscriptionRemove,
    rm: runSubscriptionRemove,
  },
  subscriptions: {
    list: runSubscriptionList,
  },
  api: {
    list: runApiList,
    ls: runApiList,
    add: runApiAdd,
    remove: runApiRemove,
    rm: runApiRemove,
  },
  "api-keys": {
    list: runApiList,
  },
};

const OPENCODE_TREE: Node = {
  install: runOpencodeInstall,
  wire: runOpencodeInstall,
  print: (args) => runOpencodeInstall([...args, "--print"]),
};

async function walk(node: Node, path: string[], args: string[]): Promise<number> {
  if (typeof node === "function") return node(args);
  const [head, ...rest] = args;
  if (!head) {
    console.error(`incomplete command. Try: balance ${path.join(" ")} <subcommand>\n`);
    process.stdout.write(usage());
    return 2;
  }
  const next = node[head];
  if (!next) {
    console.error(`unknown subcommand '${head}' under 'balance ${path.join(" ")}'\n`);
    process.stdout.write(usage());
    return 2;
  }
  return walk(next, [...path, head], rest);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "serve":
      case undefined:
        await runServe(rest);
        return;

      case "init":
        process.exit(await runInit(rest));
        return;

      case "status":
        process.exit(await runStatus(rest));
        return;

      case "claude":
        process.exit(await walk(CLAUDE_TREE, ["claude"], rest));
        return;

      case "opencode":
        process.exit(await walk(OPENCODE_TREE, ["opencode"], rest));
        return;

      // Flat aliases for convenience.
      case "login":
        process.exit(await runSubscriptionAdd(rest));
        return;
      case "list":
      case "ls":
        process.exit(await runFlatList(rest));
        return;
      case "add":
      case "import":
        process.exit(await runSubscriptionImport(rest));
        return;
      case "remove":
      case "rm":
        process.exit(await runFlatRemove(rest));
        return;

      case "help":
      case "--help":
      case "-h":
        process.stdout.write(usage());
        process.exit(0);
        return;

      case "version":
      case "--version":
      case "-v":
        process.stdout.write(`balance ${VERSION}\n`);
        process.exit(0);
        return;

      default:
        console.error(`Unknown command: ${cmd}\n`);
        process.stdout.write(usage());
        process.exit(2);
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

await main();
