// Small formatters shared by CLI output.

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  const abs = Math.abs(ms);
  const sign = ms < 0 ? "-" : "";
  const s = Math.round(abs / 1000);
  if (s < 60) return `${sign}${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${sign}${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${sign}${h}h`;
  const d = Math.round(h / 24);
  return `${sign}${d}d`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null) return "-";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

// Render an array of rows as a padded table with a header row.
// Values are printed left-aligned; the last column isn't padded so it can wrap
// or contain trailing detail without spurious spaces.
export function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const format = (row: string[]) =>
    row
      .map((v, i) => (i === row.length - 1 ? v : v.padEnd(widths[i]!)))
      .join("  ");
  const out: string[] = [];
  out.push(format(header));
  out.push(format(widths.map((w) => "-".repeat(w))));
  for (const r of rows) out.push(format(r));
  return out.join("\n");
}
