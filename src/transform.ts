// Anthropic's OAuth (subscription) auth path only accepts requests whose system
// prompt identifies the caller as Claude Code. Without this prefix requests
// return 400 with `invalid_request_error`. We inject it if it's missing so
// arbitrary Anthropic-compatible clients (opencode etc.) work through the pool.
const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

type SystemBlock = { type: "text"; text: string; cache_control?: unknown };
type SystemField = string | SystemBlock[] | undefined;

function firstText(system: SystemField): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system) && system[0] && typeof system[0].text === "string") {
    return system[0].text;
  }
  return "";
}

function alreadyHasIdentity(system: SystemField): boolean {
  return firstText(system).trimStart().startsWith(CLAUDE_CODE_IDENTITY);
}

export function injectClaudeCodeIdentity(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const system = body.system as SystemField;
  if (alreadyHasIdentity(system)) return body;

  const identity: SystemBlock = { type: "text", text: CLAUDE_CODE_IDENTITY };

  if (system == null) {
    return { ...body, system: [identity] };
  }
  if (typeof system === "string") {
    return { ...body, system: [identity, { type: "text", text: system }] };
  }
  if (Array.isArray(system)) {
    return { ...body, system: [identity, ...system] };
  }
  return { ...body, system: [identity] };
}
