import type { Account } from "./types";
import { formatDuration } from "./format";
import { bold, dim, gray, green } from "./tty";

// The picker deliberately does NOT fetch live usage — Anthropic doesn't expose
// a public usage endpoint balance can reliably hit across plan types. If you
// need to see utilization, type `/status` inside Claude Code once it launches.
export async function pickAccount(accounts: Account[]): Promise<Account | null> {
  if (accounts.length === 0) return null;
  if (accounts.length === 1) return accounts[0]!;

  process.stdout.write(bold("Accounts:") + "\n\n");
  const nameW = Math.max(...accounts.map((a) => a.name.length));
  const now = Date.now();

  accounts.forEach((a, i) => {
    const num = `${i + 1}`.padStart(2);
    const name = a.name.padEnd(nameW);
    const email = a.email ? dim(` <${a.email}>`) : "";
    const lastUsed = a.last_used_at
      ? dim(` — used ${formatDuration(a.last_used_at - now)} ago`)
      : dim(" — never used");
    const active = i === 0 ? green(" ●") : "";
    process.stdout.write(`${bold(num)}. ${name}${email}${lastUsed}${active}\n`);
  });

  process.stdout.write("\n");
  const answer = await promptLine(
    `Pick account [1-${accounts.length}, default: 1 (${accounts[0]!.name})]: `,
  );
  const trimmed = answer.trim();
  if (!trimmed) return accounts[0]!;
  const idx = Number(trimmed);
  if (!Number.isFinite(idx) || idx < 1 || idx > accounts.length) {
    const byName = accounts.find((a) => a.name === trimmed);
    if (byName) return byName;
    process.stderr.write(gray(`invalid choice: ${trimmed}\n`));
    return null;
  }
  return accounts[idx - 1]!;
}

async function promptLine(question: string): Promise<string> {
  process.stdout.write(question);
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
    const soFar = Buffer.concat(chunks).toString("utf8");
    if (soFar.includes("\n")) break;
  }
  return Buffer.concat(chunks).toString("utf8").split("\n")[0]!.trim();
}
