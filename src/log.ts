import type { LogLevel } from "./types";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let current: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function ts(): string {
  return new Date().toISOString();
}

function fmt(level: LogLevel, msg: string, meta?: Record<string, unknown>): string {
  const base = `${ts()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (!meta || Object.keys(meta).length === 0) return base;
  const pairs = Object.entries(meta)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return `${base} ${pairs}`;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[current];
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => {
    if (shouldLog("debug")) console.log(fmt("debug", msg, meta));
  },
  info: (msg: string, meta?: Record<string, unknown>) => {
    if (shouldLog("info")) console.log(fmt("info", msg, meta));
  },
  warn: (msg: string, meta?: Record<string, unknown>) => {
    if (shouldLog("warn")) console.warn(fmt("warn", msg, meta));
  },
  error: (msg: string, meta?: Record<string, unknown>) => {
    if (shouldLog("error")) console.error(fmt("error", msg, meta));
  },
};
