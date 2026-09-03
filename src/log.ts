import type { LogLevel } from "./types";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let current: LogLevel = "info";
let mode: "console" | "buffer" = "console";
let buffer: string[] = [];
let bufferCap = 100;

export function setLogLevel(level: LogLevel): void {
  current = level;
}

// When the TUI is active, redirect log output into a rolling buffer that the
// dashboard renders as a tail section. Prevents log lines from stomping on the
// alt-screen display.
export function setLogSink(next: "console" | "buffer", cap = 100): void {
  mode = next;
  bufferCap = cap;
  if (mode === "console") buffer = [];
}

export function drainRecentLogs(n: number): string[] {
  return buffer.slice(-n);
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

function emit(level: LogLevel, line: string): void {
  if (mode === "buffer") {
    buffer.push(line);
    if (buffer.length > bufferCap) buffer.splice(0, buffer.length - bufferCap);
    return;
  }
  if (level === "warn" || level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => {
    if (shouldLog("debug")) emit("debug", fmt("debug", msg, meta));
  },
  info: (msg: string, meta?: Record<string, unknown>) => {
    if (shouldLog("info")) emit("info", fmt("info", msg, meta));
  },
  warn: (msg: string, meta?: Record<string, unknown>) => {
    if (shouldLog("warn")) emit("warn", fmt("warn", msg, meta));
  },
  error: (msg: string, meta?: Record<string, unknown>) => {
    if (shouldLog("error")) emit("error", fmt("error", msg, meta));
  },
};
