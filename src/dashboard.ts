import type { AccountPool } from "./pool";
import type { Config } from "./types";
import { bar, percent } from "./bar";
import { formatCount, formatDuration } from "./format";
import { drainRecentLogs } from "./log";
import {
  bold,
  clearScreen,
  dim,
  enterAltScreen,
  exitAltScreen,
  gray,
  green,
  red,
  ttyWidth,
  yellow,
} from "./tty";

const REFRESH_MS = 400;
const BAR_WIDTH = 14;
const LOG_TAIL = 8;

interface UnifiedWindow {
  utilization: number | null;
  reset_at: number | null;
  status: string | null;
}

interface AccountSnapshot {
  name: string;
  kind: string;
  available: boolean;
  in_flight: number;
  total_requests: number;
  cooldown_ms: number;
  ratelimit: {
    requests_remaining: number | null;
    requests_limit: number | null;
    tokens_remaining: number | null;
    tokens_limit: number | null;
    last_error: string | null;
    unified: {
      status: string | null;
      five_hour: UnifiedWindow;
      seven_day: UnifiedWindow;
      seven_day_opus: UnifiedWindow;
    };
  };
}

interface RenderRow {
  dot: string;
  name: string;
  kind: string;
  leftBar: string;      // "5h" for subs, "req" for keys
  leftText: string;
  rightBar: string;     // "7d" for subs, "tok" for keys
  rightText: string;
  status: string;
  used: string;
}

function pickDot(snap: {
  available: boolean;
  in_flight: number;
  ratelimit: { last_error: string | null; requests_remaining: number | null };
}): string {
  if (snap.in_flight > 0) return green("●");
  if (!snap.available) return yellow("●");
  if (snap.ratelimit.last_error) return yellow("●");
  return gray("○");
}

function statusText(snap: {
  available: boolean;
  in_flight: number;
  cooldown_ms: number;
  ratelimit: { last_error: string | null };
}): string {
  if (snap.in_flight > 0) return green(`serving (${snap.in_flight})`);
  if (!snap.available) {
    const reason = snap.ratelimit.last_error ?? "cooldown";
    return yellow(`${reason} · ${formatDuration(snap.cooldown_ms)}`);
  }
  return gray("idle");
}

function usedFromLimit(remaining: number | null, limit: number | null): number | null {
  if (remaining == null || limit == null) return null;
  return Math.max(0, limit - remaining);
}

function renderBar(remaining: number | null, limit: number | null): { chart: string; label: string } {
  const used = usedFromLimit(remaining, limit);
  if (used == null || !limit) {
    return { chart: dim("░".repeat(BAR_WIDTH)), label: dim(remaining == null ? "-" : `${formatCount(remaining)} left`) };
  }
  const chart = bar(used, limit, BAR_WIDTH);
  const pct = used / limit;
  const colored = pct >= 0.9 ? red(chart) : pct >= 0.7 ? yellow(chart) : green(chart);
  return {
    chart: colored,
    label: `${percent(used, limit)} (${formatCount(remaining!)} left)`,
  };
}

// Subscription bar: driven by the unified 5h/7d utilization (0..1). No
// meaningful "remaining count" for subs — Anthropic doesn't send one — so the
// label is percent + time to reset.
function renderUnifiedBar(w: UnifiedWindow, now: number): { chart: string; label: string } {
  if (w.utilization == null) {
    return { chart: dim("░".repeat(BAR_WIDTH)), label: dim("no data yet") };
  }
  const chart = bar(w.utilization, 1, BAR_WIDTH);
  const colored = w.utilization >= 0.9 ? red(chart) : w.utilization >= 0.7 ? yellow(chart) : green(chart);
  const pct = `${Math.round(w.utilization * 100)}%`;
  const resetIn = w.reset_at ? ` (${formatDuration(w.reset_at - now)})` : "";
  return { chart: colored, label: `${pct}${resetIn}` };
}

function buildRows(pool: AccountPool, now: number): RenderRow[] {
  return pool.all().map((account) => {
    const s = account.snapshot() as unknown as AccountSnapshot;
    if (s.kind === "subscription") {
      const fiveH = renderUnifiedBar(s.ratelimit.unified.five_hour, now);
      const week = renderUnifiedBar(s.ratelimit.unified.seven_day, now);
      return {
        dot: pickDot(s),
        name: s.name,
        kind: "sub",
        leftBar: fiveH.chart,
        leftText: fiveH.label,
        rightBar: week.chart,
        rightText: week.label,
        status: statusText(s),
        used: String(s.total_requests),
      };
    }
    const req = renderBar(s.ratelimit.requests_remaining, s.ratelimit.requests_limit);
    const tok = renderBar(s.ratelimit.tokens_remaining, s.ratelimit.tokens_limit);
    return {
      dot: pickDot(s),
      name: s.name,
      kind: "key",
      leftBar: req.chart,
      leftText: req.label,
      rightBar: tok.chart,
      rightText: tok.label,
      status: statusText(s),
      used: String(s.total_requests),
    };
  });
}

// Column widths sized to the widest cell so bars align across rows.
function padRight(s: string, width: number): string {
  // s may contain ANSI codes — strip for width calc but pad the raw string.
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  const padding = Math.max(0, width - visible.length);
  return s + " ".repeat(padding);
}

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function renderFrame(pool: AccountPool, cfg: Config, startedAt: number): string {
  const now = Date.now();
  const rows = buildRows(pool, now);
  const width = ttyWidth();
  const uptime = formatDuration(now - startedAt);
  const anySubs = pool.all().some((a) => a.snapshot().kind === "subscription");
  const anyKeys = pool.all().some((a) => a.snapshot().kind === "api_key");

  const header = [
    bold("balance"),
    dim(`http://${cfg.host}:${cfg.port}`),
    dim(`up ${uptime}`),
    dim(`${pool.size()} account${pool.size() === 1 ? "" : "s"}`),
    dim(`refresh ${REFRESH_MS}ms`),
    dim("(Ctrl-C to quit)"),
  ].join("  ");

  const lines: string[] = [];
  lines.push(header);
  lines.push(dim("─".repeat(Math.min(width, 100))));
  lines.push("");

  if (rows.length === 0) {
    lines.push(dim("no accounts. add one with: balance claude subscription add"));
  } else {
    const nameW = Math.max(4, ...rows.map((r) => r.name.length));
    const kindW = Math.max(4, ...rows.map((r) => r.kind.length));
    const leftTextW = Math.max(8, ...rows.map((r) => visibleLen(r.leftText)));
    const rightTextW = Math.max(8, ...rows.map((r) => visibleLen(r.rightText)));
    const statusW = Math.max(6, ...rows.map((r) => visibleLen(r.status)));

    // Column header — pick labels that fit whichever account types are in the
    // pool. Mixed pool gets subscription-style labels since those matter more.
    const leftLabel = anySubs ? "5H WINDOW" : "REQUESTS";
    const rightLabel = anySubs ? (anyKeys ? "7D WINDOW / TOKENS" : "7D WINDOW") : "TOKENS";
    const colHead = "  " + dim(padRight("NAME", nameW))
      + "  " + dim(padRight("KIND", kindW))
      + "  " + dim(padRight(leftLabel, BAR_WIDTH + 2 + leftTextW))
      + "  " + dim(padRight(rightLabel, BAR_WIDTH + 2 + rightTextW))
      + "  " + dim(padRight("STATUS", statusW))
      + "  " + dim("USED");
    lines.push(colHead);

    for (const r of rows) {
      lines.push(
        `${r.dot} ${padRight(r.name, nameW)}  ${dim(padRight(r.kind, kindW))}  `
          + `${r.leftBar} ${padRight(r.leftText, leftTextW)}  `
          + `${r.rightBar} ${padRight(r.rightText, rightTextW)}  `
          + `${padRight(r.status, statusW)}  `
          + `${dim(r.used)}`,
      );
    }
  }

  lines.push("");
  lines.push(dim("─".repeat(Math.min(width, 100))));
  lines.push(dim("logs (last " + LOG_TAIL + "):"));
  const tail = drainRecentLogs(LOG_TAIL);
  if (tail.length === 0) {
    lines.push(dim("  (waiting for requests…)"));
  } else {
    for (const l of tail) lines.push("  " + dim(l));
  }

  return lines.join("\n");
}

export interface DashboardHandle {
  stop: () => void;
}

export function startDashboard(pool: AccountPool, cfg: Config): DashboardHandle {
  enterAltScreen();
  const startedAt = Date.now();
  let stopped = false;

  const draw = () => {
    if (stopped) return;
    clearScreen();
    process.stdout.write(renderFrame(pool, cfg, startedAt));
  };

  draw();
  const timer = setInterval(draw, REFRESH_MS);
  const onResize = () => draw();
  process.stdout.on("resize", onResize);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.stdout.off("resize", onResize);
      exitAltScreen();
    },
  };
}

// True when stdout looks like a real terminal — the dashboard requires this
// to render ANSI colors, redraw in place, and respect the terminal size.
export function shouldUseDashboard(): boolean {
  if (process.env.BALANCE_NO_TUI) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}
