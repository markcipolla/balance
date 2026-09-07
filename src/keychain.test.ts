import { describe, expect, test } from "bun:test";
import { mergeKeychainBlob } from "./keychain";
import type { ClaudeCredentials } from "./credentials";

const creds: ClaudeCredentials = {
  claudeAiOauth: { accessToken: "new", refreshToken: "new-r", expiresAt: 2, scopes: ["user:inference"] },
};

describe("mergeKeychainBlob", () => {
  test("replaces the Anthropic OAuth token", () => {
    const merged = mergeKeychainBlob({ claudeAiOauth: { accessToken: "old" } }, creds);
    expect((merged.claudeAiOauth as { accessToken: string }).accessToken).toBe("new");
  });

  // The whole point: this slot is Claude Code's entire credential store on
  // macOS, so MCP server logins live here too. Writing only our own key would
  // sign the user out of every MCP server on every launch.
  test("keeps MCP server logins that are stored alongside it", () => {
    const merged = mergeKeychainBlob(
      { claudeAiOauth: { accessToken: "old" }, mcpOAuth: { "linear:https://mcp.linear.app": { accessToken: "mcp" } } },
      creds,
    );
    expect(merged.mcpOAuth).toEqual({ "linear:https://mcp.linear.app": { accessToken: "mcp" } });
  });

  test("keeps any other key it does not recognise", () => {
    const merged = mergeKeychainBlob({ somethingNew: { a: 1 } }, creds);
    expect(merged.somethingNew).toEqual({ a: 1 });
  });

  test("works from an empty slot", () => {
    expect(Object.keys(mergeKeychainBlob(null, creds))).toEqual(["claudeAiOauth"]);
  });

  test("does not mutate the blob it was handed", () => {
    const existing = { claudeAiOauth: { accessToken: "old" } };
    mergeKeychainBlob(existing, creds);
    expect(existing.claudeAiOauth.accessToken).toBe("old");
  });
});
