// Anthropic's subscription-routing gate reads two things from the system prompt
// of an OAuth request:
//   1. An `x-anthropic-billing-header:` text block as the first system entry —
//      identifies the caller for billing (cc_version + cc_entrypoint). Without
//      it the request bills as extra-usage / API-tier even if the OAuth token
//      is valid.
//   2. The "You are Claude Code…" identity line — Anthropic returns 400 without
//      it when using OAuth Bearer.
// balance injects both non-destructively — if a downstream client (Claude Code
// itself) already sent them, we leave them alone.
const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const BILLING_PREFIX = "x-anthropic-billing-header:";

type SystemBlock = { type: "text"; text: string; cache_control?: unknown };
type SystemField = string | SystemBlock[] | undefined;

function blockText(b: unknown): string {
  if (typeof b === "object" && b !== null && typeof (b as { text?: unknown }).text === "string") {
    return (b as { text: string }).text;
  }
  return "";
}

function hasBillingHeader(system: SystemField): boolean {
  if (typeof system === "string") return system.startsWith(BILLING_PREFIX);
  if (!Array.isArray(system) || system.length === 0) return false;
  return blockText(system[0]).startsWith(BILLING_PREFIX);
}

function hasIdentity(system: SystemField): boolean {
  if (typeof system === "string") return system.trimStart().startsWith(CLAUDE_CODE_IDENTITY);
  if (!Array.isArray(system)) return false;
  // Identity is expected at index 0 (no billing header) or index 1 (billing
  // header present). Anywhere further and Anthropic doesn't accept it.
  return system.slice(0, 2).some((b) => blockText(b).trimStart().startsWith(CLAUDE_CODE_IDENTITY));
}

function billingBlock(version: string): SystemBlock {
  return { type: "text", text: `${BILLING_PREFIX} cc_version=${version}; cc_entrypoint=cli;` };
}

const IDENTITY_BLOCK: SystemBlock = { type: "text", text: CLAUDE_CODE_IDENTITY };

export function injectClaudeCodeIdentity(
  body: Record<string, unknown>,
  version: string,
): Record<string, unknown> {
  const system = body.system as SystemField;
  const needBilling = !hasBillingHeader(system);
  const needIdentity = !hasIdentity(system);
  if (!needBilling && !needIdentity) return body;

  const prepend: SystemBlock[] = [];
  if (needBilling) prepend.push(billingBlock(version));
  if (needIdentity) prepend.push(IDENTITY_BLOCK);

  if (system == null) return { ...body, system: prepend };
  if (typeof system === "string") return { ...body, system: [...prepend, { type: "text", text: system }] };
  if (Array.isArray(system)) return { ...body, system: [...prepend, ...system] };
  return { ...body, system: prepend };
}
