import type { Account } from "./types";
import { fetchUsage, type AccountUsage, type UsageWindow } from "./usage";
import { accountDir } from "./paths";
import { bar } from "./bar";
import { formatDuration } from "./format";
import { bold, dim, gray, green, red, yellow } from "./tty";

const BAR_WIDTH = 14;

function renderWindow(label: string, w: UsageWindow, now: number): string {
  if (w.utilization == null) {
    return `${dim(label.padEnd(3))} ${dim("░".repeat(BAR_WIDTH))} ${dim("—")}`;
  }
  const chart = bar(w.utilization, 1, BAR_WIDTH);
  const color = w.utilization >= 0.9 ? red : w.utilization >= 0.7 ? yellow : green;
  const pct = `${Math.round(w.utilization * 100)}%`.padStart(4);
  const reset = w.resets_at ? ` ${dim(`(${formatDuration(w.resets_at - now)})`)}` : "";
  return `${dim(label.padEnd(3))} ${color(chart)} ${color(pct)}${reset}`;
}

interface Row {
  account: Account;
  usage: AccountUsage;
}

export async function pickAccount(accounts: Account[]): Promise<Account | null> {
  if (accounts.length === 0) return null;
  if (accounts.length === 1) return accounts[0]!;

  process.stdout.write(dim("fetching usage…\r"));

  // Parallel fetch — each usage.fetchUsage has a 4s timeout, so the picker
  // renders after at most 4s regardless of how many accounts are configured.
  const rows: Row[] = await Promise.all(
    accounts.map(async (a) => ({
      account: a,
      usage: await fetchUsage(accountDir(a.name)),
    })),
  );

  process.stdout.write("\x1b[2K\r"); // clear the "fetching…" line
  process.stdout.write(bold("Accounts:") + "\n\n");

  const nameW = Math.max(...rows.map((r) => r.account.name.length));
  const now = Date.now();

  rows.forEach((r, i) => {
    const num = `${i + 1}`.padStart(2);
    const name = r.account.name.padEnd(nameW);
    const email = r.account.email ? dim(` <${r.account.email}>`) : "";
    process.stdout.write(`${bold(num)}. ${name}${email}\n`);
    process.stdout.write(`    ${renderWindow("5h", r.usage.five_hour, now)}\n`);
    process.stdout.write(`    ${renderWindow("7d", r.usage.seven_day, now)}\n`);
    if (r.usage.seven_day_opus.utilization != null) {
      process.stdout.write(`    ${renderWindow("op", r.usage.seven_day_opus, now)}\n`);
    }
    if (r.usage.overage_status === "rejected") {
      process.stdout.write(`    ${yellow("extra usage: disabled")}\n`);
    }
    if (r.usage.error) {
      process.stdout.write(`    ${dim("usage:")} ${red("⚠ " + r.usage.error)}\n`);
    }
    process.stdout.write("\n");
  });

  const answer = await promptLine(`Pick account [1-${accounts.length}, default: 1 (${accounts[0]!.name})]: `);
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
