import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readlinkSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptAccount,
  applySharedLayer,
  harvestProjectState,
  initShared,
  linkReport,
  projectSlug,
  seedProjectState,
  sharedActive,
  sharedDir,
  sharedLaunchArgs,
  sharedMcpPath,
  sharedMemoryDir,
  sharedMemoryPath,
  sharedProjectsPath,
  sharedSettingsPath,
} from "./shared";
import type { SharedSettings } from "./types";

const DIRS = ["skills", "agents", "commands", "plugins"];

const SETTINGS: SharedSettings = {
  enabled: true,
  dirs: DIRS,
  mcp: true,
  strict_mcp: false,
  settings: true,
  memory: true,
  projects: true,
};

let home: string;
let previousHome: string | undefined;

// Every test gets its own BALANCE_HOME, so nothing can reach the real
// ~/.balance — these functions move directories around for a living.
beforeEach(async () => {
  previousHome = process.env.BALANCE_HOME;
  home = await mkdtemp(join(tmpdir(), "balance-test-"));
  process.env.BALANCE_HOME = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.BALANCE_HOME;
  else process.env.BALANCE_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

function accountPath(name: string): string {
  return join(home, "accounts", name);
}

async function write(path: string, body: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body, "utf8");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await write(path, JSON.stringify(value, null, 2));
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

// An account with a skill, a plugin marketplace, project memory and some MCP
// state — the shape adoption actually meets on a first launch.
async function seedAccount(name: string, opts: { skill?: string; marketplace?: boolean; memory?: boolean } = {}) {
  const dir = accountPath(name);
  await mkdir(dir, { recursive: true });
  if (opts.skill) await write(join(dir, "skills", opts.skill, "SKILL.md"), `${name}: ${opts.skill}\n`);
  if (opts.marketplace) {
    await write(join(dir, "plugins", "marketplaces", "official", "README.md"), `clone in ${name}\n`);
    await writeJson(join(dir, "plugins", "installed_plugins.json"), { version: 2, plugins: { [`${name}-plugin`]: { enabled: true } } });
    await writeJson(join(dir, "plugins", "known_marketplaces.json"), {
      official: {
        source: { source: "github", repo: "x/y" },
        installLocation: join(dir, "plugins", "marketplaces", "official"),
      },
    });
  }
  if (opts.memory) {
    await write(join(dir, "projects", "-tmp-repo", "memory", "MEMORY.md"), `- [${name}](${name}.md) — from ${name}\n`);
    await write(join(dir, "projects", "-tmp-repo", "memory", `${name}.md`), `${name} memory\n`);
  }
  return dir;
}

describe("projectSlug", () => {
  // Matches the names Claude Code actually writes under projects/.
  test("replaces every non-alphanumeric character with a dash", () => {
    expect(projectSlug("/Users/me/dev/balance")).toBe("-Users-me-dev-balance");
  });

  test("collapses nothing — a dot becomes its own dash, as in .worktrees", () => {
    expect(projectSlug("/Users/me/dev/app/.worktrees/fix")).toBe("-Users-me-dev-app--worktrees-fix");
  });

  test("leaves digits and existing dashes alone", () => {
    expect(projectSlug("/tmp/LAB-928/v2")).toBe("-tmp-LAB-928-v2");
  });
});

describe("sharedActive", () => {
  test("is on by default, with no setup step", () => {
    expect(sharedActive(SETTINGS)).toBe(true);
  });

  test("is off when disabled in config", () => {
    expect(sharedActive({ ...SETTINGS, enabled: false })).toBe(false);
  });
});

describe("initShared", () => {
  test("creates the skeleton and an empty MCP file", async () => {
    await initShared(DIRS);
    for (const d of DIRS) expect(existsSync(join(sharedDir(), d))).toBe(true);
    expect(existsSync(sharedMemoryDir())).toBe(true);
    expect(await readJson(sharedMcpPath())).toEqual({ mcpServers: {} });
  });

  test("leaves an existing MCP file alone", async () => {
    await initShared(DIRS);
    await writeJson(sharedMcpPath(), { mcpServers: { keep: { type: "http", url: "https://k" } } });
    await initShared(DIRS);
    expect(Object.keys((await readJson(sharedMcpPath())).mcpServers)).toEqual(["keep"]);
  });
});

describe("adoptAccount", () => {
  test("moves an account's own skills up into the shared layer", async () => {
    const dir = await seedAccount("work", { skill: "one" });
    await initShared(DIRS);
    const report = await adoptAccount(dir, DIRS);

    expect(report.adopted).toContain("skills/");
    expect(existsSync(join(sharedDir(), "skills", "one", "SKILL.md"))).toBe(true);
    // The account's copy is gone, ready to be replaced by a symlink.
    expect(existsSync(join(dir, "skills"))).toBe(false);
  });

  test("unions two accounts rather than letting the first one win", async () => {
    await initShared(DIRS);
    const work = await seedAccount("work", { skill: "work-only" });
    const personal = await seedAccount("personal", { skill: "personal-only" });
    await adoptAccount(work, DIRS);
    await adoptAccount(personal, DIRS);

    expect(existsSync(join(sharedDir(), "skills", "work-only"))).toBe(true);
    expect(existsSync(join(sharedDir(), "skills", "personal-only"))).toBe(true);
  });

  test("parks a colliding file instead of overwriting or deleting it", async () => {
    await initShared(DIRS);
    const work = await seedAccount("work", { skill: "same" });
    const personal = await seedAccount("personal", { skill: "same" });
    await adoptAccount(work, DIRS);
    const report = await adoptAccount(personal, DIRS);

    // Shared keeps the first copy...
    expect(await readFile(join(sharedDir(), "skills", "same", "SKILL.md"), "utf8")).toContain("work:");
    // ...and the loser is still on disk, next to the account.
    const parked = join(personal, "skills.pre-balance", "same");
    expect(report.setAside).toContain(parked);
    expect(await readFile(join(parked, "SKILL.md"), "utf8")).toContain("personal:");
  });

  test("never reuses a parked path, so a second conflict cannot clobber the first", async () => {
    await initShared(DIRS);
    const work = await seedAccount("work", { skill: "same" });
    await adoptAccount(work, DIRS);

    const personal = accountPath("personal");
    await write(join(personal, "skills", "same", "SKILL.md"), "first\n");
    await adoptAccount(personal, DIRS);
    await write(join(personal, "skills", "same", "SKILL.md"), "second\n");
    const report = await adoptAccount(personal, DIRS);

    expect(report.setAside[0]).toMatch(/same\.2$/);
    expect(await readFile(join(personal, "skills.pre-balance", "same", "SKILL.md"), "utf8")).toBe("first\n");
    expect(await readFile(join(personal, "skills.pre-balance", "same.2", "SKILL.md"), "utf8")).toBe("second\n");
  });

  test("parks a colliding skill whole rather than mixing two versions of it", async () => {
    await initShared(DIRS);
    const work = accountPath("work");
    await write(join(work, "skills", "same", "SKILL.md"), "work\n");
    await adoptAccount(work, DIRS);

    const personal = accountPath("personal");
    await write(join(personal, "skills", "same", "SKILL.md"), "personal\n");
    await write(join(personal, "skills", "same", "reference.md"), "personal extra\n");
    await adoptAccount(personal, DIRS);

    // The shared skill is work's, untouched — not work's SKILL.md beside
    // personal's reference.md, which is a skill neither of them wrote.
    expect(existsSync(join(sharedDir(), "skills", "same", "reference.md"))).toBe(false);
    expect(await readFile(join(personal, "skills.pre-balance", "same", "reference.md"), "utf8")).toBe("personal extra\n");
  });

  test("unions MEMORY.md line by line", async () => {
    await initShared(DIRS);
    const work = await seedAccount("work", { memory: true });
    const personal = await seedAccount("personal", { memory: true });
    await adoptAccount(work, DIRS);
    await adoptAccount(personal, DIRS);

    const index = await readFile(join(sharedMemoryDir(), "-tmp-repo", "MEMORY.md"), "utf8");
    expect(index).toContain("from work");
    expect(index).toContain("from personal");
    expect(existsSync(join(sharedMemoryDir(), "-tmp-repo", "work.md"))).toBe(true);
    expect(existsSync(join(sharedMemoryDir(), "-tmp-repo", "personal.md"))).toBe(true);
  });

  test("does not duplicate a MEMORY.md line both accounts already had", async () => {
    await initShared(DIRS);
    const line = "- [shared](s.md) — same pointer\n";
    const work = accountPath("work");
    const personal = accountPath("personal");
    await write(join(work, "projects", "-r", "memory", "MEMORY.md"), line);
    await write(join(personal, "projects", "-r", "memory", "MEMORY.md"), line);
    await adoptAccount(work, DIRS);
    await adoptAccount(personal, DIRS);

    const index = await readFile(join(sharedMemoryDir(), "-r", "MEMORY.md"), "utf8");
    expect(index.split("\n").filter((l) => l.includes("same pointer"))).toHaveLength(1);
  });

  test("merges plugin manifests key by key", async () => {
    await initShared(DIRS);
    const work = await seedAccount("work", { marketplace: true });
    const personal = await seedAccount("personal", { marketplace: true });
    await adoptAccount(work, DIRS);
    await adoptAccount(personal, DIRS);

    const installed = await readJson(join(sharedDir(), "plugins", "installed_plugins.json"));
    expect(Object.keys(installed.plugins).sort()).toEqual(["personal-plugin", "work-plugin"]);
  });

  test("repoints marketplace installLocation at the shared copy", async () => {
    await initShared(DIRS);
    const work = await seedAccount("work", { marketplace: true });
    await adoptAccount(work, DIRS);

    const known = await readJson(join(sharedDir(), "plugins", "known_marketplaces.json"));
    // Leaving this pointing into the account dir would break every other
    // account the moment that one is removed.
    expect(known.official.installLocation).toBe(join(sharedDir(), "plugins", "marketplaces", "official"));
    expect(known.official.installLocation).not.toContain("accounts");
  });

  test("stops descending past the depth limit and parks the subtree whole", async () => {
    await initShared(DIRS);
    const work = await seedAccount("work", { marketplace: true });
    const personal = await seedAccount("personal", { marketplace: true });
    await write(join(personal, "plugins", "marketplaces", "official", "deep", "nested.txt"), "x\n");
    await adoptAccount(work, DIRS);
    const report = await adoptAccount(personal, DIRS);

    // marketplaces/official is the unit: parked whole, never walked into.
    expect(report.setAside.some((p) => p.endsWith(join("plugins.pre-balance", "marketplaces", "official")))).toBe(true);
    expect(existsSync(join(sharedDir(), "plugins", "marketplaces", "official", "deep"))).toBe(false);
  });

  test("lifts user-scope MCP servers out of .claude.json without displacing existing ones", async () => {
    await initShared(DIRS);
    await writeJson(sharedMcpPath(), { mcpServers: { first: { type: "http", url: "https://1" } } });
    const dir = accountPath("work");
    await writeJson(join(dir, ".claude.json"), { mcpServers: { second: { type: "http", url: "https://2" } } });
    const report = await adoptAccount(dir, DIRS);

    const mcp = await readJson(sharedMcpPath());
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(["first", "second"]);
    expect(report.adopted).toContain("1 MCP server(s)");
  });

  test("copies CLAUDE.md and settings.json only when the shared layer has none", async () => {
    await initShared(DIRS);
    const work = accountPath("work");
    await write(join(work, "CLAUDE.md"), "# work memory\n");
    await write(join(work, "settings.json"), '{"theme":"dark"}');
    await adoptAccount(work, DIRS);

    const personal = accountPath("personal");
    await write(join(personal, "CLAUDE.md"), "# personal memory\n");
    await adoptAccount(personal, DIRS);

    expect(await readFile(sharedMemoryPath(), "utf8")).toBe("# work memory\n");
    expect(existsSync(sharedSettingsPath())).toBe(true);
    // The account keeps its own file either way — it gains an @import line.
    expect(await readFile(join(personal, "CLAUDE.md"), "utf8")).toContain("# personal memory");
  });

  test("carries per-project MCP approvals and trust up", async () => {
    await initShared(DIRS);
    const dir = accountPath("work");
    await writeJson(join(dir, ".claude.json"), {
      projects: {
        "/tmp/repo": {
          enabledMcpjsonServers: ["linear"],
          hasTrustDialogAccepted: true,
          mcpServers: { local: { type: "http", url: "https://l" } },
        },
      },
    });
    const report = await adoptAccount(dir, DIRS);

    const shared = await readJson(sharedProjectsPath());
    expect(shared["/tmp/repo"].enabledMcpjsonServers).toEqual(["linear"]);
    expect(shared["/tmp/repo"].hasTrustDialogAccepted).toBe(true);
    expect(shared["/tmp/repo"].mcpServers.local).toBeDefined();
    expect(report.adopted).toContain("MCP/trust state for 1 project(s)");
  });

  test("is a no-op the second time — nothing left to adopt, nothing new parked", async () => {
    await initShared(DIRS);
    const dir = await seedAccount("work", { skill: "one", marketplace: true, memory: true });
    await applySharedLayer(dir, "/tmp/repo", SETTINGS);
    const second = await adoptAccount(dir, DIRS);

    expect(second.adopted).toEqual([]);
    expect(second.setAside).toEqual([]);
  });
});

describe("applySharedLayer", () => {
  test("links the shared dirs into the account", async () => {
    const dir = await seedAccount("work", { skill: "one" });
    await applySharedLayer(dir, "/tmp/repo", SETTINGS);

    for (const d of DIRS) {
      const path = join(dir, d);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(readlinkSync(path)).toBe(join(sharedDir(), d));
    }
  });

  test("needs no prior setup — it creates the shared layer itself", async () => {
    expect(existsSync(sharedDir())).toBe(false);
    const dir = await seedAccount("work", {});
    await applySharedLayer(dir, "/tmp/repo", SETTINGS);
    expect(existsSync(sharedDir())).toBe(true);
  });

  test("imports shared user memory, keeping the account's own notes", async () => {
    await initShared(DIRS);
    await write(sharedMemoryPath(), "# shared\n");
    const dir = accountPath("work");
    await write(join(dir, "CLAUDE.md"), "# mine\n");
    await applySharedLayer(dir, "/tmp/repo", SETTINGS);

    const body = await readFile(join(dir, "CLAUDE.md"), "utf8");
    // Absolute, so nothing depends on how an import expands "~".
    expect(body).toContain(`@${sharedMemoryPath()}`);
    expect(body).toContain("# mine");
  });

  test("does not add the import twice", async () => {
    await initShared(DIRS);
    await write(sharedMemoryPath(), "# shared\n");
    const dir = accountPath("work");
    await applySharedLayer(dir, "/tmp/repo", SETTINGS);
    await applySharedLayer(dir, "/tmp/repo", SETTINGS);

    const body = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(body.split(`@${sharedMemoryPath()}`)).toHaveLength(2);
  });

  test("links memory for the launch directory and for every project the layer knows", async () => {
    await initShared(DIRS);
    await mkdir(join(sharedMemoryDir(), "-other-project"), { recursive: true });
    const dir = accountPath("work");
    await applySharedLayer(dir, "/tmp/repo", SETTINGS);

    expect(readlinkSync(join(dir, "projects", projectSlug("/tmp/repo"), "memory"))).toBe(join(sharedMemoryDir(), projectSlug("/tmp/repo")));
    expect(readlinkSync(join(dir, "projects", "-other-project", "memory"))).toBe(join(sharedMemoryDir(), "-other-project"));
  });

  test("leaves memory alone when memory sharing is off", async () => {
    const dir = accountPath("work");
    await applySharedLayer(dir, "/tmp/repo", { ...SETTINGS, memory: false });
    expect(existsSync(join(dir, "projects", projectSlug("/tmp/repo"), "memory"))).toBe(false);
  });

  test("only links the dirs the config asks for", async () => {
    const dir = accountPath("work");
    await applySharedLayer(dir, "/tmp/repo", { ...SETTINGS, dirs: ["skills"] });
    expect(lstatSync(join(dir, "skills")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, "plugins"))).toBe(false);
  });

  test("refuses to clobber a real directory the merge could not empty", async () => {
    await initShared(DIRS);
    // A parked-file collision leaves the account's dir non-empty, so linking
    // must back off rather than replace it.
    const work = await seedAccount("work", { skill: "same" });
    await adoptAccount(work, DIRS);
    const personal = await seedAccount("personal", { skill: "same" });
    await mkdir(join(personal, "skills", "same", "subdir", "deeper"), { recursive: true });
    await write(join(personal, "skills", "same", "subdir", "deeper", "f.txt"), "x\n");
    await applySharedLayer(personal, "/tmp/repo", SETTINGS);

    // Whatever happened, the account's data is still there and readable.
    expect(existsSync(join(personal, "skills")) || existsSync(join(personal, "skills.pre-balance"))).toBe(true);
  });
});

describe("sharedLaunchArgs", () => {
  test("passes the shared MCP file, and nothing else by default", async () => {
    await initShared(DIRS);
    expect(sharedLaunchArgs(SETTINGS, [])).toEqual(["--mcp-config", sharedMcpPath()]);
  });

  test("adds --strict-mcp-config only when asked", async () => {
    await initShared(DIRS);
    expect(sharedLaunchArgs({ ...SETTINGS, strict_mcp: true }, [])).toEqual([
      "--mcp-config",
      sharedMcpPath(),
      "--strict-mcp-config",
    ]);
  });

  test("passes shared settings once the file exists", async () => {
    await initShared(DIRS);
    await write(sharedSettingsPath(), "{}");
    expect(sharedLaunchArgs(SETTINGS, [])).toEqual(["--mcp-config", sharedMcpPath(), "--settings", sharedSettingsPath()]);
  });

  test("stands aside when the caller passed its own flags", async () => {
    await initShared(DIRS);
    await write(sharedSettingsPath(), "{}");
    const forwarded = ["--mcp-config", "/mine.json", "--settings", "/mine-settings.json"];
    expect(sharedLaunchArgs(SETTINGS, forwarded)).toEqual([]);
  });

  test("emits nothing when the pieces are switched off", async () => {
    await initShared(DIRS);
    await write(sharedSettingsPath(), "{}");
    expect(sharedLaunchArgs({ ...SETTINGS, mcp: false, settings: false }, [])).toEqual([]);
  });

  test("emits nothing before the shared files exist", () => {
    expect(sharedLaunchArgs(SETTINGS, [])).toEqual([]);
  });
});

describe("seedProjectState", () => {
  async function sharedEntry(entry: unknown): Promise<void> {
    await writeJson(sharedProjectsPath(), { "/tmp/repo": entry });
  }

  test("fills in servers, approvals and trust for an account that has none", async () => {
    await sharedEntry({
      mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
      enabledMcpjsonServers: ["context7"],
      hasTrustDialogAccepted: true,
    });
    const dir = accountPath("personal");
    await writeJson(join(dir, ".claude.json"), { hasCompletedOnboarding: true });
    await seedProjectState(dir, "/tmp/repo");

    const project = (await readJson(join(dir, ".claude.json"))).projects["/tmp/repo"];
    expect(project.mcpServers.linear).toBeDefined();
    expect(project.enabledMcpjsonServers).toEqual(["context7"]);
    expect(project.hasTrustDialogAccepted).toBe(true);
  });

  test("keeps a choice the account already made", async () => {
    await sharedEntry({ mcpServers: { linear: { url: "https://shared" } } });
    const dir = accountPath("personal");
    await writeJson(join(dir, ".claude.json"), {
      projects: { "/tmp/repo": { mcpServers: { linear: { url: "https://mine" } } } },
    });
    await seedProjectState(dir, "/tmp/repo");

    const project = (await readJson(join(dir, ".claude.json"))).projects["/tmp/repo"];
    expect(project.mcpServers.linear.url).toBe("https://mine");
  });

  test("unions approval lists instead of replacing them", async () => {
    await sharedEntry({ enabledMcpjsonServers: ["a", "b"] });
    const dir = accountPath("personal");
    await writeJson(join(dir, ".claude.json"), { projects: { "/tmp/repo": { enabledMcpjsonServers: ["b", "c"] } } });
    await seedProjectState(dir, "/tmp/repo");

    const project = (await readJson(join(dir, ".claude.json"))).projects["/tmp/repo"];
    expect([...project.enabledMcpjsonServers].sort()).toEqual(["a", "b", "c"]);
  });

  test("leaves identity and unrelated keys untouched", async () => {
    await sharedEntry({ hasTrustDialogAccepted: true });
    const dir = accountPath("personal");
    await writeJson(join(dir, ".claude.json"), {
      oauthAccount: { emailAddress: "someone@example.com" },
      userID: "abc123",
      projects: {},
    });
    await seedProjectState(dir, "/tmp/repo");

    const claude = await readJson(join(dir, ".claude.json"));
    expect(claude.oauthAccount.emailAddress).toBe("someone@example.com");
    expect(claude.userID).toBe("abc123");
  });

  test("does nothing when the shared layer knows nothing about the project", async () => {
    const dir = accountPath("personal");
    await writeJson(join(dir, ".claude.json"), { hasCompletedOnboarding: true });
    await seedProjectState(dir, "/tmp/elsewhere");
    expect(await readJson(join(dir, ".claude.json"))).toEqual({ hasCompletedOnboarding: true });
  });

  test("does nothing when the account has no .claude.json yet", async () => {
    await sharedEntry({ hasTrustDialogAccepted: true });
    const dir = accountPath("personal");
    await mkdir(dir, { recursive: true });
    await seedProjectState(dir, "/tmp/repo");
    expect(existsSync(join(dir, ".claude.json"))).toBe(false);
  });
});

describe("harvestProjectState", () => {
  test("records what the session decided", async () => {
    const dir = accountPath("work");
    await writeJson(join(dir, ".claude.json"), {
      projects: { "/tmp/repo": { enabledMcpjsonServers: ["linear"], hasTrustDialogAccepted: true } },
    });
    await harvestProjectState(dir, "/tmp/repo");

    const shared = await readJson(sharedProjectsPath());
    expect(shared["/tmp/repo"].enabledMcpjsonServers).toEqual(["linear"]);
  });

  test("keeps the file owner-only — it can carry MCP auth headers", async () => {
    const dir = accountPath("work");
    await writeJson(join(dir, ".claude.json"), {
      projects: { "/tmp/repo": { mcpServers: { h: { headers: { Authorization: "Bearer x" } } } } },
    });
    await harvestProjectState(dir, "/tmp/repo");

    expect(statSync(sharedProjectsPath()).mode & 0o777).toBe(0o600);
  });

  test("merges with what other accounts already contributed", async () => {
    await writeJson(sharedProjectsPath(), { "/tmp/repo": { enabledMcpjsonServers: ["from-work"] } });
    const dir = accountPath("personal");
    await writeJson(join(dir, ".claude.json"), {
      projects: { "/tmp/repo": { enabledMcpjsonServers: ["from-personal"] } },
    });
    await harvestProjectState(dir, "/tmp/repo");

    const shared = await readJson(sharedProjectsPath());
    expect([...shared["/tmp/repo"].enabledMcpjsonServers].sort()).toEqual(["from-personal", "from-work"]);
  });

  test("does not write when nothing changed", async () => {
    const dir = accountPath("work");
    await writeJson(join(dir, ".claude.json"), { projects: { "/tmp/repo": { hasTrustDialogAccepted: true } } });
    await harvestProjectState(dir, "/tmp/repo");
    const first = statSync(sharedProjectsPath()).mtimeMs;
    await harvestProjectState(dir, "/tmp/repo");
    expect(statSync(sharedProjectsPath()).mtimeMs).toBe(first);
  });

  test("ignores a project the account has never opened", async () => {
    const dir = accountPath("work");
    await writeJson(join(dir, ".claude.json"), { projects: {} });
    await harvestProjectState(dir, "/tmp/repo");
    expect(existsSync(sharedProjectsPath())).toBe(false);
  });
});

describe("linkReport", () => {
  test("distinguishes shared, own and absent", async () => {
    const dir = await seedAccount("work", { skill: "one" });
    await mkdir(join(dir, "agents"), { recursive: true });
    await applySharedLayer(dir, "/tmp/repo", { ...SETTINGS, dirs: ["skills"] });

    const report = new Map(linkReport(dir, ["skills", "agents", "commands"]).map((r) => [r.name, r.state]));
    expect(report.get("skills")).toBe("shared");
    expect(report.get("agents")).toBe("own copy");
    expect(report.get("commands")).toBe("—");
  });
});
