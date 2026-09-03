import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { log } from "./log";

// Launch Claude Code with a specific account's isolated CLAUDE_CONFIG_DIR.
// stdio is inherited so the user sees Claude Code's TUI directly. balance
// exits with Claude Code's exit code once it's done.
export function launchClaudeCode(
  claudeConfigDir: string,
  extraArgs: string[] = [],
  binary: string = "claude",
): void {
  if (!existsSync(claudeConfigDir)) {
    log.error("account directory not found", { dir: claudeConfigDir });
    process.exit(1);
  }

  // Set both env vars so older Claude Code versions that honored CLAUDE_HOME
  // still resolve the isolated dir alongside the current CLAUDE_CONFIG_DIR.
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CLAUDE_HOME: claudeConfigDir,
  };

  const child = spawn(binary, extraArgs, {
    stdio: "inherit",
    env,
  });

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });

  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      log.error(`${binary} not found on PATH — install Claude Code first (npm i -g @anthropic-ai/claude-code)`);
      process.exit(127);
    }
    log.error("failed to launch Claude Code", { err: String(err) });
    process.exit(1);
  });
}
