import { basename } from "node:path";
import { readJson, writeJson } from "./jsonfile";
import { baseDir } from "./paths";
import { log } from "./log";
import { run } from "./proc";
import { connectorStatePath, sharedMcpPath } from "./shared";

// claude.ai connectors are the one part of an account's MCP setup that is not
// a file. They are resolved server-side from the OAuth identity, so they live
// in no config balance can hoist: not .claude.json, not the account cache,
// nowhere on disk. Which means two accounts on one machine see two different
// sets of MCP servers and there is nothing to symlink to fix it.
//
// So balance reads them out of the only interface that exposes them — `claude
// mcp list` — and re-declares them in the shared mcp.json as ordinary HTTP
// servers, which is all a connector is underneath. Every account then launches
// with that one file (see sharedLaunchArgs), and --strict-mcp-config suppresses
// each account's own server-side set so the shared copy isn't duplicated.
//
// The name is carried across verbatim. MCP OAuth tokens live in the Keychain
// blob balance already preserves between launches, and keeping the exact name
// is what lets an existing login still match the re-declared server.
const CONNECTOR_PREFIX = "claude.ai ";

// "claude.ai Linear: https://mcp.linear.app/mcp - ✔ Connected"
// Names can contain spaces and dots, so anchor on the "://" of the URL rather
// than on the first colon.
const LIST_LINE = /^(.*?):\s+(https?:\/\/\S+)\s+-\s+(.*)$/;

export interface Connector {
  name: string;
  url: string;
  status: string;
}

// Per-account record of what the last sync saw, plus `managed`: every server
// name balance has ever written into the shared mcp.json. Without that list we
// could not tell a connector we added from one the user wrote by hand, and so
// could never retire a connector that has been removed upstream.
interface ConnectorState {
  managed: string[];
  accounts: Record<string, { at: number; names: string[] }>;
}

export function parseConnectorList(stdout: string): Connector[] {
  const out: Connector[] = [];
  for (const raw of stdout.split("\n")) {
    const m = LIST_LINE.exec(raw.trim());
    if (!m) continue;
    const [, name, url, status] = m;
    if (!name?.startsWith(CONNECTOR_PREFIX)) continue;
    out.push({ name, url: url!, status: status!.trim() });
  }
  return out;
}

// Ask one account's Claude Code what connectors it has.
//
// Deliberately run from ~/.balance rather than the launch directory: a repo's
// own .mcp.json would otherwise show up in the listing, and those servers
// belong to the project, not to the account's shared identity.
export async function listConnectors(dir: string, binary: string, timeoutMs = 60_000): Promise<Connector[] | null> {
  const res = await run(binary, ["mcp", "list"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, CLAUDE_HOME: dir },
    cwd: baseDir(),
    timeoutMs,
  });
  if (res.timedOut) {
    log.debug("connector listing timed out", { dir });
    return null;
  }
  // `claude mcp list` exits non-zero when any server fails its health check,
  // which says nothing about whether the listing itself is usable.
  const found = parseConnectorList(res.stdout);
  if (found.length === 0 && res.code !== 0) {
    log.debug("could not list connectors", { dir, code: res.code });
    return null;
  }
  return found;
}

async function readState(): Promise<ConnectorState> {
  const s = await readJson<Partial<ConnectorState>>(connectorStatePath());
  return { managed: s?.managed ?? [], accounts: s?.accounts ?? {} };
}

export interface SyncResult {
  added: string[];
  retired: string[];
}

// True when the shared file holds none of the connectors we manage — a cold
// start, where syncing before launch is worth blocking for because otherwise
// this session gets no MCP servers at all.
export async function needsColdSync(): Promise<boolean> {
  const state = await readState();
  if (state.managed.length === 0) return true;
  const mcp = await readJson<{ mcpServers?: Record<string, unknown> }>(sharedMcpPath());
  const have = Object.keys(mcp?.mcpServers ?? {});
  return !state.managed.some((name) => have.includes(name));
}

export async function isSyncStale(account: string, ttlHours: number): Promise<boolean> {
  const state = await readState();
  const last = state.accounts[account]?.at;
  if (last === undefined) return true;
  return Date.now() - last >= ttlHours * 60 * 60 * 1000;
}

// Fold one account's connectors into the shared mcp.json.
//
// The shared set is the *union* across every account balance has seen, which
// is the whole point: an account that has never had the Linear connector still
// launches with it. That makes removal the awkward case — a connector missing
// from this account might simply belong to another one — so a server is only
// retired once it has disappeared from every account's last known listing.
export async function syncConnectors(
  dir: string,
  binary: string,
  opts: { account?: string; timeoutMs?: number } = {},
): Promise<SyncResult | null> {
  const account = opts.account ?? basename(dir);
  const found = await listConnectors(dir, binary, opts.timeoutMs);
  if (found === null) return null;
  return applyConnectors(account, found);
}

// The half that touches only files: fold one account's listing into the shared
// set and record what we did. Split from the subprocess above so the union and
// retire rules can be exercised without a Claude Code install.
export async function applyConnectors(account: string, found: Connector[]): Promise<SyncResult> {
  const state = await readState();
  state.accounts[account] = { at: Date.now(), names: found.map((c) => c.name) };

  const union = new Map<string, string>();
  for (const c of found) union.set(c.name, c.url);
  // Names still claimed by another account are kept even if this one has since
  // dropped them; their URLs come from whatever is already in the shared file.
  const claimedElsewhere = new Set(
    Object.entries(state.accounts)
      .filter(([name]) => name !== account)
      .flatMap(([, rec]) => rec.names),
  );

  const mcp = (await readJson<{ mcpServers?: Record<string, unknown> }>(sharedMcpPath())) ?? {};
  const servers = mcp.mcpServers ?? {};
  const added: string[] = [];
  const retired: string[] = [];

  for (const [name, url] of union) {
    const existing = servers[name] as { url?: string } | undefined;
    if (existing?.url === url) continue;
    servers[name] = { type: "http", url };
    if (!existing) added.push(name);
  }
  for (const name of state.managed) {
    if (union.has(name) || claimedElsewhere.has(name)) continue;
    if (!(name in servers)) continue;
    delete servers[name];
    retired.push(name);
  }

  state.managed = [...new Set([...state.managed, ...union.keys()])].filter(
    (name) => union.has(name) || claimedElsewhere.has(name),
  );

  mcp.mcpServers = servers;
  // May carry auth headers, and names the servers this machine talks to.
  await writeJson(sharedMcpPath(), mcp, 0o600);
  await writeJson(connectorStatePath(), state, 0o600);

  if (added.length > 0 || retired.length > 0) {
    log.info("synced claude.ai connectors into the shared layer", {
      account,
      added: added.length,
      retired: retired.length,
      total: union.size,
    });
  } else {
    log.debug("connectors already in sync", { account, total: union.size });
  }
  return { added, retired };
}
