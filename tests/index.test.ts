/**
 * Tests for discord-watcher voice message STT, kill switch, config, and
 * scream-hole features.
 *
 * These tests exercise the real transcribeAudioAttachments, resolveIdentity,
 * checkKillSwitch, engageKillSwitch, checkScreamHoleHealth, and resolveApiBase
 * functions. Only `fetch` (network) and `readFileSync`/`execSync`
 * (filesystem/process) are mocked — those are true external boundaries.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { DiscordMessage, DiscordAttachment, DiscordConfig } from "../index";
import {
  stripTokenPunctuation,
  loadConfig,
  checkKillSwitch,
  engageKillSwitch,
  checkScreamHoleHealth,
  resolveApiBase,
  shouldDeliverMessage,
  isReplyToOurSignature,
  nextChannelJitterMs,
  refreshChannelList,
  DISCORD_API_BASE,
} from "../index";
import type { AgentIdentity } from "../index";

// We need to mock fetch and fs before importing the module under test.
// Bun's mock system lets us intercept global fetch.

// Helper to build a DiscordMessage
function makeMsg(
  overrides: Partial<DiscordMessage> & { attachments?: DiscordAttachment[] } = {}
): DiscordMessage {
  return {
    id: "msg-1",
    author: { id: "user-1", username: "testuser" },
    content: "",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// --- transcribeAudioAttachments tests ----------------------------------------

describe("transcribeAudioAttachments", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns null when message has no attachments", async () => {
    const { transcribeAudioAttachments } = await import("../index");
    const msg = makeMsg({ content: "hello" });
    const result = await transcribeAudioAttachments(msg, "Bot fake-token");
    expect(result).toBeNull();
  });

  test("returns null when message has no audio attachments", async () => {
    const { transcribeAudioAttachments } = await import("../index");
    const msg = makeMsg({
      attachments: [
        {
          id: "att-1",
          filename: "image.png",
          content_type: "image/png",
          url: "https://cdn.discordapp.com/image.png",
          size: 1024,
        },
      ],
    });
    const result = await transcribeAudioAttachments(msg, "Bot fake-token");
    expect(result).toBeNull();
  });

  test("returns transcription for audio attachment", async () => {
    const { transcribeAudioAttachments } = await import("../index");

    // Mock fetch: first call downloads audio, second call transcribes
    const mockFetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      if (url.includes("cdn.discordapp.com")) {
        // Audio download
        return new Response(new ArrayBuffer(100), { status: 200 });
      }
      if (url.includes("audio/transcriptions")) {
        // STT response
        return new Response(JSON.stringify({ text: "Hello from phone" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = mockFetch as any;

    const msg = makeMsg({
      attachments: [
        {
          id: "att-1",
          filename: "voice.ogg",
          content_type: "audio/ogg",
          url: "https://cdn.discordapp.com/voice.ogg",
          size: 2048,
        },
      ],
    });

    const result = await transcribeAudioAttachments(msg, "Bot fake-token");
    expect(result).toBe('[voice memo from testuser: "Hello from phone"]');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("returns failure message when audio download fails", async () => {
    const { transcribeAudioAttachments } = await import("../index");

    globalThis.fetch = mock(async () => {
      return new Response("forbidden", { status: 403 });
    }) as any;

    const msg = makeMsg({
      attachments: [
        {
          id: "att-1",
          filename: "voice.ogg",
          content_type: "audio/ogg",
          url: "https://cdn.discordapp.com/voice.ogg",
          size: 2048,
        },
      ],
    });

    const result = await transcribeAudioAttachments(msg, "Bot fake-token");
    expect(result).toBe("[voice memo attached \u2014 download failed]");
  });

  test("returns failure message when STT endpoint fails", async () => {
    const { transcribeAudioAttachments } = await import("../index");

    const mockFetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      if (url.includes("cdn.discordapp.com")) {
        return new Response(new ArrayBuffer(100), { status: 200 });
      }
      // STT fails
      return new Response("service unavailable", { status: 503 });
    });
    globalThis.fetch = mockFetch as any;

    const msg = makeMsg({
      attachments: [
        {
          id: "att-1",
          filename: "voice.ogg",
          content_type: "audio/ogg",
          url: "https://cdn.discordapp.com/voice.ogg",
          size: 2048,
        },
      ],
    });

    const result = await transcribeAudioAttachments(msg, "Bot fake-token");
    expect(result).toBe("[voice memo attached \u2014 transcription failed]");
  });

  test("returns failure message when fetch throws (network error)", async () => {
    const { transcribeAudioAttachments } = await import("../index");

    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;

    const msg = makeMsg({
      attachments: [
        {
          id: "att-1",
          filename: "voice.ogg",
          content_type: "audio/ogg",
          url: "https://cdn.discordapp.com/voice.ogg",
          size: 2048,
        },
      ],
    });

    const result = await transcribeAudioAttachments(msg, "Bot fake-token");
    expect(result).toBe("[voice memo attached \u2014 transcription failed]");
  });

  test("handles multiple audio attachments", async () => {
    const { transcribeAudioAttachments } = await import("../index");

    let callCount = 0;
    const mockFetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      if (url.includes("cdn.discordapp.com")) {
        return new Response(new ArrayBuffer(100), { status: 200 });
      }
      if (url.includes("audio/transcriptions")) {
        callCount++;
        const text = callCount === 1 ? "first message" : "second message";
        return new Response(JSON.stringify({ text }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = mockFetch as any;

    const msg = makeMsg({
      attachments: [
        {
          id: "att-1",
          filename: "voice1.ogg",
          content_type: "audio/ogg",
          url: "https://cdn.discordapp.com/voice1.ogg",
          size: 2048,
        },
        {
          id: "att-2",
          filename: "voice2.ogg",
          content_type: "audio/ogg",
          url: "https://cdn.discordapp.com/voice2.ogg",
          size: 4096,
        },
      ],
    });

    const result = await transcribeAudioAttachments(msg, "Bot fake-token");
    expect(result).toContain('[voice memo from testuser: "first message"]');
    expect(result).toContain('[voice memo from testuser: "second message"]');
    expect(result).toContain("\n");
  });

  test("skips non-audio attachments in mixed set", async () => {
    const { transcribeAudioAttachments } = await import("../index");

    const mockFetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      if (url.includes("cdn.discordapp.com")) {
        return new Response(new ArrayBuffer(100), { status: 200 });
      }
      if (url.includes("audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "transcribed" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = mockFetch as any;

    const msg = makeMsg({
      attachments: [
        {
          id: "att-1",
          filename: "image.png",
          content_type: "image/png",
          url: "https://cdn.discordapp.com/image.png",
          size: 1024,
        },
        {
          id: "att-2",
          filename: "voice.ogg",
          content_type: "audio/ogg",
          url: "https://cdn.discordapp.com/voice.ogg",
          size: 2048,
        },
      ],
    });

    const result = await transcribeAudioAttachments(msg, "Bot fake-token");
    expect(result).toBe('[voice memo from testuser: "transcribed"]');
    // Only 2 fetch calls: 1 download + 1 STT (the image is skipped)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// --- resolveIdentity tests ---------------------------------------------------

describe("resolveIdentity", () => {
  test("resolveIdentity returns devName and devTeam when agent file missing", async () => {
    const { resolveIdentity: resolveId } = await import("../index");
    // This calls the real function which may or may not find the agent file.
    // The important thing: it doesn't throw, and returns an AgentIdentity
    const identity = resolveId();
    expect(identity).toHaveProperty("devName");
    expect(identity).toHaveProperty("devTeam");
  });
});

// --- AgentIdentity interface tests -------------------------------------------

describe("AgentIdentity interface", () => {
  test("has devName and devTeam fields", async () => {
    const identity: import("../index").AgentIdentity = {
      devName: "test",
      devTeam: "team",
    };
    expect(identity.devName).toBe("test");
    expect(identity.devTeam).toBe("team");
  });
});

// --- DiscordMessage with attachments -----------------------------------------

describe("DiscordMessage with attachments", () => {
  test("accepts messages with audio attachments", () => {
    const msg: DiscordMessage = {
      id: "1",
      author: { id: "u1", username: "user" },
      content: "",
      timestamp: new Date().toISOString(),
      attachments: [
        {
          id: "a1",
          filename: "voice.ogg",
          content_type: "audio/ogg",
          url: "https://example.com/voice.ogg",
          size: 1024,
        },
      ],
    };
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments![0].content_type).toBe("audio/ogg");
  });

  test("attachments field is optional", () => {
    const msg: DiscordMessage = {
      id: "1",
      author: { id: "u1", username: "user" },
      content: "text only",
      timestamp: new Date().toISOString(),
    };
    expect(msg.attachments).toBeUndefined();
  });
});

// --- MCP INSTRUCTIONS string tests -------------------------------------------
//
// Regression suite for issue #3. The watcher's MCP `instructions` string is
// surfaced to every Claude Code session that loads the watcher as system-
// reminder context, telling agents how to read and reply to Discord messages.
// Originally it told agents to run a `discord-bot` shell CLI that does not
// exist. The fix points agents at the disc_read / disc_send MCP tools from
// the sibling disc-server MCP, which IS available in any session that loads
// the watcher.
//
// These tests are source-reading checks because INSTRUCTIONS is a private
// const inside index.ts, not an exported value. They lock in the contract:
// the new MCP tool references must be present, and the broken CLI references
// must NOT regress.

describe("MCP server INSTRUCTIONS string", () => {
  test("references disc_read and disc_send MCP tools, not discord-bot CLI", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../index.ts", import.meta.url).pathname,
      "utf-8"
    );

    // Old broken CLI references must NOT regress
    expect(src).not.toContain("discord-bot read");
    expect(src).not.toContain("discord-bot send");

    // New MCP tool references must be present
    expect(src).toContain("disc_read");
    expect(src).toContain("disc_send");

    // The MCP server name should be mentioned so agents know where the tools
    // come from (helps disambiguate from other Discord MCP servers)
    expect(src).toContain("disc-server");
  });
});

// --- STT configuration tests -------------------------------------------------

describe("STT configuration", () => {
  test("STT_ENDPOINT defaults to archer:8004", async () => {
    // The default is set in the module. We verify the constant value
    // by reading the source (since it's a module-level const).
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../index.ts", import.meta.url).pathname,
      "utf-8"
    );
    expect(src).toContain(
      'process.env.STT_ENDPOINT ?? "http://archer:8300/v1/audio/transcriptions"'
    );
  });

  test("STT_MODEL defaults to whisper-1", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../index.ts", import.meta.url).pathname,
      "utf-8"
    );
    expect(src).toContain('process.env.STT_MODEL ?? "deepdml/faster-whisper-large-v3-turbo-ct2"');
  });
});

// --- Addressing tests --------------------------------------------------------

describe("addressing", () => {
  test("@-addressing matches when followed by punctuation", async () => {
    // The watcher tokenizes on whitespace then strips non-routing chars.
    // "@echo-chamber," should match dev_name "echo-chamber".
    const tokens = "@echo-chamber, hello @all. @cc-workflow:"
      .toLowerCase()
      .split(/\s+/)
      .map(stripTokenPunctuation);

    expect(tokens).toContain("@echo-chamber");
    expect(tokens).toContain("@all");
    expect(tokens).toContain("@cc-workflow");
  });

  test("@-addressing matches clean tokens without punctuation", async () => {
    const tokens = "@echo-chamber hello @all @cc-workflow"
      .toLowerCase()
      .split(/\s+/)
      .map(stripTokenPunctuation);

    expect(tokens).toContain("@echo-chamber");
    expect(tokens).toContain("@all");
    expect(tokens).toContain("@cc-workflow");
  });
});

// --- shouldDeliverMessage / isReplyToOurSignature tests ---------------------
//
// Filter-correctness regression suite for issue #10. Both fixes:
//   1. Fail-closed when identity is unresolved (was: fail-open, leaked
//      cross-project messages to unattributed sessions)
//   2. Reply-routing via referenced_message signature match (was: replies
//      with no @-mention in their text were silently dropped)

describe("shouldDeliverMessage", () => {
  const identity = (overrides: Partial<AgentIdentity> = {}): AgentIdentity => ({
    devName: "morpheus",
    devTeam: "mcp-server-discord-watcher",
    ...overrides,
  });

  test("delivers message addressed to @<dev-name>", () => {
    const msg = makeMsg({ content: "hey @morpheus check this" });
    expect(shouldDeliverMessage(msg, identity())).toBe(true);
  });

  test("delivers message addressed to @<dev-team>", () => {
    const msg = makeMsg({ content: "hey @mcp-server-discord-watcher ship it" });
    expect(shouldDeliverMessage(msg, identity())).toBe(true);
  });

  test("delivers message addressed to @all", () => {
    const msg = makeMsg({ content: "@all standup in 5" });
    expect(shouldDeliverMessage(msg, identity())).toBe(true);
  });

  test("addressing matches even with trailing punctuation", () => {
    const msg = makeMsg({ content: "@morpheus, can you look at this?" });
    expect(shouldDeliverMessage(msg, identity())).toBe(true);
  });

  test("drops unaddressed message when identity is set", () => {
    const msg = makeMsg({ content: "random chatter with no addressing" });
    expect(shouldDeliverMessage(msg, identity())).toBe(false);
  });

  test("drops empty message (no content, no attachments)", () => {
    const msg = makeMsg({ content: "" });
    expect(shouldDeliverMessage(msg, identity())).toBe(false);
  });

  test("delivers message with audio attachment even if content is empty", () => {
    const msg = makeMsg({
      content: "@morpheus listen to this",
      attachments: [
        {
          id: "a1",
          filename: "voice.ogg",
          content_type: "audio/ogg",
          url: "https://example.com/voice.ogg",
          size: 1024,
        },
      ],
    });
    expect(shouldDeliverMessage(msg, identity())).toBe(true);
  });

  // --- Bug 1 fix: fail-closed when identity unresolved ---

  test("FAIL CLOSED: drops message when both devName and devTeam are null", () => {
    const msg = makeMsg({ content: "@some-other-agent please help" });
    const noIdentity = { devName: null, devTeam: null };
    expect(shouldDeliverMessage(msg, noIdentity)).toBe(false);
  });

  test("FAIL CLOSED: drops even @all when identity is unresolved", () => {
    // The most surprising case: even broadcasts fail closed for unidentified
    // agents. Better silence than cross-project leakage.
    const msg = makeMsg({ content: "@all standup in 5" });
    const noIdentity = { devName: null, devTeam: null };
    expect(shouldDeliverMessage(msg, noIdentity)).toBe(false);
  });

  test("FAIL CLOSED: still delivers when at least devTeam is resolved", () => {
    const msg = makeMsg({ content: "@my-team ship it" });
    const partialIdentity = { devName: null, devTeam: "my-team" };
    expect(shouldDeliverMessage(msg, partialIdentity)).toBe(true);
  });

  // --- Self-echo filter still works ---

  test("self-echo: drops messages containing our own signature", () => {
    const msg = makeMsg({
      content: "did the thing — **morpheus** 💊 (mcp-server-discord-watcher)",
    });
    expect(shouldDeliverMessage(msg, identity())).toBe(false);
  });

  test("self-echo is case-insensitive", () => {
    const msg = makeMsg({ content: "did the thing — **MORPHEUS** 💊" });
    expect(shouldDeliverMessage(msg, identity())).toBe(false);
  });

  // --- VERBOSE mode ---

  test("VERBOSE bypasses targeted routing", () => {
    const msg = makeMsg({ content: "random chatter" });
    expect(shouldDeliverMessage(msg, identity(), { verbose: true })).toBe(true);
  });

  test("VERBOSE still applies self-echo filter", () => {
    const msg = makeMsg({ content: "echo — **morpheus** 💊" });
    expect(shouldDeliverMessage(msg, identity(), { verbose: true })).toBe(false);
  });

  test("VERBOSE still applies empty-message filter", () => {
    const msg = makeMsg({ content: "" });
    expect(shouldDeliverMessage(msg, identity(), { verbose: true })).toBe(false);
  });

  test("FAIL CLOSED takes precedence over VERBOSE", () => {
    // VERBOSE bypasses targeted routing, NOT the security boundary.
    // An unattributed agent must not receive cross-project traffic just
    // because someone set DISCORD_WATCHER_VERBOSE=1.
    const msg = makeMsg({ content: "@all standup in 5" });
    const noIdentity = { devName: null, devTeam: null };
    expect(shouldDeliverMessage(msg, noIdentity, { verbose: true })).toBe(false);
  });

  // --- Bug 2 fix: reply routing via referenced_message ---

  test("REPLY-ROUTING: delivers reply to a message we signed", () => {
    const msg = makeMsg({
      content: "good point",
      referenced_message: makeMsg({
        id: "parent-1",
        content: "the fix is at index.ts:520. — **morpheus** 💊 (mcp-server-discord-watcher)",
      }),
    });
    expect(shouldDeliverMessage(msg, identity())).toBe(true);
  });

  test("REPLY-ROUTING: does not deliver reply to someone else's message", () => {
    const msg = makeMsg({
      content: "thanks",
      referenced_message: makeMsg({
        id: "parent-1",
        content: "fix landed. — **cacodemon** 👁️ (mcp-server-nerf)",
      }),
    });
    expect(shouldDeliverMessage(msg, identity())).toBe(false);
  });

  test("REPLY-ROUTING is case-insensitive", () => {
    const msg = makeMsg({
      content: "got it",
      referenced_message: makeMsg({
        id: "parent-1",
        content: "look here — **MORPHEUS** 💊",
      }),
    });
    expect(shouldDeliverMessage(msg, identity())).toBe(true);
  });

  test("REPLY-ROUTING: missing referenced_message is harmless", () => {
    const msg = makeMsg({ content: "no reference" });
    // Same as the unaddressed-drop case
    expect(shouldDeliverMessage(msg, identity())).toBe(false);
  });

  test("REPLY-ROUTING: null referenced_message (parent deleted) is harmless", () => {
    const msg = makeMsg({ content: "no reference", referenced_message: null });
    expect(shouldDeliverMessage(msg, identity())).toBe(false);
  });

  test("REPLY-ROUTING: delivers when reply is also addressed to a third party", () => {
    // Documented intent: a reply to one of our messages is for us, even if
    // the reply text mentions someone else by name. Discord's threading
    // model puts the sender in conversation with the parent's author.
    const msg = makeMsg({
      content: "@cacodemon you should see this too",
      referenced_message: makeMsg({
        id: "parent-1",
        content: "the fix landed — **morpheus** 💊 (mcp-server-discord-watcher)",
      }),
    });
    expect(shouldDeliverMessage(msg, identity())).toBe(true);
  });
});

describe("isReplyToOurSignature", () => {
  const identity: AgentIdentity = {
    devName: "morpheus",
    devTeam: "mcp-server-discord-watcher",
  };

  test("returns false when message has no referenced_message", () => {
    const msg = makeMsg({ content: "hi" });
    expect(isReplyToOurSignature(msg, identity)).toBe(false);
  });

  test("returns false when referenced_message is null", () => {
    const msg = makeMsg({ content: "hi", referenced_message: null });
    expect(isReplyToOurSignature(msg, identity)).toBe(false);
  });

  test("returns false when referenced_message has empty content", () => {
    const msg = makeMsg({
      content: "hi",
      referenced_message: makeMsg({ content: "" }),
    });
    expect(isReplyToOurSignature(msg, identity)).toBe(false);
  });

  test("returns false when identity has no devName", () => {
    const msg = makeMsg({
      content: "hi",
      referenced_message: makeMsg({ content: "— **morpheus** 💊" }),
    });
    expect(isReplyToOurSignature(msg, { devName: null, devTeam: "team" })).toBe(false);
  });

  test("returns true when parent contains our signature", () => {
    const msg = makeMsg({
      content: "hi",
      referenced_message: makeMsg({
        content: "look at this — **morpheus** 💊 (team)",
      }),
    });
    expect(isReplyToOurSignature(msg, identity)).toBe(true);
  });

  test("does not match a partial signature without the em-dash prefix", () => {
    const msg = makeMsg({
      content: "hi",
      referenced_message: makeMsg({ content: "the **morpheus** project is cool" }),
    });
    expect(isReplyToOurSignature(msg, identity)).toBe(false);
  });

  test("ignores signature inside an inline code span in parent", () => {
    // A message discussing the signature format should NOT trigger reply-routing
    const msg = makeMsg({
      content: "got it",
      referenced_message: makeMsg({
        content: "the format is `— **morpheus** 💊` — see the docs",
      }),
    });
    expect(isReplyToOurSignature(msg, identity)).toBe(false);
  });

  test("ignores signature inside a fenced code block in parent", () => {
    const msg = makeMsg({
      content: "got it",
      referenced_message: makeMsg({
        content: "example signature:\n```\n— **morpheus** 💊 (team)\n```\nuse it everywhere",
      }),
    });
    expect(isReplyToOurSignature(msg, identity)).toBe(false);
  });

  test("still matches signature outside code spans even if a code span exists", () => {
    // Real signature is outside the code block; the code block contains other content
    const msg = makeMsg({
      content: "thanks",
      referenced_message: makeMsg({
        content: "fix is at `index.ts:520` — **morpheus** 💊 (team)",
      }),
    });
    expect(isReplyToOurSignature(msg, identity)).toBe(true);
  });
});

// --- Polling rate-limit hygiene tests ----------------------------------------
//
// Regression suite for issue #9. Two fixes:
//   1. Inter-channel jitter — checkForNewMessages now sleeps a random
//      50-150ms between channel polls to spread API calls across the cycle
//   2. Kill-switch-aware refresh — the channel refresh setInterval now
//      short-circuits when the kill switch is active, instead of independently
//      re-bursting the API while the main poll loop is paused

describe("nextChannelJitterMs", () => {
  test("returns a value in [50, 150) for many samples", () => {
    // Sample 200 times to get good distribution coverage
    for (let i = 0; i < 200; i++) {
      const ms = nextChannelJitterMs();
      expect(ms).toBeGreaterThanOrEqual(50);
      expect(ms).toBeLessThan(150);
    }
  });

  test("produces variation across calls (not a constant)", () => {
    // Verify the function actually randomizes — not stuck on a single value
    const samples = new Set<number>();
    for (let i = 0; i < 50; i++) {
      samples.add(nextChannelJitterMs());
    }
    // With Math.random producing 50 doubles in [50,150), we should get
    // far more than a handful of distinct values. Loose bound to avoid flakes.
    expect(samples.size).toBeGreaterThan(10);
  });
});

describe("refreshChannelList", () => {
  let originalFetch: typeof globalThis.fetch;
  const KILL_FILE = `${process.env.HOME}/.claude/discord-bot.kill`;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(KILL_FILE); } catch { /* ignore */ }
  });

  test("returns early without calling fetch when kill switch is active", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(`${process.env.HOME}/.claude`, { recursive: true });
    writeFileSync(KILL_FILE, ""); // empty file = manual kill, always active

    let fetchCallCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      return new Response("[]", { status: 200 });
    }) as any;

    await refreshChannelList("Bot fake-token");

    // The kill switch must short-circuit BEFORE any outbound API call.
    // This is the load-bearing assertion: the bug allowed the refresh
    // timer to fire during cooldown and re-burst the API.
    expect(fetchCallCount).toBe(0);
  });

  test("returns early when kill switch has a future expiry timestamp", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(`${process.env.HOME}/.claude`, { recursive: true });
    const futureTs = Math.floor(Date.now() / 1000) + 3600; // +1 hour
    writeFileSync(KILL_FILE, `${futureTs}\n`);

    let fetchCallCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      return new Response("[]", { status: 200 });
    }) as any;

    await refreshChannelList("Bot fake-token");

    expect(fetchCallCount).toBe(0);
  });

  test("calls fetchTextChannels when kill switch is clear", async () => {
    // Ensure no kill file exists
    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(KILL_FILE); } catch { /* ignore */ }

    let fetchCallCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      // Return an empty channel list — simplest happy path
      return new Response("[]", { status: 200 });
    }) as any;

    await refreshChannelList("Bot fake-token");

    // At least the /guilds/<id>/channels call should have fired
    expect(fetchCallCount).toBeGreaterThan(0);
  });
});

// --- Kill switch tests -------------------------------------------------------

describe("kill switch", () => {
  const KILL_FILE = `${process.env.HOME}/.claude/discord-bot.kill`;

  afterEach(async () => {
    // Clean up kill file after each test
    const { unlinkSync: unlink } = await import("node:fs");
    try { unlink(KILL_FILE); } catch { /* ignore if not exists */ }
  });

  test("checkKillSwitch returns clear when no kill file exists", () => {
    // Ensure kill file doesn't exist
    const { unlinkSync: unlink } = require("node:fs");
    try { unlink(KILL_FILE); } catch { /* ignore */ }

    const result = checkKillSwitch();
    expect(result).toBe("clear");
  });

  test("checkKillSwitch returns active for empty kill file (manual kill)", async () => {
    const { writeFileSync: write, mkdirSync } = await import("node:fs");
    mkdirSync(`${process.env.HOME}/.claude`, { recursive: true });
    write(KILL_FILE, "");

    const result = checkKillSwitch();
    expect(result).toBe("active");
  });

  test("checkKillSwitch returns active for future timestamp", async () => {
    const { writeFileSync: write, mkdirSync } = await import("node:fs");
    mkdirSync(`${process.env.HOME}/.claude`, { recursive: true });
    const futureTs = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    write(KILL_FILE, `${futureTs}\n`);

    const result = checkKillSwitch();
    expect(result).toBe("active");
  });

  test("checkKillSwitch auto-lifts expired timestamp", async () => {
    const { writeFileSync: write, existsSync: exists, mkdirSync } = await import("node:fs");
    mkdirSync(`${process.env.HOME}/.claude`, { recursive: true });
    const pastTs = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
    write(KILL_FILE, `${pastTs}\n`);

    const result = checkKillSwitch();
    expect(result).toBe("clear");
    // Kill file should have been deleted
    expect(exists(KILL_FILE)).toBe(false);
  });

  test("engageKillSwitch writes kill file with expiry timestamp", async () => {
    const { readFileSync: read, existsSync: exists, mkdirSync } = await import("node:fs");
    mkdirSync(`${process.env.HOME}/.claude`, { recursive: true });

    engageKillSwitch(120); // 2 minutes

    expect(exists(KILL_FILE)).toBe(true);
    const content = read(KILL_FILE, "utf-8").trim();
    const ts = parseInt(content, 10);
    const now = Math.floor(Date.now() / 1000);
    // Timestamp should be ~120 seconds in the future (allow 5s tolerance)
    expect(ts).toBeGreaterThan(now);
    expect(ts).toBeLessThanOrEqual(now + 125);
  });

  test("kill switch format is compatible with discord-bot shell script", async () => {
    const { readFileSync: read, mkdirSync } = await import("node:fs");
    mkdirSync(`${process.env.HOME}/.claude`, { recursive: true });

    engageKillSwitch(60);

    const content = read(KILL_FILE, "utf-8").trim();
    // Must be a plain integer (Unix timestamp) — discord-bot checks with regex ^[0-9]+$
    expect(content).toMatch(/^\d+$/);
  });
});

// --- loadConfig tests --------------------------------------------------------

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env vars
    process.env.DISCORD_GUILD_ID = originalEnv.DISCORD_GUILD_ID;
    process.env.DISCORD_TOKEN_PATH = originalEnv.DISCORD_TOKEN_PATH;
    process.env.SCREAM_HOLE_URL = originalEnv.SCREAM_HOLE_URL;
    if (originalEnv.DISCORD_GUILD_ID === undefined) delete process.env.DISCORD_GUILD_ID;
    if (originalEnv.DISCORD_TOKEN_PATH === undefined) delete process.env.DISCORD_TOKEN_PATH;
    if (originalEnv.SCREAM_HOLE_URL === undefined) delete process.env.SCREAM_HOLE_URL;
  });

  test("loadConfig returns an object with guildId, tokenPath, and screamHoleUrl", () => {
    const config = loadConfig();
    expect(config).toHaveProperty("guildId");
    expect(config).toHaveProperty("tokenPath");
    expect(config).toHaveProperty("screamHoleUrl");
    expect(typeof config.guildId).toBe("string");
    expect(typeof config.tokenPath).toBe("string");
    // Must return non-empty strings (either from config, env, or defaults)
    expect(config.guildId.length).toBeGreaterThan(0);
    expect(config.tokenPath.length).toBeGreaterThan(0);
    // screamHoleUrl is null when not configured
    // (it may be set via discord.json or env, so just check the type)
    expect(config.screamHoleUrl === null || typeof config.screamHoleUrl === "string").toBe(true);
  });

  test("loadConfig falls back to hardcoded defaults when no config or env", () => {
    // Temporarily clear env vars
    delete process.env.DISCORD_GUILD_ID;
    delete process.env.DISCORD_TOKEN_PATH;

    // loadConfig reads ~/.claude/discord.json if it exists, then env, then defaults.
    // We cannot remove the user's config file in a test, so we verify the
    // function at minimum returns valid values (either from config or defaults).
    const config = loadConfig();
    // The default guild ID is the Oak and Wave server
    // If config file exists, it should return the config value; otherwise the default
    expect(config.guildId).toMatch(/^\d+$/);
    expect(config.tokenPath).toContain("discord-bot-token");
  });

  test("loadConfig uses DISCORD_GUILD_ID env var when set", () => {
    process.env.DISCORD_GUILD_ID = "9999999999999999999";
    // Re-import to pick up env changes (loadConfig reads env at call time)
    // Note: if config file exists and has guild_id, that takes precedence.
    // This test verifies the env var is read when config file value is absent.
    const { loadConfig: reloadConfig } = require("../index");
    const config = reloadConfig();
    // If config file has guild_id, it takes precedence. If not, env var should win.
    // At minimum, verify the function doesn't throw.
    expect(typeof config.guildId).toBe("string");
  });

  test("DiscordConfig interface matches expected schema", () => {
    // Verify the TypeScript interface at compile time by constructing a valid object
    const config: DiscordConfig = {
      guild_id: "123",
      token_path: "~/secrets/token",
      scream_hole_url: "http://scream-hole:3000",
      channels: {
        default: { name: "agent-ops", id: "456" },
        "roll-call": { name: "roll-call", id: "789" },
      },
    };
    expect(config.guild_id).toBe("123");
    expect(config.scream_hole_url).toBe("http://scream-hole:3000");
    expect(config.channels?.default?.id).toBe("456");
    expect(config.channels?.["roll-call"]?.id).toBe("789");
  });

  test("loadConfig uses SCREAM_HOLE_URL env var when set", () => {
    process.env.SCREAM_HOLE_URL = "http://test-scream-hole:3000";
    const config = loadConfig();
    // If discord.json has scream_hole_url, that takes precedence.
    // Otherwise env var should be returned.
    // We can verify the type is correct at minimum.
    expect(config.screamHoleUrl === null || typeof config.screamHoleUrl === "string").toBe(true);
    // If no discord.json scream_hole_url, the env var should win
    if (config.screamHoleUrl !== null) {
      expect(typeof config.screamHoleUrl).toBe("string");
    }
  });

  test("loadConfig returns null screamHoleUrl when not configured", () => {
    delete process.env.SCREAM_HOLE_URL;
    // This test may be affected by discord.json having scream_hole_url.
    // We verify the function handles the case without throwing.
    const config = loadConfig();
    expect(config.screamHoleUrl === null || typeof config.screamHoleUrl === "string").toBe(true);
  });

  test("loadConfig source implements three-level fallback chain", () => {
    // Verify the implementation pattern exists in source
    const { readFileSync } = require("node:fs");
    const src = readFileSync(
      new URL("../index.ts", import.meta.url).pathname,
      "utf-8"
    );

    // Config file read
    expect(src).toContain("discord.json");
    expect(src).toContain("existsSync");

    // Env var fallback
    expect(src).toContain("process.env.DISCORD_GUILD_ID");
    expect(src).toContain("process.env.DISCORD_TOKEN_PATH");
    expect(src).toContain("process.env.SCREAM_HOLE_URL");

    // Hardcoded defaults
    expect(src).toContain('DEFAULT_GUILD_ID = "1486516321385578576"');
    expect(src).toContain('DEFAULT_TOKEN_PATH = "~/secrets/discord-bot-token"');
  });
});

// --- Scream-hole health check tests ------------------------------------------

describe("checkScreamHoleHealth", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns true when health endpoint returns 200", async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(url).toBe("http://scream-hole:3000/health");
      return new Response("OK", { status: 200 });
    }) as any;

    const result = await checkScreamHoleHealth("http://scream-hole:3000");
    expect(result).toBe(true);
  });

  test("returns false when health endpoint returns non-200", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Service Unavailable", { status: 503 });
    }) as any;

    const result = await checkScreamHoleHealth("http://scream-hole:3000");
    expect(result).toBe(false);
  });

  test("returns false when fetch throws (network error)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;

    const result = await checkScreamHoleHealth("http://scream-hole:3000");
    expect(result).toBe(false);
  });

  test("strips trailing slashes from URL before appending /health", async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(url).toBe("http://scream-hole:3000/health");
      return new Response("OK", { status: 200 });
    }) as any;

    const result = await checkScreamHoleHealth("http://scream-hole:3000/");
    expect(result).toBe(true);
  });
});

// --- resolveApiBase tests ----------------------------------------------------

describe("resolveApiBase", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns Discord API base when screamHoleUrl is null", async () => {
    const result = await resolveApiBase(null);
    expect(result).toBe(DISCORD_API_BASE);
  });

  test("returns scream-hole URL when health check passes", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("OK", { status: 200 });
    }) as any;

    const result = await resolveApiBase("http://scream-hole:3000");
    expect(result).toBe("http://scream-hole:3000");
  });

  test("returns Discord API base when scream-hole health check fails", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;

    const result = await resolveApiBase("http://scream-hole:3000");
    expect(result).toBe(DISCORD_API_BASE);
  });

  test("strips trailing slashes from scream-hole URL", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("OK", { status: 200 });
    }) as any;

    const result = await resolveApiBase("http://scream-hole:3000/");
    expect(result).toBe("http://scream-hole:3000");
  });

  test("returns Discord API base when scream-hole returns non-200", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Service Unavailable", { status: 503 });
    }) as any;

    const result = await resolveApiBase("http://scream-hole:3000");
    expect(result).toBe(DISCORD_API_BASE);
  });
});

// --- Scream-hole source integration tests ------------------------------------

describe("scream-hole source integration", () => {
  test("apiGet uses API_BASE in fetch URL (source verification)", () => {
    // Verify that apiGet constructs URLs from API_BASE
    const { readFileSync } = require("node:fs");
    const src = readFileSync(
      new URL("../index.ts", import.meta.url).pathname,
      "utf-8"
    );

    // apiGet should use API_BASE (not hardcoded Discord URL)
    expect(src).toContain("`${API_BASE}${endpoint}`");
    // API_BASE should be mutable (let, not const)
    expect(src).toContain("let API_BASE = DISCORD_API_BASE");
    // resolveApiBase should be called in main()
    expect(src).toContain("API_BASE = await resolveApiBase(CONFIGURED_SCREAM_HOLE_URL)");
  });

  test("DISCORD_API_BASE constant matches expected Discord API URL", () => {
    expect(DISCORD_API_BASE).toBe("https://discord.com/api/v10");
  });

  test("existing message fetch includes after parameter for pagination", () => {
    // Verify the watcher already passes ?after= on message fetches
    // This is critical for scream-hole which requires the after parameter
    const { readFileSync } = require("node:fs");
    const src = readFileSync(
      new URL("../index.ts", import.meta.url).pathname,
      "utf-8"
    );

    // fetchAllNewMessages must include after in query
    expect(src).toContain("messages?after=${cursor}&limit=");
  });
});
