// Minimal ANSI helpers. Colors are auto-disabled when stdout isn't a TTY or
// NO_COLOR is set (per https://no-color.org/).

const enabled = (): boolean => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
};

const wrap = (code: string) => (s: string): string => (enabled() ? `\x1b[${code}m${s}\x1b[0m` : s);

export const green = wrap("32");
export const yellow = wrap("33");
export const red = wrap("31");
export const gray = wrap("90");
export const dim = wrap("2");
export const bold = wrap("1");

// Alternate screen buffer + cursor visibility helpers, so `top`-style refreshes
// don't scroll the user's real scrollback.
export function enterAltScreen(): void {
  if (!enabled()) return;
  process.stdout.write("\x1b[?1049h\x1b[?25l");
}

export function exitAltScreen(): void {
  if (!enabled()) return;
  process.stdout.write("\x1b[?25h\x1b[?1049l");
}

export function clearScreen(): void {
  if (!enabled()) {
    // Fall back to a divider so consecutive frames stay distinguishable when
    // piped somewhere without ANSI support.
    process.stdout.write("\n---\n");
    return;
  }
  process.stdout.write("\x1b[H\x1b[2J");
}

export function ttyWidth(fallback = 100): number {
  return process.stdout.columns ?? fallback;
}
