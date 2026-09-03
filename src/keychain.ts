import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import type { ClaudeCredentials } from "./credentials";
import { log } from "./log";

// macOS Keychain entry Claude Code TUI actually reads from. On macOS the TUI
// checks Keychain BEFORE any env var or file — so to make Claude Code launch
// as a specific balance account, we have to write that account's credentials
// into this slot.
//
// There's only one slot per Mac user, machine-wide, so overwriting it also
// affects any standalone `claude` invocations outside balance. This is
// intrinsic to Claude Code's design, not something balance can dodge.
const SERVICE = "Claude Code-credentials";

function spawnAsync(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("exit", (code) => resolve({ code: code ?? -1, stderr }));
    child.on("error", (err) => resolve({ code: -1, stderr: String(err) }));
  });
}

export function isMac(): boolean {
  return process.platform === "darwin";
}

// Write the given credentials into the Keychain slot Claude Code TUI reads.
// Idempotent — deletes any existing entry first so we don't accumulate slots.
// The first call may trigger a macOS permission dialog; the user can pick
// "Always Allow" so subsequent launches don't prompt.
export async function writeKeychainCreds(creds: ClaudeCredentials): Promise<boolean> {
  if (!isMac()) return true; // no-op on Linux/Windows; Claude Code reads .credentials.json there.

  const account = userInfo().username;
  const value = JSON.stringify(creds);

  // Best-effort delete of any existing entry — ignore errors (entry may not exist yet).
  await spawnAsync("security", ["delete-generic-password", "-s", SERVICE, "-a", account]);

  // -U updates if a matching entry exists (belt & suspenders vs the delete above).
  const res = await spawnAsync("security", [
    "add-generic-password",
    "-s", SERVICE,
    "-a", account,
    "-w", value,
    "-U",
  ]);
  if (res.code !== 0) {
    log.warn("failed to write Keychain entry — Claude Code TUI will prompt for login", { stderr: res.stderr.trim() });
    return false;
  }
  return true;
}
