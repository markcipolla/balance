import { chmodSync, existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "./log";

// Write via a temp file and rename, so a reader never sees a half-written
// config — and so a crash mid-write can't leave the shared layer corrupt.
export async function writeJson(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
  if (mode !== undefined) {
    try { chmodSync(path, mode); } catch { /* best-effort */ }
  }
}

// A malformed file is treated as absent. Everything read through here is
// optional state we can rebuild, so warning and moving on beats refusing to
// launch over a stray comma.
export async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    log.warn("could not parse JSON — ignoring it", { path, err: String(err) });
    return null;
  }
}
