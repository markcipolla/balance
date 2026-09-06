import { chmodSync, existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { accountDir, baseDir } from "./paths";
import { log } from "./log";
import type { SharedSettings } from "./types";

// One config layer, shared by every account.
//
// An account dir mixes two very different kinds of state: identity (OAuth
// creds, `oauthAccount`, per-account caches) and configuration (skills,
// agents, commands, plugins, MCP servers, settings, memory). Only the first
// has any business being per-account — the second is the same person's setup
// either way, and duplicating it per account means re-installing every skill
// and re-approving every MCP server for each login.
//
// So the config half gets hoisted up a level into ~/.balance/shared and
// pushed back down at launch. The mechanism differs per item, because it has
// to: Claude Code rewrites some of these files itself, and an atomic
// write-and-rename replaces a symlink with a real file, silently un-sharing
// it. Directories are safe to symlink; files Claude Code owns are not, so
// those go in as launch flags or as an `@import` instead.
//
// The whole layer is inert until ~/.balance/shared exists — `balance shared
// init` creates it. Nothing changes for anyone who never runs that.

export function sharedDir(): string {
  return join(baseDir(), "shared");
}

export function sharedMcpPath(): string {
  return join(sharedDir(), "mcp.json");
}

export function sharedSettingsPath(): string {
  return join(sharedDir(), "settings.json");
}

export function sharedMemoryPath(): string {
  return join(sharedDir(), "CLAUDE.md");
}

export function sharedProjectsPath(): string {
  return join(sharedDir(), "projects.json");
}

export function sharedMemoryDir(): string {
  return join(sharedDir(), "memory");
}

// Directories we're willing to symlink. Everything here is config Claude Code
// reads out of CLAUDE_CONFIG_DIR and only ever writes through whole-directory
// operations, so a symlinked dir survives.
export const LINKABLE_DIRS = ["skills", "agents", "commands", "plugins"] as const;

export function sharedActive(s: SharedSettings): boolean {
  return s.enabled && existsSync(sharedDir());
}

// ---------- small fs helpers ----------

async function writeJson(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
  if (mode !== undefined) {
    try { chmodSync(path, mode); } catch { /* best-effort */ }
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    log.warn("could not parse JSON — ignoring it", { path, err: String(err) });
    return null;
  }
}

function linkState(path: string): "missing" | "symlink" | "real" {
  try {
    return lstatSync(path).isSymbolicLink() ? "symlink" : "real";
  } catch {
    return "missing";
  }
}

// Point `link` at `target`. Non-destructive by design: a real file or
// directory already sitting there is left alone and reported, because it may
// be the only copy of someone's skills. `balance shared link --force` is the
// explicit opt-in that moves it aside.
async function linkInto(link: string, target: string, force = false): Promise<boolean> {
  const state = linkState(link);
  if (state === "symlink") {
    if (readlinkSync(link) === target) return true;
    await rm(link, { force: true });
  } else if (state === "real") {
    if (!force) {
      log.warn("not linking — something real is already there", { path: link });
      return false;
    }
    const aside = `${link}.pre-balance`;
    await rm(aside, { recursive: true, force: true });
    await rename(link, aside);
    log.info("moved existing path aside", { from: link, to: aside });
  }
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link, "dir");
  log.debug("linked shared path", { link, target });
  return true;
}

// Claude Code's on-disk name for a project directory: every character that
// isn't alphanumeric becomes a dash, so /Users/me/dev/app is stored as
// -Users-me-dev-app under projects/.
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// ---------- the launch-time layer ----------

const IMPORT_MARK = "<!-- balance: shared memory -->";

// User memory can't be a symlink — Claude Code rewrites CLAUDE.md when you add
// a memory with `#`, and the rename would replace the link with a real file.
// An `@import` line gets the same result and survives being rewritten, while
// still leaving the account free to keep notes of its own below it. The path
// is absolute rather than ~-relative so nothing depends on how Claude Code
// expands a home directory in an import.
async function ensureMemoryImport(dir: string): Promise<void> {
  if (!existsSync(sharedMemoryPath())) return;
  const line = `@${sharedMemoryPath()}`;
  const path = join(dir, "CLAUDE.md");
  const body = existsSync(path) ? await readFile(path, "utf8") : "";
  if (body.includes(line)) return;
  const header = `${IMPORT_MARK}\n${line}\n`;
  await writeFile(path, body ? `${header}\n${body}` : header, "utf8");
  log.debug("added shared memory import", { path });
}

// The memory tool writes to projects/<slug>/memory, so sharing it means
// linking that one subdirectory — not the whole projects/ dir, which also
// holds session transcripts we deliberately keep per-account.
async function linkProjectMemory(dir: string, cwd: string, force = false): Promise<void> {
  const slug = projectSlug(cwd);
  const target = join(sharedMemoryDir(), slug);
  await mkdir(target, { recursive: true });
  await mkdir(join(dir, "projects", slug), { recursive: true });
  await linkInto(join(dir, "projects", slug, "memory"), target, force);
}

export async function applySharedLayer(dir: string, cwd: string, s: SharedSettings, force = false): Promise<void> {
  for (const name of LINKABLE_DIRS) {
    if (!s.dirs.includes(name)) continue;
    const target = join(sharedDir(), name);
    if (!existsSync(target)) continue;
    await linkInto(join(dir, name), target, force);
  }
  await ensureMemoryImport(dir);
  if (s.memory) await linkProjectMemory(dir, cwd, force);
  if (s.projects) await seedProjectState(dir, cwd);
}

// Flags that put the shared MCP servers and settings in front of Claude Code
// without writing them into the account's .claude.json — which is also where
// account identity lives, and which Claude Code rewrites from under us.
//
// Appended *after* the caller's own args: --mcp-config is variadic, so with
// nothing following it, it can't swallow a forwarded prompt. Anything the
// caller passed explicitly wins outright.
export function sharedLaunchArgs(s: SharedSettings, forwarded: string[]): string[] {
  const out: string[] = [];
  if (s.mcp && existsSync(sharedMcpPath()) && !forwarded.includes("--mcp-config")) {
    out.push("--mcp-config", sharedMcpPath());
    if (s.strict_mcp && !forwarded.includes("--strict-mcp-config")) out.push("--strict-mcp-config");
  }
  if (s.settings && existsSync(sharedSettingsPath()) && !forwarded.includes("--settings")) {
    out.push("--settings", sharedSettingsPath());
  }
  return out;
}

// ---------- per-project approval state ----------

// The four keys that decide whether a project's MCP servers actually come up.
// Server definitions can live at local scope (.claude.json, per project), and
// project-scope servers from a repo's .mcp.json need an explicit approval that
// is recorded per account — which is why a second account sees the same repo
// and connects to nothing.
interface ProjectState {
  mcpServers?: Record<string, unknown>;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  hasTrustDialogAccepted?: boolean;
  hasClaudeMdExternalIncludesApproved?: boolean;
}

// Per-project booleans that only ever move false -> true, and that gate
// whether a project's config actually loads.
const PROJECT_FLAGS = ["hasTrustDialogAccepted", "hasClaudeMdExternalIncludesApproved"] as const;

interface ClaudeJson {
  projects?: Record<string, ProjectState & Record<string, unknown>>;
  [k: string]: unknown;
}

function union(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a && !b) return undefined;
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

function claudeJsonPath(dir: string): string {
  return join(dir, ".claude.json");
}

// Push the shared record for `cwd` into this account before Claude Code
// starts. Additive only — an account that has already made a choice keeps it,
// and we never write while Claude Code is running.
export async function seedProjectState(dir: string, cwd: string): Promise<void> {
  const shared = await readJson<Record<string, ProjectState>>(sharedProjectsPath());
  const entry = shared?.[cwd];
  if (!entry) return;

  const claude = await readJson<ClaudeJson>(claudeJsonPath(dir));
  if (!claude) return;
  const projects = claude.projects ?? (claude.projects = {});
  const project = projects[cwd] ?? (projects[cwd] = {});

  let changed = false;
  for (const [name, def] of Object.entries(entry.mcpServers ?? {})) {
    const servers = project.mcpServers ?? (project.mcpServers = {});
    if (name in servers) continue;
    servers[name] = def;
    changed = true;
  }
  for (const key of ["enabledMcpjsonServers", "disabledMcpjsonServers"] as const) {
    const merged = union(project[key], entry[key]);
    if (merged && merged.length !== (project[key]?.length ?? 0)) {
      project[key] = merged;
      changed = true;
    }
  }
  for (const key of PROJECT_FLAGS) {
    if (entry[key] && !project[key]) {
      project[key] = true;
      changed = true;
    }
  }

  if (!changed) return;
  await writeJson(claudeJsonPath(dir), claude);
  log.debug("seeded shared project state", { dir, cwd });
}

// Read back what the session decided, after Claude Code has exited and the
// file is ours to touch again. An approval given in one account is an approval
// the next account inherits.
export async function harvestProjectState(dir: string, cwd: string): Promise<void> {
  const claude = await readJson<ClaudeJson>(claudeJsonPath(dir));
  const project = claude?.projects?.[cwd];
  if (!project) return;

  const shared = (await readJson<Record<string, ProjectState>>(sharedProjectsPath())) ?? {};
  const entry = shared[cwd] ?? {};
  const before = JSON.stringify(entry);

  if (project.mcpServers && Object.keys(project.mcpServers).length > 0) {
    entry.mcpServers = { ...(entry.mcpServers ?? {}), ...project.mcpServers };
  }
  for (const key of ["enabledMcpjsonServers", "disabledMcpjsonServers"] as const) {
    const merged = union(entry[key], project[key]);
    if (merged && merged.length > 0) entry[key] = merged;
  }
  for (const key of PROJECT_FLAGS) {
    if (project[key]) entry[key] = true;
  }

  if (JSON.stringify(entry) === before) return;
  shared[cwd] = entry;
  // May carry auth headers for HTTP MCP servers — keep it owner-only.
  await writeJson(sharedProjectsPath(), shared, 0o600);
  log.debug("harvested project state into the shared layer", { cwd });
}

// ---------- init / adopt ----------

export interface AdoptReport {
  moved: string[];
  copied: string[];
  skipped: string[];
}

// Create the shared skeleton. Empty dirs are intentional: they're what makes a
// skill dropped into ~/.balance/shared/skills show up in every account.
export async function initShared(dirs: readonly string[]): Promise<void> {
  await mkdir(sharedMemoryDir(), { recursive: true });
  for (const name of dirs) await mkdir(join(sharedDir(), name), { recursive: true });
  if (!existsSync(sharedMcpPath())) await writeJson(sharedMcpPath(), { mcpServers: {} });
}

// Lift one account's config into the shared dir, so the hoist starts from a
// real setup instead of an empty one. Directories move (the account gets a
// symlink back in applySharedLayer); files are copied, since the account keeps
// needing its own copy.
export async function adoptFrom(name: string, dirs: readonly string[]): Promise<AdoptReport> {
  const dir = accountDir(name);
  const report: AdoptReport = { moved: [], copied: [], skipped: [] };

  for (const sub of dirs) {
    const from = join(dir, sub);
    const to = join(sharedDir(), sub);
    if (linkState(from) !== "real") continue;
    if (existsSync(to) && (await readdir(to)).length > 0) {
      report.skipped.push(`${sub}/ (shared copy is not empty)`);
      continue;
    }
    await rm(to, { recursive: true, force: true });
    await rename(from, to);
    report.moved.push(`${sub}/`);
  }

  for (const [file, target] of [["CLAUDE.md", sharedMemoryPath()], ["settings.json", sharedSettingsPath()]] as const) {
    const from = join(dir, file);
    if (!existsSync(from) || existsSync(target)) continue;
    await writeFile(target, await readFile(from, "utf8"), "utf8");
    report.copied.push(file);
  }

  // Project memory: per project, so it moves slug by slug.
  const projects = join(dir, "projects");
  if (existsSync(projects)) {
    for (const slug of await readdir(projects)) {
      const from = join(projects, slug, "memory");
      if (linkState(from) !== "real") continue;
      const to = join(sharedMemoryDir(), slug);
      if (existsSync(to) && (await readdir(to)).length > 0) {
        report.skipped.push(`memory/${slug} (shared copy is not empty)`);
        continue;
      }
      await rm(to, { recursive: true, force: true });
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      await symlink(to, from, "dir");
      report.moved.push(`projects/${slug}/memory`);
    }
  }

  // User-scope MCP servers out of .claude.json, plus every project's approval
  // state — the two things that decide whether a second account's MCP servers
  // come up at all.
  const claude = await readJson<ClaudeJson>(claudeJsonPath(dir));
  const userServers = (claude?.mcpServers ?? {}) as Record<string, unknown>;
  if (Object.keys(userServers).length > 0) {
    const mcp = (await readJson<{ mcpServers?: Record<string, unknown> }>(sharedMcpPath())) ?? {};
    mcp.mcpServers = { ...userServers, ...(mcp.mcpServers ?? {}) };
    await writeJson(sharedMcpPath(), mcp, 0o600);
    report.copied.push(`${Object.keys(userServers).length} user-scope MCP server(s)`);
  }
  let projectCount = 0;
  for (const cwd of Object.keys(claude?.projects ?? {})) {
    const before = JSON.stringify((await readJson<Record<string, ProjectState>>(sharedProjectsPath()))?.[cwd] ?? null);
    await harvestProjectState(dir, cwd);
    const after = JSON.stringify((await readJson<Record<string, ProjectState>>(sharedProjectsPath()))?.[cwd] ?? null);
    if (before !== after) projectCount += 1;
  }
  if (projectCount > 0) report.copied.push(`MCP/trust state for ${projectCount} project(s)`);

  return report;
}

// Every slug the shared layer knows about, linked into an account — the
// launch path only ever links the project you're launching in.
export async function linkAllProjectMemory(dir: string, force = false): Promise<number> {
  if (!existsSync(sharedMemoryDir())) return 0;
  let n = 0;
  for (const slug of await readdir(sharedMemoryDir())) {
    await mkdir(join(dir, "projects", slug), { recursive: true });
    if (await linkInto(join(dir, "projects", slug, "memory"), join(sharedMemoryDir(), slug), force)) n += 1;
  }
  return n;
}

// What's actually linked, for `balance shared status`.
export function linkReport(dir: string, dirs: readonly string[]): Array<{ name: string; state: string }> {
  return dirs.map((name) => {
    const path = join(dir, name);
    const state = linkState(path);
    if (state === "symlink") {
      return { name, state: readlinkSync(path) === join(sharedDir(), name) ? "shared" : "linked elsewhere" };
    }
    return { name, state: state === "real" ? "own copy" : "—" };
  });
}
