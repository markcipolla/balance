#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };
import { setLogLevel } from "./log";
import {
  flag,
  runAccountAdd,
  runAccountList,
  runAccountRemove,
  runAccountSwitch,
  runRun,
  usage,
} from "./cli";

const VERSION = pkg.version;

type Handler = (args: string[]) => Promise<number>;
type Node = Handler | { [k: string]: Node };

const ACCOUNT_TREE: Node = {
  add: runAccountAdd,
  list: runAccountList,
  ls: runAccountList,
  remove: runAccountRemove,
  rm: runAccountRemove,
  switch: runAccountSwitch,
  use: runAccountSwitch,
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
  const argv = process.argv.slice(2);
  const level = process.env.BALANCE_LOG_LEVEL;
  if (level === "debug" || level === "info" || level === "warn" || level === "error") {
    setLogLevel(level);
  }

  const [cmd, ...rest] = argv;

  try {
    switch (cmd) {
      case undefined:
        // Bare `balance` — pick an account and launch Claude Code.
        await runRun(rest);
        return;

      case "run":
        await runRun(rest);
        return;

      case "account":
        process.exit(await walk(ACCOUNT_TREE, ["account"], rest));
        return;

      // Flat aliases matching the old (v0.x) CLI surface.
      case "login":
        process.exit(await runAccountAdd(rest));
        return;
      case "list":
      case "ls":
        process.exit(await runAccountList(rest));
        return;
      case "remove":
      case "rm":
        process.exit(await runAccountRemove(rest));
        return;
      case "switch":
      case "use":
        process.exit(await runAccountSwitch(rest));
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

      // Deprecated: proxy-era commands that no longer make sense. Fail fast
      // with a clear message rather than pretending they still work.
      case "serve":
      case "status":
      case "claude":
      case "opencode":
      case "init":
      case "add":
      case "import":
        console.error(
          `The '${cmd}' command was removed when balance pivoted from a proxy to a Claude Code launcher.\n` +
          `Use 'balance account ${cmd === "add" || cmd === "import" ? "add" : "list"}' or run 'balance --help' for the current commands.`,
        );
        process.exit(2);
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

// Handle the --config flag early so flag() picks it up (rest of argv is
// preserved so subcommands can still see it).
void flag; // keep import for future use

await main();
