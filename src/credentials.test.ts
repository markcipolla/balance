import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshCredentials, writeCredentials, type ClaudeCredentials } from "./credentials";
import { setKeychainOwner } from "./keychain";
import { accountDir, baseDir } from "./paths";

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env.BALANCE_HOME;
  home = await mkdtemp(join(tmpdir(), "balance-creds-test-"));
  process.env.BALANCE_HOME = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.BALANCE_HOME;
  else process.env.BALANCE_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

const valid = (accessToken: string): ClaudeCredentials => ({
  claudeAiOauth: { accessToken, refreshToken: "r", expiresAt: Date.now() + 60 * 60 * 1000, scopes: ["user:inference"] },
});

describe("freshCredentials", () => {
  test("returns null for an account with no credentials", async () => {
    expect(await freshCredentials(accountDir("nobody"))).toBeNull();
  });

  test("returns a live token as-is, without refreshing it", async () => {
    const dir = accountDir("live");
    await writeCredentials(dir, valid("live-token"));
    expect((await freshCredentials(dir))?.claudeAiOauth.accessToken).toBe("live-token");
  });

  // The Keychain holds one login per Mac user. Adopting it blindly would sign
  // an account in as whichever account balance launched last.
  test("ignores the Keychain when it belongs to another account", async () => {
    const dir = accountDir("mine");
    await writeCredentials(dir, valid("mine-token"));
    await setKeychainOwner(accountDir("theirs"));
    expect((await freshCredentials(dir))?.claudeAiOauth.accessToken).toBe("mine-token");
  });

  test("records the owner under BALANCE_HOME", async () => {
    await setKeychainOwner(accountDir("mine"));
    expect(await Bun.file(join(baseDir(), "keychain-owner")).text()).toBe(accountDir("mine") + "\n");
  });
});
