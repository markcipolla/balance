import { describe, expect, test } from "bun:test";
import { flag, passThroughArgs, positional } from "./cli";

describe("passThroughArgs", () => {
  test("forwards everything after the separator", () => {
    expect(passThroughArgs(["work", "--", "--model", "opus", "--print", "hello"])).toEqual([
      "--model",
      "opus",
      "--print",
      "hello",
    ]);
  });

  test("forwards nothing when there is no separator", () => {
    expect(passThroughArgs(["work"])).toEqual([]);
  });
});

describe("positional", () => {
  test("skips a flag's value but keeps the account name", () => {
    expect(positional(["--config", "/tmp/c.json", "work"])).toEqual(["work"]);
  });

  // Boolean flags take no value — treating them as if they did would eat the
  // account name that follows.
  test("does not swallow the name after a boolean flag", () => {
    expect(positional(["--no-shared", "work"])).toEqual(["work"]);
    expect(positional(["--no-browser", "work"])).toEqual(["work"]);
    expect(positional(["--usage", "work"])).toEqual(["work"]);
  });

  test("treats everything after -- as positional", () => {
    expect(positional(["work", "--", "--model", "opus"])).toEqual(["work", "--model", "opus"]);
  });
});

describe("flag", () => {
  test("reads the value after a named flag", () => {
    expect(flag(["--name", "work"], "--name")).toBe("work");
  });

  test("is undefined when absent", () => {
    expect(flag(["--name", "work"], "--config")).toBeUndefined();
  });
});
