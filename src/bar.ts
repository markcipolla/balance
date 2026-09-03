// Fractional-block bar chart. Renders `width` cells; each cell is 1/8th
// resolution using ▏▎▍▌▋▊▉█ so a 10-cell bar has ~80 gradations.

const BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

export function bar(used: number, total: number, width: number): string {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return "░".repeat(width);
  }
  const clamped = Math.max(0, Math.min(1, used / total));
  const cells = clamped * width;
  const full = Math.floor(cells);
  const remainder = Math.round((cells - full) * 8);
  let out = "█".repeat(full);
  if (full < width) {
    out += BLOCKS[remainder]!;
    out += "░".repeat(width - full - 1);
  }
  return out;
}

export function percent(used: number, total: number): string {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return "-";
  const pct = Math.round((used / total) * 100);
  return `${pct}%`;
}
