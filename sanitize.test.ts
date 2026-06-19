import { describe, test, expect } from "bun:test";
import { sanitizeSurrogates } from "./sanitize.ts";

const FFFD = "�";

describe("sanitizeSurrogates (watcher)", () => {
  test("plain text unchanged", () => {
    expect(sanitizeSurrogates("hi there")).toBe("hi there");
  });
  test("preserves a valid surrogate pair (emoji)", () => {
    expect(sanitizeSurrogates("a 🐟 b")).toBe("a 🐟 b");
  });
  test("lone high surrogate → U+FFFD", () => {
    expect(sanitizeSurrogates("a\uD800b")).toBe(`a${FFFD}b`);
  });
  test("lone low surrogate → U+FFFD", () => {
    expect(sanitizeSurrogates("a\uDC00b")).toBe(`a${FFFD}b`);
  });
  test("lone surrogate at end of string", () => {
    expect(sanitizeSurrogates("end\uD83D")).toBe(`end${FFFD}`);
  });
  test("sanitized output is JSON-serializable", () => {
    expect(() => JSON.stringify({ c: sanitizeSurrogates("x \uD800 y") })).not.toThrow();
  });
});
