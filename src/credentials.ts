import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Claude Code's native credentials file. When CLAUDE_CONFIG_DIR points at a
// directory containing this, Claude Code reads OAuth creds from here instead
// of the machine's default location — the mechanism that lets one machine
// hold several isolated Claude Code accounts side-by-side.
export interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
  };
}

export async function writeCredentials(dir: string, creds: ClaudeCredentials): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, ".credentials.json");
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(creds, null, 2) + "\n", "utf8");
  await rename(tmp, path);
  // Match Claude Code's expected file mode — creds should not be world-readable.
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

export async function readCredentials(dir: string): Promise<ClaudeCredentials | null> {
  const path = join(dir, ".credentials.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as ClaudeCredentials;
  } catch {
    return null;
  }
}
