import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAccount, emptyConfig, envOverride, findAccount, loadConfig, removeAccount, writeConfig } from "./config";
import { accountDir } from "./paths";
import type { Account } from "./types";

let home: string;
let previousHome: string | undefined;
const previousEnv = { ...process.env };

beforeEach(async () => {
  previousHome = process.env.BALANCE_HOME;
  home = await mkdtemp(join(tmpdir(), "balance-config-test-"));
  process.env.BALANCE_HOME = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.BALANCE_HOME;
  else process.env.BALANCE_HOME = previousHome;
  for (const key of ["BALANCE_CLAUDE_BINARY", "BALANCE_LOG_LEVEL"]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  await rm(home, { recursive: true, force: true });
});

function configPath(): string {
  return join(home, "config.json");
}

async function writeRaw(value: unknown): Promise<void> {
  await writeFile(configPath(), JSON.stringify(value), "utf8");
}

const account = (name: string): Account => ({ name, email: null, last_used_at: null, added_at: 1 });

describe("loadConfig", () => {
  test("fills in the defaults for a config that only sets some keys", async () => {
    await writeRaw({ accounts: [account("work")] });
    const cfg = await loadConfig(configPath());

    expect(cfg.active).toBeNull();
    expect(cfg.claude_binary).toBe("claude");
    expect(cfg.log_level).toBe("info");
  });

  test("returns an empty config when there is no file", async () => {
    const cfg = await loadConfig(join(home, "missing.json"));
    expect(cfg.accounts).toEqual([]);
  });

  test("survives a config whose accounts key is not an array", async () => {
    await writeRaw({ accounts: "nonsense" });
    expect((await loadConfig(configPath())).accounts).toEqual([]);
  });

  test("migrates a v0.x proxy config into isolated account dirs", async () => {
    await writeRaw({
      claude: {
        subscriptions: [
          { name: "work", access_token: "a", refresh_token: "r", expires_at: 123 },
          { name: "broken", access_token: "", refresh_token: "" },
        ],
      },
    });
    const cfg = await loadConfig(configPath());

    expect(cfg.accounts.map((a) => a.name)).toEqual(["work"]);
    expect(cfg.active).toBe("work");
    expect(existsSync(join(accountDir("work"), ".credentials.json"))).toBe(true);
    // The migrated file no longer carries the tokens inline.
    expect(await readFile(configPath(), "utf8")).not.toContain("refresh_token");
  });
});

describe("emptyConfig", () => {
  test("does not share one accounts array between configs", () => {
    const a = emptyConfig();
    const b = emptyConfig();
    a.accounts.push(account("work"));
    expect(b.accounts).toEqual([]);
  });
});

describe("envOverride", () => {
  test("overrides the binary and log level without touching the file", () => {
    process.env.BALANCE_CLAUDE_BINARY = "/opt/claude";
    process.env.BALANCE_LOG_LEVEL = "debug";
    const onDisk = emptyConfig();
    const cfg = envOverride(onDisk);
    expect(cfg.claude_binary).toBe("/opt/claude");
    expect(cfg.log_level).toBe("debug");
    expect(onDisk.claude_binary).toBe("claude");
  });
});

describe("account bookkeeping", () => {
  test("round-trips through disk", async () => {
    const cfg = emptyConfig();
    addAccount(cfg, account("work"));
    await writeConfig(configPath(), cfg);
    const loaded = await loadConfig(configPath());

    expect(findAccount(loaded, "work")).not.toBeNull();
    expect(loaded.active).toBe("work");
  });

  test("suffixes a colliding name unless replace is asked for", () => {
    const cfg = emptyConfig();
    addAccount(cfg, account("work"));
    const second = addAccount(cfg, account("work"));
    expect(second.name).toBe("work-2");

    const replaced = addAccount(cfg, { ...account("work"), email: "new@example.com" }, { replace: true });
    expect(replaced.name).toBe("work");
    expect(cfg.accounts).toHaveLength(2);
  });

  test("removing the active account promotes another", () => {
    const cfg = emptyConfig();
    addAccount(cfg, account("work"));
    addAccount(cfg, account("personal"));
    expect(removeAccount(cfg, "work")).toBe(true);
    expect(cfg.active).toBe("personal");
  });
});
