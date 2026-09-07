import { spawn } from "node:child_process";

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
}

// Run a command to completion and collect its output. Never rejects — a
// missing binary, a non-zero exit and a timeout all come back as a result
// with a non-zero `code`, because every caller here treats "it didn't work"
// as a reason to skip an optional step rather than to fail a launch.
export function run(cmd: string, args: string[], opts: ProcOptions = {}): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env,
      cwd: opts.cwd,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;

    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err), timedOut });
    });
  });
}
