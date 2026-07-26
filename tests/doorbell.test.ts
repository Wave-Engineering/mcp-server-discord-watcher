import { describe, test, expect } from "bun:test";
import { formatDoorbellLine, shouldDeliverMessage } from "../index";
import type { DiscordChannel, DiscordMessage, AgentIdentity } from "../index";

// --- doorbell stdout transport (#72) -----------------------------------------
//
// The `discord-watcher doorbell` subcommand emits one stdout line per
// deliverable message; Claude Code's Monitor turns each line into a session
// notification. Two invariants are load-bearing:
//   1. LINE CONTRACT — exactly one physical line per message (a newline in the
//      preview would split one doorbell into multiple Monitor events), carrying
//      the fields the agent needs to disc_read and respond, surrogate-safe.
//   2. STORM GUARD — a message is emitted ONLY if it passes shouldDeliverMessage.
//      Emitting unfiltered traffic would wake the model per-message (the
//      2026-06-20 fleet inference storm; lesson_discord_doorbell_inference_storm).

const channel = (overrides: Partial<DiscordChannel> = {}): DiscordChannel => ({
  id: "chan-123",
  name: "general",
  type: 0,
  ...overrides,
});

function makeMsg(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: "msg-1",
    author: { id: "user-1", username: "testuser" },
    content: "",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("formatDoorbellLine — line contract", () => {
  test("carries channel name, channel_id, msg_id, author, and preview", () => {
    const line = formatDoorbellLine(
      channel({ id: "c9", name: "call-4-bj" }),
      makeMsg({ id: "m42", author: { id: "u", username: "babelfish" }, content: "ping" })
    );
    expect(line).toContain("#call-4-bj");
    expect(line).toContain("channel_id=c9");
    expect(line).toContain("msg_id=m42");
    expect(line).toContain("babelfish");
    expect(line).toContain("ping");
  });

  test("is always a single physical line (newlines collapsed)", () => {
    const line = formatDoorbellLine(
      channel(),
      makeMsg({ content: "line1\nline2\r\nline3" })
    );
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\r");
    expect(line).toContain("line1 line2 line3");
  });

  test("clips a long preview to 100 chars with an ellipsis", () => {
    const long = "a".repeat(150);
    const line = formatDoorbellLine(channel(), makeMsg({ content: long }));
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toContain(long); // the full 150-char body is not present
  });

  test("does not clip a preview at exactly the 100-char boundary", () => {
    const exactly = "b".repeat(100);
    const line = formatDoorbellLine(channel(), makeMsg({ content: exactly }));
    expect(line).toContain(exactly);
    expect(line.endsWith("…")).toBe(false);
  });

  test("sanitizes lone surrogates in content and username", () => {
    const line = formatDoorbellLine(
      channel(),
      makeMsg({
        author: { id: "u", username: "bad\uD800name" },
        content: "hi\uDC00there",
      })
    );
    // A lone surrogate reaching the receiving agent's transcript would 400 its
    // next request — the same reason the MCP sink sanitizes (index.ts:1642).
    expect(line.includes("\uD800")).toBe(false);
    expect(line.includes("\uDC00")).toBe(false);
  });

  test("empty content still yields a valid single line", () => {
    const line = formatDoorbellLine(channel(), makeMsg({ content: "" }));
    expect(line).not.toContain("\n");
    expect(line).toContain("channel_id=chan-123");
  });

  test("sanitizes and single-lines the channel name too", () => {
    const line = formatDoorbellLine(
      channel({ name: "weird\nname\uD800" }),
      makeMsg({ content: "hi" })
    );
    expect(line).not.toContain("\n");
    expect(line.includes("\uD800")).toBe(false);
    expect(line).toContain("#weird name");
  });
});

describe("doorbell storm guard — emits only shouldDeliverMessage passers", () => {
  const identity = (overrides: Partial<AgentIdentity> = {}): AgentIdentity => ({
    devName: "polyjuice",
    devTeam: "oaw",
    ...overrides,
  });

  test("addressed message passes the gate (would be emitted)", () => {
    expect(shouldDeliverMessage(makeMsg({ content: "@polyjuice look" }), identity())).toBe(true);
  });

  test("unaddressed message fails the gate (never emitted → no per-message wake)", () => {
    expect(shouldDeliverMessage(makeMsg({ content: "just chatter" }), identity())).toBe(false);
  });

  test("unresolved identity fails closed (nothing emitted, agent MISSES not storms)", () => {
    const unresolved: AgentIdentity = { devName: null, devTeam: null };
    expect(shouldDeliverMessage(makeMsg({ content: "@polyjuice urgent" }), unresolved)).toBe(false);
  });
});
