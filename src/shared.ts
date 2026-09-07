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
  return s.enabled;
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

// Point `link` at `target`. Anything real still sitting there has already
// been merged into the shared copy by adoptAccount, so reaching this with a
// real path means the merge left something behind — say so rather than
// clobber it.
async function linkInto(link: string, target: string): Promise<boolean> {
  const state = linkState(link);
  if (state === "symlink") {
    if (readlinkSync(link) === target) return true;
    await rm(link, { force: true });
  } else if (state === "real") {
    log.warn("not linking — something real is still there", { path: link });
    return false;
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
async function linkProjectMemory(dir: string, cwd: string): Promise<void> {
  const slug = projectSlug(cwd);
  const target = join(sharedMemoryDir(), slug);
  await mkdir(target, { recursive: true });
  await mkdir(join(dir, "projects", slug), { recursive: true });
  await linkInto(join(dir, "projects", slug, "memory"), target);
}

// Everything the shared layer does to an account dir, on every launch.
//
// There is no setup step: the first launch of each account merges whatever
// config that account has accumulated up into ~/.balance/shared and links it
// back down, so an account joins the layer simply by being launched. Later
// launches find symlinks already in place and do almost nothing.
export async function applySharedLayer(dir: string, cwd: string, s: SharedSettings): Promise<AdoptReport> {
  await initShared(s.dirs);
  const report = await adoptAccount(dir, s.dirs);

  for (const name of s.dirs) {
    const target = join(sharedDir(), name);
    if (!existsSync(target)) continue;
    await linkInto(join(dir, name), target);
  }
  await ensureMemoryImport(dir);
  if (s.memory) {
    // Every project the layer knows about, not just this one — an account
    // that has never been in a project still inherits its memory.
    await linkAllProjectMemory(dir);
    await linkProjectMemory(dir, cwd);
  }
  if (s.projects) await seedProjectState(dir, cwd);
  return report;
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

// ---------- adoption ----------

export interface AdoptReport {
  adopted: string[];   // what moved up into the shared layer
  setAside: string[];  // colliding copies parked next to the account dir
}

// Create the shared skeleton. Empty dirs are intentional: they're what makes a
// skill dropped into ~/.balance/shared/skills show up in every account.
export async function initShared(dirs: readonly string[]): Promise<void> {
  await mkdir(sharedMemoryDir(), { recursive: true });
  for (const name of dirs) await mkdir(join(sharedDir(), name), { recursive: true });
  if (!existsSync(sharedMcpPath())) await writeJson(sharedMcpPath(), { mcpServers: {} });
}

// How deep the merge reconciles before it parks a colliding subtree whole.
//
// The unit of merge is a *named thing*, and how deep that sits differs by
// directory. skills/, agents/ and commands/ hold one unit per entry, so a
// collision parks the whole entry — half-merging two accounts' versions of
// the same skill would produce something neither of them had. plugins/ holds
// container dirs (marketplaces/, cache/, data/) whose *entries* are the
// units, so it reconciles one level further and stops there: a colliding
// marketplace is the same cloned public repo in both accounts, and walking it
// file by file on first launch would buy nothing.
const MERGE_DEPTH: Record<string, number> = { plugins: 1 };
const DEFAULT_MERGE_DEPTH = 0;

// Files worth reconciling rather than picking a winner for.
const MEMORY_INDEX = "MEMORY.md";
const JSON_MANIFESTS = new Set(["installed_plugins.json", "known_marketplaces.json"]);

async function isEmptyDir(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    return true;
  }
}

// Park a path next to the account dir instead of deleting it. Never overwrites
// an earlier parked copy.
async function setAside(from: string, aside: string, report: AdoptReport): Promise<void> {
  let dest = aside;
  for (let n = 2; existsSync(dest); n += 1) dest = `${aside}.${n}`;
  await mkdir(dirname(dest), { recursive: true });
  await rename(from, dest);
  report.setAside.push(dest);
}

// MEMORY.md is a flat list of pointers, one per memory — two accounts' indexes
// union cleanly, which is the whole point of sharing memory in the first place.
async function mergeMemoryIndex(from: string, to: string): Promise<void> {
  const existing = (await readFile(to, "utf8")).split("\n");
  const incoming = (await readFile(from, "utf8")).split("\n");
  const seen = new Set(existing.map((l) => l.trim()));
  const added = incoming.filter((l) => l.trim().length > 0 && !seen.has(l.trim()));
  if (added.length > 0) {
    const body = existing.join("\n").replace(/\n+$/, "");
    await writeFile(to, `${body}\n${added.join("\n")}\n`, "utf8");
  }
  await rm(from, { force: true });
}

function mergeJsonValues(mine: unknown, theirs: unknown): unknown {
  if (Array.isArray(mine) && Array.isArray(theirs)) return [...new Set([...mine, ...theirs])];
  if (mine && theirs && typeof mine === "object" && typeof theirs === "object" && !Array.isArray(mine) && !Array.isArray(theirs)) {
    const out: Record<string, unknown> = { ...(mine as Record<string, unknown>) };
    for (const [k, v] of Object.entries(theirs as Record<string, unknown>)) {
      out[k] = k in out ? mergeJsonValues(out[k], v) : v;
    }
    return out;
  }
  return mine; // scalar conflict: the shared copy already won
}

async function mergeJsonManifest(from: string, to: string): Promise<void> {
  const mine = await readJson<unknown>(to);
  const theirs = await readJson<unknown>(from);
  if (mine !== null && theirs !== null) await writeJson(to, mergeJsonValues(mine, theirs));
  await rm(from, { force: true });
}

// Merge `from` into `to` entry by entry. Anything `to` doesn't have moves
// across; anything it does have is reconciled where that's meaningful, and
// parked otherwise. Nothing is ever deleted except a file we just merged.
async function mergeInto(from: string, to: string, aside: string, report: AdoptReport, maxDepth: number, depth = 0): Promise<void> {
  for (const entry of await readdir(from)) {
    const src = join(from, entry);
    const dest = join(to, entry);
    if (!existsSync(dest)) {
      await mkdir(dirname(dest), { recursive: true });
      await rename(src, dest);
      continue;
    }
    if (entry === MEMORY_INDEX) {
      await mergeMemoryIndex(src, dest);
      continue;
    }
    if (JSON_MANIFESTS.has(entry)) {
      await mergeJsonManifest(src, dest);
      continue;
    }
    const bothDirs = lstatSync(src).isDirectory() && lstatSync(dest).isDirectory();
    if (bothDirs && depth < maxDepth) {
      await mergeInto(src, dest, join(aside, entry), report, maxDepth, depth + 1);
      if (await isEmptyDir(src)) await rm(src, { recursive: true, force: true });
      continue;
    }
    await setAside(src, join(aside, entry), report);
  }
}

// Marketplace install locations are stored as absolute paths into whichever
// account dir installed them. Once the directory itself is shared, point them
// at the shared copy — otherwise removing that one account breaks the
// marketplace for every other account.
async function fixMarketplaceLocations(): Promise<void> {
  const path = join(sharedDir(), "plugins", "known_marketplaces.json");
  const known = await readJson<Record<string, { installLocation?: string }>>(path);
  if (!known) return;
  let changed = false;
  for (const [name, entry] of Object.entries(known)) {
    const shared = join(sharedDir(), "plugins", "marketplaces", name);
    if (!existsSync(shared) || entry.installLocation === shared) continue;
    entry.installLocation = shared;
    changed = true;
  }
  if (changed) await writeJson(path, known);
}

// Merge one account's own config up into the shared layer. Idempotent: an
// account whose paths are already symlinks has nothing left to adopt, so
// every launch after the first walks a handful of lstat calls and stops.
export async function adoptAccount(dir: string, dirs: readonly string[]): Promise<AdoptReport> {
  const report: AdoptReport = { adopted: [], setAside: [] };

  for (const sub of dirs) {
    const from = join(dir, sub);
    if (linkState(from) !== "real") continue;
    const to = join(sharedDir(), sub);
    await mkdir(to, { recursive: true });
    await mergeInto(from, to, `${from}.pre-balance`, report, MERGE_DEPTH[sub] ?? DEFAULT_MERGE_DEPTH);
    if (await isEmptyDir(from)) {
      await rm(from, { recursive: true, force: true });
      report.adopted.push(`${sub}/`);
    }
  }
  if (report.adopted.includes("plugins/")) await fixMarketplaceLocations();

  for (const [file, target] of [["CLAUDE.md", sharedMemoryPath()], ["settings.json", sharedSettingsPath()]] as const) {
    const from = join(dir, file);
    // The account keeps its own copy of both — user memory gains an @import
    // line, and settings.json stays the account's to override with.
    if (!existsSync(from) || existsSync(target)) continue;
    await writeFile(target, await readFile(from, "utf8"), "utf8");
    report.adopted.push(file);
  }

  const projects = join(dir, "projects");
  if (existsSync(projects)) {
    for (const slug of await readdir(projects)) {
      const from = join(projects, slug, "memory");
      if (linkState(from) !== "real") continue;
      const to = join(sharedMemoryDir(), slug);
      await mkdir(to, { recursive: true });
      // One memory per file, so a collision parks that file alone.
      await mergeInto(from, to, `${from}.pre-balance`, report, DEFAULT_MERGE_DEPTH);
      if (await isEmptyDir(from)) {
        await rm(from, { recursive: true, force: true });
        report.adopted.push(`memory/${slug}`);
      }
    }
  }

  // User-scope MCP servers out of .claude.json, plus every project's approval
  // state — the two things that decide whether another account's MCP servers
  // come up at all.
  const claude = await readJson<ClaudeJson>(claudeJsonPath(dir));
  const userServers = (claude?.mcpServers ?? {}) as Record<string, unknown>;
  if (Object.keys(userServers).length > 0) {
    const mcp = (await readJson<{ mcpServers?: Record<string, unknown> }>(sharedMcpPath())) ?? {};
    const before = Object.keys(mcp.mcpServers ?? {}).length;
    mcp.mcpServers = { ...userServers, ...(mcp.mcpServers ?? {}) };
    if (Object.keys(mcp.mcpServers).length > before) {
      await writeJson(sharedMcpPath(), mcp, 0o600);
      report.adopted.push(`${Object.keys(mcp.mcpServers).length - before} MCP server(s)`);
    }
  }
  let projectCount = 0;
  for (const cwd of Object.keys(claude?.projects ?? {})) {
    const before = JSON.stringify((await readJson<Record<string, ProjectState>>(sharedProjectsPath()))?.[cwd] ?? null);
    await harvestProjectState(dir, cwd);
    const after = JSON.stringify((await readJson<Record<string, ProjectState>>(sharedProjectsPath()))?.[cwd] ?? null);
    if (before !== after) projectCount += 1;
  }
  if (projectCount > 0) report.adopted.push(`MCP/trust state for ${projectCount} project(s)`);

  return report;
}

// Every slug the shared layer knows about, linked into an account — the
// launch path also links the project you're standing in, which may be new.
export async function linkAllProjectMemory(dir: string): Promise<number> {
  if (!existsSync(sharedMemoryDir())) return 0;
  let n = 0;
  for (const slug of await readdir(sharedMemoryDir())) {
    await mkdir(join(dir, "projects", slug), { recursive: true });
    if (await linkInto(join(dir, "projects", slug, "memory"), join(sharedMemoryDir(), slug))) n += 1;
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
