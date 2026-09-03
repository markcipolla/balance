import type { Account } from "./types";
import type { AccountUsage } from "./usage";
import { fetchUsage } from "./usage";
import { accountDir } from "./paths";
import { bar, percent } from "./bar";
import { formatDuration } from "./format";
import { bold, dim, gray, green, red, yellow } from "./tty";

interface AccountRow {
  account: Account;
  usage: AccountUsage;
}

const BAR_WIDTH = 14;

function utilizationCell(label: string, util: number | null, resetAt: number | null): string {
  if (util == null) return `${dim(label.padEnd(3))} ${dim("░".repeat(BAR_WIDTH))} ${dim("—")}`;
  const chart = bar(util, 1, BAR_WIDTH);
  const colored = util >= 0.9 ? red(chart) : util >= 0.7 ? yellow(chart) : green(chart);
  const pct = percent(util, 1);
  const reset = resetAt ? ` ${dim(`(${formatDuration(resetAt - Date.now())})`)}` : "";
  return `${dim(label.padEnd(3))} ${colored} ${pct}${reset}`;
}

function statusHint(u: AccountUsage): string {
  if (u.error) return red(`⚠ ${u.error}`);
  const anyMissing = u.five_hour.utilization == null && u.seven_day.utilization == null;
  if (anyMissing) return dim("no usage data returned");
  return "";
}

export async function pickAccount(accounts: Account[]): Promise<Account | null> {
  if (accounts.length === 0) return null;
  if (accounts.length === 1) return accounts[0]!;

  process.stdout.write(bold("Accounts:") + "\n\n");

  // Fetch usage for all accounts in parallel. Each has a 3s timeout inside
  // fetchUsage, so worst case we wait 3s before rendering the picker.
  const rows: AccountRow[] = await Promise.all(
    accounts.map(async (a) => ({
      account: a,
      usage: await fetchUsage(accountDir(a.name)),
    })),
  );

  const nameW = Math.max(...rows.map((r) => r.account.name.length));

  rows.forEach((r, i) => {
    const num = `${i + 1}`.padStart(2);
    const name = r.account.name.padEnd(nameW);
    const email = r.account.email ? dim(` <${r.account.email}>`) : "";
    process.stdout.write(`${bold(num)}. ${name}${email}\n`);
    process.stdout.write(`    ${utilizationCell("5h", r.usage.five_hour.utilization, r.usage.five_hour.resets_at)}\n`);
    process.stdout.write(`    ${utilizationCell("7d", r.usage.seven_day.utilization, r.usage.seven_day.resets_at)}\n`);
    const hint = statusHint(r.usage);
    if (hint) process.stdout.write(`    ${hint}\n`);
    process.stdout.write("\n");
  });

  const active = accounts.find((a, i) => i === 0)?.name;
  const answer = await promptLine(`Pick account [1-${accounts.length}${active ? `, default: 1 (${active})` : ""}]: `);
  const trimmed = answer.trim();
  if (!trimmed) return accounts[0]!;
  const idx = Number(trimmed);
  if (!Number.isFinite(idx) || idx < 1 || idx > accounts.length) {
    // Also allow typing the name directly.
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
