import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Opencode looks for a config in this order; we install into the first match
// that exists (so we don't accidentally shadow an existing project config)
// unless the caller passed --project or --global explicitly.
export function opencodeGlobalPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "opencode", "opencode.jsonc");
}

export function opencodeProjectPath(cwd: string = process.cwd()): string {
  return resolve(cwd, "opencode.jsonc");
}

// Also match older/alternate filenames when detecting an existing install.
const DETECT_NAMES = ["opencode.jsonc", "opencode.json"];

export function findExistingOpencodeConfig(): string | null {
  const candidates: string[] = [];
  for (const name of DETECT_NAMES) candidates.push(resolve(process.cwd(), name));
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  for (const name of DETECT_NAMES) candidates.push(join(base, "opencode", name));
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

// Very minimal JSONC comment stripper. Handles // line comments and /* block */
// comments outside of strings. Not bulletproof (won't handle // inside a string
// containing an escaped quote perfectly), but robust enough for opencode
// configs, which are small and hand-authored.
function stripJsoncComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let inString: '"' | "'" | null = null;
  let escape = false;
  while (i < n) {
    const ch = src[i]!;
    const next = i + 1 < n ? src[i + 1]! : "";
    if (inString) {
      out += ch;
      if (escape) { escape = false; }
      else if (ch === "\\") { escape = true; }
      else if (ch === inString) { inString = null; }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; out += ch; i += 1; continue; }
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

interface OpencodeConfig {
  $schema?: string;
  provider?: {
    anthropic?: {
      options?: {
        baseURL?: string;
        apiKey?: string;
        [k: string]: unknown;
      };
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface WireResult {
  path: string;
  action: "created" | "updated" | "already-current" | "printed";
  hadComments: boolean;
  before: OpencodeConfig | null;
  after: OpencodeConfig;
}

export function buildOpencodeConfig(
  existing: OpencodeConfig | null,
  baseURL: string,
  apiKey: string,
): OpencodeConfig {
  const cfg: OpencodeConfig = existing ? structuredClone(existing) : {};
  cfg.$schema ??= "https://opencode.ai/config.json";
  cfg.provider ??= {};
  cfg.provider.anthropic ??= {};
  cfg.provider.anthropic.options ??= {};
  cfg.provider.anthropic.options.baseURL = baseURL;
  cfg.provider.anthropic.options.apiKey = apiKey;
  return cfg;
}

function shallowEqual(a: OpencodeConfig | null, b: OpencodeConfig): boolean {
  if (!a) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface WireOptions {
  path: string;                 // target file
  baseURL: string;
  apiKey: string;
  print?: boolean;              // dry-run: don't write, just return the rendered config
  force?: boolean;              // overwrite even if JSONC parse failed
}

export async function wireOpencode(opts: WireOptions): Promise<WireResult> {
  const path = opts.path;
  let existing: OpencodeConfig | null = null;
  let hadComments = false;
  let parseError: unknown = null;

  if (existsSync(path)) {
    const raw = await readFile(path, "utf8");
    try {
      existing = JSON.parse(raw) as OpencodeConfig;
    } catch {
      const stripped = stripJsoncComments(raw);
      hadComments = stripped !== raw;
      try {
        existing = JSON.parse(stripped) as OpencodeConfig;
      } catch (err) {
        parseError = err;
      }
    }
  }

  if (parseError && !opts.force) {
    throw new Error(
      `${path} exists but doesn't parse as JSON/JSONC. Re-run with --force to overwrite it, or edit the file by hand and add:\n${JSON.stringify(
        buildOpencodeConfig(null, opts.baseURL, opts.apiKey),
        null,
        2,
      )}`,
    );
  }

  const next = buildOpencodeConfig(parseError ? null : existing, opts.baseURL, opts.apiKey);
  const identical = shallowEqual(existing, next);

  if (opts.print) {
    return { path, action: "printed", hadComments, before: existing, after: next };
  }

  if (identical) {
    return { path, action: "already-current", hadComments, before: existing, after: next };
  }

  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  await rename(tmp, path);

  return {
    path,
    action: existing ? "updated" : "created",
    hadComments,
    before: existing,
    after: next,
  };
}
