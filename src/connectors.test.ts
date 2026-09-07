import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConnectors, isSyncStale, needsColdSync, parseConnectorList } from "./connectors";
import { readJson, writeJson } from "./jsonfile";
import { connectorStatePath, sharedMcpPath } from "./shared";

// Real output, trimmed: the health-check suffix varies per server and the
// listing mixes connectors with whatever else the account has configured.
const LISTING = `Checking MCP server health…

claude.ai Context7: https://mcp.context7.com/mcp - ✔ Connected
claude.ai Google Cloud BigQuery: https://bigquery.googleapis.com/mcp - ! Needs authentication
claude.ai monday.com: https://mcp.monday.com/mcp - ✔ Connected
my-local-thing: npx some-mcp-server --flag - ✔ Connected
hand-rolled: https://internal.example.com/mcp - ✔ Connected
`;

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env.BALANCE_HOME;
  home = await mkdtemp(join(tmpdir(), "balance-connectors-"));
  process.env.BALANCE_HOME = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.BALANCE_HOME;
  else process.env.BALANCE_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

function connector(name: string, url: string) {
  return { name, url, status: "✔ Connected" };
}

async function servers(): Promise<Record<string, unknown>> {
  const mcp = await readJson<{ mcpServers?: Record<string, unknown> }>(sharedMcpPath());
  return mcp?.mcpServers ?? {};
}

describe("parseConnectorList", () => {
  test("keeps claude.ai connectors, with names and URLs intact", () => {
    const found = parseConnectorList(LISTING);
    expect(found.map((c) => c.name)).toEqual([
      "claude.ai Context7",
      "claude.ai Google Cloud BigQuery",
      "claude.ai monday.com",
    ]);
    expect(found[0]!.url).toBe("https://mcp.context7.com/mcp");
  });

  test("ignores stdio servers and locally-defined HTTP ones", () => {
    const names = parseConnectorList(LISTING).map((c) => c.name);
    expect(names).not.toContain("my-local-thing");
    // Servers the user configured by hand are hoisted from .claude.json by
    // adoptAccount, which keeps their headers — re-deriving them from this
    // listing would silently drop those.
    expect(names).not.toContain("hand-rolled");
  });

  test("survives a name containing spaces and dots", () => {
    const found = parseConnectorList("claude.ai monday.com: https://mcp.monday.com/mcp - ✔ Connected");
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe("claude.ai monday.com");
  });

  test("returns nothing for output with no connectors", () => {
    expect(parseConnectorList("No MCP servers configured.")).toEqual([]);
  });
});

describe("applyConnectors", () => {
  test("writes connectors into the shared mcp.json as http servers", async () => {
    const res = await applyConnectors("work", [connector("claude.ai Linear", "https://mcp.linear.app/mcp")]);
    expect(res.added).toEqual(["claude.ai Linear"]);
    expect(await servers()).toEqual({
      "claude.ai Linear": { type: "http", url: "https://mcp.linear.app/mcp" },
    });
  });

  test("is a union across accounts", async () => {
    await applyConnectors("work", [connector("claude.ai Linear", "https://mcp.linear.app/mcp")]);
    await applyConnectors("personal", [connector("claude.ai Notion", "https://mcp.notion.com/mcp")]);
    expect(Object.keys(await servers()).sort()).toEqual(["claude.ai Linear", "claude.ai Notion"]);
  });

  test("keeps a connector another account still has", async () => {
    const linear = connector("claude.ai Linear", "https://mcp.linear.app/mcp");
    await applyConnectors("work", [linear]);
    await applyConnectors("personal", [linear]);
    // Removed from `work` only — `personal` still lists it, so it stays.
    const res = await applyConnectors("work", []);
    expect(res.retired).toEqual([]);
    expect(Object.keys(await servers())).toEqual(["claude.ai Linear"]);
  });

  test("retires a connector once no account lists it", async () => {
    const linear = connector("claude.ai Linear", "https://mcp.linear.app/mcp");
    await applyConnectors("work", [linear]);
    await applyConnectors("personal", [linear]);
    await applyConnectors("work", []);
    const res = await applyConnectors("personal", []);
    expect(res.retired).toEqual(["claude.ai Linear"]);
    expect(await servers()).toEqual({});
  });

  test("never touches a server balance did not add", async () => {
    await writeJson(sharedMcpPath(), {
      mcpServers: { "hand-rolled": { type: "http", url: "https://internal.example.com/mcp" } },
    });
    await applyConnectors("work", [connector("claude.ai Linear", "https://mcp.linear.app/mcp")]);
    await applyConnectors("work", []);
    expect(await servers()).toHaveProperty("hand-rolled");
  });

  test("updates a URL that has changed upstream", async () => {
    await applyConnectors("work", [connector("claude.ai Linear", "https://old.example.com/mcp")]);
    const res = await applyConnectors("work", [connector("claude.ai Linear", "https://mcp.linear.app/mcp")]);
    expect(res.added).toEqual([]); // already present — changed, not added
    expect(await servers()).toEqual({
      "claude.ai Linear": { type: "http", url: "https://mcp.linear.app/mcp" },
    });
  });

  test("reports no change on a repeat sync", async () => {
    const linear = connector("claude.ai Linear", "https://mcp.linear.app/mcp");
    await applyConnectors("work", [linear]);
    const res = await applyConnectors("work", [linear]);
    expect(res).toEqual({ added: [], retired: [] });
  });
});

describe("needsColdSync", () => {
  test("true before anything has been synced", async () => {
    expect(await needsColdSync()).toBe(true);
  });

  test("false once the shared file holds a managed connector", async () => {
    await applyConnectors("work", [connector("claude.ai Linear", "https://mcp.linear.app/mcp")]);
    expect(await needsColdSync()).toBe(false);
  });

  test("true again if the shared file is emptied out from under us", async () => {
    await applyConnectors("work", [connector("claude.ai Linear", "https://mcp.linear.app/mcp")]);
    await writeJson(sharedMcpPath(), { mcpServers: {} });
    expect(await needsColdSync()).toBe(true);
  });
});

describe("isSyncStale", () => {
  test("an account that has never synced is stale", async () => {
    expect(await isSyncStale("work", 24)).toBe(true);
  });

  test("a fresh sync is not", async () => {
    await applyConnectors("work", [connector("claude.ai Linear", "https://mcp.linear.app/mcp")]);
    expect(await isSyncStale("work", 24)).toBe(false);
  });

  test("goes stale once the TTL has passed", async () => {
    await applyConnectors("work", [connector("claude.ai Linear", "https://mcp.linear.app/mcp")]);
    const state = await readJson<{ accounts: Record<string, { at: number; names: string[] }> }>(connectorStatePath());
    state!.accounts.work!.at = Date.now() - 25 * 60 * 60 * 1000;
    await writeJson(connectorStatePath(), state);
    expect(await isSyncStale("work", 24)).toBe(true);
    expect(await isSyncStale("work", 48)).toBe(false);
  });

  test("staleness is per account", async () => {
    await applyConnectors("work", [connector("claude.ai Linear", "https://mcp.linear.app/mcp")]);
    expect(await isSyncStale("personal", 24)).toBe(true);
  });
});
