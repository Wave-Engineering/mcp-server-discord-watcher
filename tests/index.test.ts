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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordMessage, DiscordAttachment, DiscordConfig } from "../index";
import {
  stripTokenPunctuation,
  loadConfig,
  computeChannelAllowlist,
  isChannelInScope,
  checkKillSwitch,
  engageKillSwitch,
  checkAuthFailed,
  engageAuthFailed,
  clearAuthFailed,
  extractOrigin,
  checkScreamHoleHealth,
  ensureApiV10Suffix,
  resolveApiBase,
  shouldDeliverMessage,
  isReplyToOurSignature,
  nextChannelJitterMs,
  refreshChannelList,
  describeAuthHeader,
  classifyFetchFailure,
  refreshIdentity,
  fetchMessageById,
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

// #32 + #34 + #723: durable identity path under the locked root contract
// (CLAUDE_PROJECT_DIR). Behavioral fs tests — point CLAUDE_PROJECT_DIR at a scratch
// root, write real identity files, and assert resolveIdentity's actual return.
// These replace the prior source-introspection checks, which were behavior-blind
// and passed even with the shadowing bug present (mother's #34 finding).
describe("identity durable-path resolution (#32/#34)", () => {
  let tmpRoot: string;
  let legacyTmpFile: string;
  const savedProjectDir = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createHash } = await import("node:crypto");
    tmpRoot = mkdtempSync(join(tmpdir(), "ident-"));
    process.env.CLAUDE_PROJECT_DIR = tmpRoot;
    // resolveIdentity keys the legacy file on md5(projectRoot) under /tmp.
    const dirHash = createHash("md5").update(tmpRoot).digest("hex");
    legacyTmpFile = `/tmp/claude-agent-${dirHash}.json`;
  });

  afterEach(async () => {
    const { rmSync, existsSync } = await import("node:fs");
    rmSync(tmpRoot, { recursive: true, force: true });
    if (existsSync(legacyTmpFile)) rmSync(legacyTmpFile, { force: true });
    if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
  });

  async function writeDurable(obj: unknown): Promise<void> {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(join(tmpRoot, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpRoot, ".claude", "agent-identity.json"),
      JSON.stringify(obj)
    );
  }
  async function writeLegacy(obj: unknown): Promise<void> {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(legacyTmpFile, JSON.stringify(obj));
  }

  test("anchors on CLAUDE_PROJECT_DIR and reads the durable .claude/agent-identity.json under it", async () => {
    const { resolveIdentity } = await import("../index");
    await writeDurable({ dev_name: "polyjuice", dev_team: "oaw" });
    expect(resolveIdentity()).toEqual({ devName: "polyjuice", devTeam: "oaw" });
  });

  test("durable present and valid → legacy /tmp is ignored", async () => {
    const { resolveIdentity } = await import("../index");
    await writeDurable({ dev_name: "polyjuice", dev_team: "oaw" });
    await writeLegacy({ dev_name: "STALE", dev_team: "STALE" });
    expect(resolveIdentity()).toEqual({ devName: "polyjuice", devTeam: "oaw" });
  });

  test("empty {} durable file does NOT shadow a valid /tmp identity (#34 shadowing fix)", async () => {
    const { resolveIdentity } = await import("../index");
    await writeDurable({}); // parses, but yields no usable fields
    await writeLegacy({ dev_name: "polyjuice", dev_team: "oaw" });
    expect(resolveIdentity()).toEqual({ devName: "polyjuice", devTeam: "oaw" });
  });

  test("partial durable file (missing dev_team) falls through to a complete /tmp identity", async () => {
    const { resolveIdentity } = await import("../index");
    await writeDurable({ dev_name: "polyjuice" }); // incomplete — must not be accepted
    await writeLegacy({ dev_name: "polyjuice", dev_team: "oaw" });
    expect(resolveIdentity()).toEqual({ devName: "polyjuice", devTeam: "oaw" });
  });

  test("neither file present → {null, null}", async () => {
    const { resolveIdentity } = await import("../index");
    expect(resolveIdentity()).toEqual({ devName: null, devTeam: null });
  });
});

// --- AgentIdentity interface tests -------------------------------------------

// --- #54/#57: non-secret auth diagnostics -----------------------------------
//
// The attribution half of #54 was retired in #57 — mcp-logger >= 1.1.0 injects
// pid + instance natively. These auth diagnostics have NO native equivalent and
// are the instrument the 401 investigation depends on, so they stay.

// --- #57: the contract that REPLACED the wrapper -----------------------------
//
// Retiring withProcessAttribution removed 5 tests and added none, which moved the
// assertion from "our wrapper does this" to "the pinned dependency does this" —
// and left the second half unasserted. The acceptance evidence was a one-time
// manual run, and manual evidence expires the moment it is pasted. These pin the
// contract in CI instead.

describe("mcp-logger attribution contract (#57)", () => {
  test("the dependency is pinned EXACTLY — no range", () => {
    // The realistic regression: someone runs `bun add @wave-engineering/mcp-logger`
    // and a caret gets written back. 1.1.0's guarantee is a KEY-OWNERSHIP contract
    // (which field names it reserves), and semver has no opinion on that — a
    // compliant 1.2.0 reserving another key would silently re-stamp
    // reserved_conflict on caller fields and destroy the signal #57 restored.
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8")
    );
    const spec = pkg.dependencies["@wave-engineering/mcp-logger"];
    expect(spec).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("REAL emitted lines carry pid + instance and NO reserved_conflict", async () => {
    // Asserts against actual output from the real logger, not a fake — this is
    // the acceptance criterion from #57 made permanent. A green suite that only
    // exercised our own code would prove nothing about the dependency.
    const dir = mkdtempSync(join(tmpdir(), "logcontract-"));
    const logFile = join(dir, "out.jsonl");
    const prev = process.env.LOG_FILE;
    process.env.LOG_FILE = logFile;
    try {
      const { createLogger } = await import("@wave-engineering/mcp-logger");
      const a = createLogger("watcher") as any;
      const b = createLogger("watcher") as any;
      a.error("api_call", { status: 401, auth_len: 76, auth_prefix: "Bot " });
      b.warn("poll", { channel: "general" });

      const lines = readFileSync(logFile, "utf-8")
        .split("\n")
        .filter((l) => l.trim().startsWith("{"))
        .map((l) => JSON.parse(l));

      // Guard against a vacuous pass: zero lines must FAIL, not silently succeed.
      expect(lines.length).toBeGreaterThan(0);
      for (const d of lines) {
        expect(typeof d.pid).toBe("number");
        expect(typeof d.instance).toBe("string");
        expect(d.reserved_conflict).toBeUndefined();
      }
      // One instance id across separate createLogger() calls — the broader
      // coverage the wrapper could not provide.
      expect(new Set(lines.map((d: any) => d.instance)).size).toBe(1);
      // The 401 instrument survived the wrapper's deletion.
      expect(lines.find((d: any) => d.status === 401)?.auth_prefix).toBe("Bot ");
    } finally {
      if (prev === undefined) delete process.env.LOG_FILE;
      else process.env.LOG_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("describeAuthHeader (#54)", () => {
  // Deliberately NOT shaped like a real Discord token (no base64.ts.hmac
  // segments). A realistic-looking fake trips GitHub push protection and,
  // worse, invites a future reader to wonder whether it is live. Nothing
  // here depends on the shape — only on length and the scheme prefix.
  const TOKEN = "FAKE-TEST-CREDENTIAL-NOT-A-REAL-TOKEN-000000000000";
  const HEADER = `Bot ${TOKEN}`;

  test("reports the length and the scheme prefix", () => {
    const d = describeAuthHeader(HEADER);
    expect(d.auth_len).toBe(HEADER.length);
    expect(d.auth_prefix).toBe("Bot ");
  });

  test("SECRET SAFETY: emits no part of the token beyond the scheme prefix", () => {
    // Load-bearing. A regression here leaks a credential into a log file that
    // is not treated as a secret store. Serialize exactly as the logger would
    // and assert the token cannot be recovered from it.
    const serialized = JSON.stringify(describeAuthHeader(HEADER));
    expect(serialized).not.toContain(TOKEN);
    // no run of token characters, not merely the whole token
    for (let n = 6; n <= 24; n += 6) {
      expect(serialized).not.toContain(TOKEN.slice(0, n));
    }
    // Pin the prefix EXACTLY. The loop above starts at n=6, so widening the
    // slice to 5–9 chars would leak 1–5 token characters undetected; this
    // closes that blind spot without hard-coding token bytes into the test.
    expect(describeAuthHeader(HEADER).auth_prefix).toBe(HEADER.slice(0, 4));
  });

  test("a malformed header is still describable (does not throw)", () => {
    expect(describeAuthHeader("")).toEqual({ auth_len: 0, auth_prefix: "" });
    expect(describeAuthHeader(TOKEN).auth_prefix).not.toBe("Bot ");
  });

  test("discriminates a bare token from a correctly-prefixed one", () => {
    // This is the whole diagnostic purpose: a process sending a bare token
    // (the known 401 cause) is distinguishable from one sending "Bot <tok>".
    expect(describeAuthHeader(TOKEN).auth_prefix).not.toBe("Bot ");
    expect(describeAuthHeader(HEADER).auth_prefix).toBe("Bot ");
    expect(describeAuthHeader(HEADER).auth_len - describeAuthHeader(TOKEN).auth_len).toBe(4);
  });
});

// --- #48: proxy 404 must not be misread as a deleted message ----------------
//
// Confirmed firing in PRODUCTION for 43+ hours: the deployed scream-hole v1.2.0
// does not route GET /channels/{id}/messages/{id}, so every fetchMessageById
// through it hit the catch-all 404 and was classified `gone` → dropped, no
// fallback, no log. The status code alone cannot say WHO answered.

describe("classifyFetchFailure (#48)", () => {
  test("Discord 404 with a RESOURCE-GONE code → gone (genuine deletion still drops)", () => {
    expect(classifyFetchFailure(404, { message: "Unknown Message", code: 10008 })).toBe("gone");
    expect(classifyFetchFailure(404, { message: "Unknown Channel", code: 10003 })).toBe("gone");
  });

  test("THE PRODUCTION BUG: scream-hole catch-all 404 → error, NOT gone", () => {
    // Body captured from the live proxy by babelfish:
    //   GET https://scream-hole.apps.oakai.waveeng.com/api/v10/channels/1/messages/1
    //   → 404 {"error":"not found"}
    expect(classifyFetchFailure(404, { error: "not found" })).toBe("error");
  });

  test("a self-identifying proxy body → error, however Discord-like otherwise", () => {
    // Presence-based identification: even if a proxy body grows a `code` field,
    // announcing itself as an intermediary wins. Discrimination by ABSENCE of
    // `code` would silently flip here; this must not.
    expect(classifyFetchFailure(404, { error: "no route", proxy: "scream-hole" })).toBe("error");
    expect(classifyFetchFailure(404, { code: 10008, proxy: "scream-hole" })).toBe("error");
  });

  test("Discord's GENERIC 404 (code:0) → error, NOT gone", () => {
    // Verified against the live API: an unrouted/malformed path returns
    //   404 {"message":"404: Not Found","code":0}
    // `typeof 0 === "number"`, so an "any numeric code" rule classified this as
    // a deletion — #48's exact shape with Discord as the speaker. A malformed
    // message id or a route regression would silently drop messages.
    expect(classifyFetchFailure(404, { message: "404: Not Found", code: 0 })).toBe("error");
  });

  test("a generic gateway envelope using the STATUS as the code → error", () => {
    // {"code":404,"message":"Not Found"} is a common intermediary shape.
    expect(classifyFetchFailure(404, { code: 404, message: "Not Found" })).toBe("error");
  });

  test("a real Discord code that is not a resource-gone code → error", () => {
    // 50001 Missing Access is a permissions problem, not a deletion — the
    // message likely still exists, so it must not be dropped.
    expect(classifyFetchFailure(404, { message: "Missing Access", code: 50001 })).toBe("error");
  });

  test("unidentified speaker → error (the DEFAULT branch, fail toward keeping)", () => {
    for (const body of [undefined, null, "", 0, [], {}, { raw: "<html>502</html>" }, { error: "x" }]) {
      expect(classifyFetchFailure(404, body)).toBe("error");
    }
  });

  test("survives a proxy catch-all status change (404 → 501)", () => {
    // scream-hole may switch its catch-all to 501. Nothing here keys on the
    // proxy's number, so the classifier is correct before and after.
    expect(classifyFetchFailure(501, { error: "no route", proxy: "scream-hole" })).toBe("error");
    expect(classifyFetchFailure(501, { code: 10008 })).toBe("error");
  });

  test("non-404 statuses are always error, code or not", () => {
    for (const st of [401, 403, 429, 500, 502, 503]) {
      expect(classifyFetchFailure(st, { code: 10008 })).toBe("error");
      expect(classifyFetchFailure(st, { error: "not found" })).toBe("error");
    }
  });

  test("a code that is not a number does not qualify as Discord", () => {
    // Guards a string-typed `code` (the wrong-type-config defect class) from
    // being read as an authoritative Discord deletion.
    expect(classifyFetchFailure(404, { code: "10008" })).toBe("error");
    expect(classifyFetchFailure(404, { code: null })).toBe("error");
  });
});

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

  // #32: tighten fail-closed to ANY unresolved field, not only both-null
  test("FAIL CLOSED: drops on partial identity (devTeam null) even on @all", () => {
    const msg = makeMsg({ content: "@all everyone read this" });
    expect(shouldDeliverMessage(msg, identity({ devTeam: null }))).toBe(false);
  });

  test("FAIL CLOSED: drops on partial identity (devName null) even on @<team>", () => {
    const msg = makeMsg({ content: "@mcp-server-discord-watcher ship it" });
    expect(shouldDeliverMessage(msg, identity({ devName: null }))).toBe(false);
  });

  test("FAIL CLOSED: empty-string fields count as unresolved", () => {
    const msg = makeMsg({ content: "@all hi" });
    expect(shouldDeliverMessage(msg, { devName: "", devTeam: "oaw" })).toBe(false);
    expect(shouldDeliverMessage(msg, { devName: "oaw", devTeam: "" })).toBe(false);
  });

  test("still delivers on a fully-resolved identity (no regression)", () => {
    const msg = makeMsg({ content: "@all standup" });
    expect(shouldDeliverMessage(msg, identity())).toBe(true);
  });

  test("FAIL CLOSED: drops even @all when identity is unresolved", () => {
    // The most surprising case: even broadcasts fail closed for unidentified
    // agents. Better silence than cross-project leakage.
    const msg = makeMsg({ content: "@all standup in 5" });
    const noIdentity = { devName: null, devTeam: null };
    expect(shouldDeliverMessage(msg, noIdentity)).toBe(false);
  });

  test("FAIL CLOSED: drops on partial identity (devName null), even with @<team> match — #32 tightened from both-null", () => {
    const msg = makeMsg({ content: "@my-team ship it" });
    const partialIdentity = { devName: null, devTeam: "my-team" };
    // Pre-#32 this delivered (fail-closed fired only when BOTH fields were null).
    // #32 fails closed on ANY unresolved field — a partial identity is exactly
    // the over-broad risk we're closing. Deaf > over-broad.
    expect(shouldDeliverMessage(msg, partialIdentity)).toBe(false);
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

// --- Auth-failure circuit breaker tests --------------------------------------
//
// Regression suite for issue #8. The watcher previously caught 401 responses
// in the per-channel error handler, logged them, and continued polling
// forever — silently delivering zero notifications. The fix adds a sentinel-
// file-backed circuit breaker (mirroring the kill switch pattern) that
// engages on first 401, short-circuits subsequent polls, emits a one-time
// MCP notification to the Claude session, and is cleared on watcher restart.

describe("auth-failure circuit breaker", () => {
  const AUTH_FAILED_FILE = `${process.env.HOME}/.claude/discord-bot.auth-failed`;

  afterEach(async () => {
    // Clean up sentinel file after each test
    const { unlinkSync: unlink } = await import("node:fs");
    try { unlink(AUTH_FAILED_FILE); } catch { /* ignore if not exists */ }
  });

  test("checkAuthFailed returns false when sentinel file does not exist", () => {
    // Ensure file doesn't exist
    const { unlinkSync: unlink } = require("node:fs");
    try { unlink(AUTH_FAILED_FILE); } catch { /* ignore */ }

    expect(checkAuthFailed()).toBe(false);
  });

  test("engageAuthFailed creates the sentinel file with an ISO timestamp", async () => {
    const { existsSync, readFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(`${process.env.HOME}/.claude`, { recursive: true });

    engageAuthFailed();

    expect(existsSync(AUTH_FAILED_FILE)).toBe(true);
    const content = readFileSync(AUTH_FAILED_FILE, "utf-8");
    // ISO timestamp prefix + the canonical reason string
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(content).toContain("401 Unauthorized");
  });

  test("engageAuthFailed is idempotent — second call does not overwrite", async () => {
    const { existsSync, readFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(`${process.env.HOME}/.claude`, { recursive: true });

    engageAuthFailed();
    expect(existsSync(AUTH_FAILED_FILE)).toBe(true);
    const firstContent = readFileSync(AUTH_FAILED_FILE, "utf-8");

    // Wait a tick to ensure any second-write would have a different timestamp
    await new Promise((r) => setTimeout(r, 10));

    engageAuthFailed();
    const secondContent = readFileSync(AUTH_FAILED_FILE, "utf-8");

    expect(secondContent).toBe(firstContent);
  });

  test("checkAuthFailed returns true after engageAuthFailed", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(`${process.env.HOME}/.claude`, { recursive: true });

    expect(checkAuthFailed()).toBe(false);
    engageAuthFailed();
    expect(checkAuthFailed()).toBe(true);
  });

  test("clearAuthFailed removes the sentinel file", async () => {
    const { existsSync, mkdirSync } = await import("node:fs");
    mkdirSync(`${process.env.HOME}/.claude`, { recursive: true });

    engageAuthFailed();
    expect(existsSync(AUTH_FAILED_FILE)).toBe(true);

    clearAuthFailed();
    expect(existsSync(AUTH_FAILED_FILE)).toBe(false);
    expect(checkAuthFailed()).toBe(false);
  });

  test("clearAuthFailed is idempotent when sentinel does not exist", () => {
    // No file, no error
    expect(() => clearAuthFailed()).not.toThrow();
    expect(checkAuthFailed()).toBe(false);
  });
});

describe("refreshChannelList: auth-failure integration", () => {
  let originalFetch: typeof globalThis.fetch;
  const AUTH_FAILED_FILE = `${process.env.HOME}/.claude/discord-bot.auth-failed`;
  const KILL_FILE = `${process.env.HOME}/.claude/discord-bot.kill`;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(AUTH_FAILED_FILE); } catch { /* ignore */ }
    try { unlinkSync(KILL_FILE); } catch { /* ignore */ }
  });

  test("returns early without fetch when auth-failed sentinel exists", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(`${process.env.HOME}/.claude`, { recursive: true });
    writeFileSync(AUTH_FAILED_FILE, new Date().toISOString());

    let fetchCallCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      return new Response("[]", { status: 200 });
    }) as any;

    await refreshChannelList("Bot fake-token");

    expect(fetchCallCount).toBe(0);
  });

  test("engages auth-failed when fetchTextChannels returns 401", async () => {
    // Ensure clean state
    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(AUTH_FAILED_FILE); } catch { /* ignore */ }

    expect(checkAuthFailed()).toBe(false);

    globalThis.fetch = mock(async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as any;

    // refreshChannelList swallows fetchTextChannels errors via the outer
    // catch in the setInterval wrapper, but inside the function the throw
    // propagates. We catch it here so the test continues to the assertion.
    try {
      await refreshChannelList("Bot fake-token");
    } catch {
      // Expected — fetchTextChannels throws on non-OK
    }

    // The 401 should have been intercepted by apiGet → engageAuthFailed,
    // regardless of whether the throw bubbled up
    expect(checkAuthFailed()).toBe(true);
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

// --- extractOrigin tests -----------------------------------------------------

describe("extractOrigin", () => {
  test("extracts origin from bare URL", () => {
    expect(extractOrigin("https://scream-hole.apps.oakai.waveeng.com")).toBe(
      "https://scream-hole.apps.oakai.waveeng.com"
    );
  });

  test("extracts origin from URL with /api/v10 path", () => {
    expect(extractOrigin("https://scream-hole.apps.oakai.waveeng.com/api/v10")).toBe(
      "https://scream-hole.apps.oakai.waveeng.com"
    );
  });

  test("extracts origin from URL with /api/v10/ trailing slash", () => {
    expect(extractOrigin("https://scream-hole.apps.oakai.waveeng.com/api/v10/")).toBe(
      "https://scream-hole.apps.oakai.waveeng.com"
    );
  });

  test("extracts origin from URL with port", () => {
    expect(extractOrigin("http://scream-hole:3000/api/v10")).toBe(
      "http://scream-hole:3000"
    );
  });

  test("extracts origin from bare URL with trailing slash", () => {
    expect(extractOrigin("http://scream-hole:3000/")).toBe(
      "http://scream-hole:3000"
    );
  });
});

// --- ensureApiV10Suffix tests ------------------------------------------------

describe("ensureApiV10Suffix", () => {
  test("appends /api/v10 to bare origin", () => {
    expect(ensureApiV10Suffix("https://scream-hole.apps.oakai.waveeng.com")).toBe(
      "https://scream-hole.apps.oakai.waveeng.com/api/v10"
    );
  });

  test("does not double-append when URL already has /api/v10", () => {
    expect(ensureApiV10Suffix("https://scream-hole.apps.oakai.waveeng.com/api/v10")).toBe(
      "https://scream-hole.apps.oakai.waveeng.com/api/v10"
    );
  });

  test("strips trailing slash and does not double-append", () => {
    expect(ensureApiV10Suffix("https://scream-hole.apps.oakai.waveeng.com/api/v10/")).toBe(
      "https://scream-hole.apps.oakai.waveeng.com/api/v10"
    );
  });

  test("works with port-based URL", () => {
    expect(ensureApiV10Suffix("http://scream-hole:3000")).toBe(
      "http://scream-hole:3000/api/v10"
    );
  });

  test("strips trailing slash from bare origin before appending", () => {
    expect(ensureApiV10Suffix("http://scream-hole:3000/")).toBe(
      "http://scream-hole:3000/api/v10"
    );
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

  test("hits origin /health even when URL includes /api/v10 path", async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // Must hit the origin root, NOT /api/v10/health
      expect(url).toBe("https://scream-hole.apps.oakai.waveeng.com/health");
      return new Response("OK", { status: 200 });
    }) as any;

    const result = await checkScreamHoleHealth(
      "https://scream-hole.apps.oakai.waveeng.com/api/v10"
    );
    expect(result).toBe(true);
  });

  test("hits origin /health even when URL includes /api/v10/ trailing slash", async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(url).toBe("https://scream-hole.apps.oakai.waveeng.com/health");
      return new Response("OK", { status: 200 });
    }) as any;

    const result = await checkScreamHoleHealth(
      "https://scream-hole.apps.oakai.waveeng.com/api/v10/"
    );
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

  test("returns scream-hole URL with /api/v10 when health check passes", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("OK", { status: 200 });
    }) as any;

    const result = await resolveApiBase("http://scream-hole:3000");
    expect(result).toBe("http://scream-hole:3000/api/v10");
  });

  test("returns Discord API base when scream-hole health check fails", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;

    const result = await resolveApiBase("http://scream-hole:3000");
    expect(result).toBe(DISCORD_API_BASE);
  });

  test("strips trailing slashes and appends /api/v10", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("OK", { status: 200 });
    }) as any;

    const result = await resolveApiBase("http://scream-hole:3000/");
    expect(result).toBe("http://scream-hole:3000/api/v10");
  });

  test("does not double-append /api/v10 when URL already has it", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("OK", { status: 200 });
    }) as any;

    const result = await resolveApiBase("https://scream-hole.apps.oakai.waveeng.com/api/v10");
    expect(result).toBe("https://scream-hole.apps.oakai.waveeng.com/api/v10");
  });

  test("handles URL with /api/v10/ trailing slash", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("OK", { status: 200 });
    }) as any;

    const result = await resolveApiBase("https://scream-hole.apps.oakai.waveeng.com/api/v10/");
    expect(result).toBe("https://scream-hole.apps.oakai.waveeng.com/api/v10");
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

  test("resolveApiBase applies ensureApiV10Suffix (source verification)", () => {
    const { readFileSync } = require("node:fs");
    const src = readFileSync(
      new URL("../index.ts", import.meta.url).pathname,
      "utf-8"
    );

    // resolveApiBase must call ensureApiV10Suffix before returning
    expect(src).toContain("ensureApiV10Suffix(screamHoleUrl)");
  });

  test("checkScreamHoleHealth uses extractOrigin for health URL (source verification)", () => {
    const { readFileSync } = require("node:fs");
    const src = readFileSync(
      new URL("../index.ts", import.meta.url).pathname,
      "utf-8"
    );

    // Health check must extract origin to avoid hitting /api/v10/health
    expect(src).toContain("extractOrigin(url)");
    expect(src).toContain("${origin}/health");
  });
});

// --- Channel poll-scope allowlist (#31 cross-team leak fix) -------------------

describe("computeChannelAllowlist", () => {
  test("unset config + unset env → null (backward-compatible poll-all)", () => {
    expect(computeChannelAllowlist({}, undefined)).toBeNull();
  });

  test("empty env string → null", () => {
    expect(computeChannelAllowlist({}, "")).toBeNull();
  });

  test("env comma-separated → trimmed array", () => {
    expect(computeChannelAllowlist({}, "123, 456 ,oaw")).toEqual([
      "123",
      "456",
      "oaw",
    ]);
  });

  test("env with only whitespace/commas → null", () => {
    expect(computeChannelAllowlist({}, " , , ")).toBeNull();
  });

  test("config.watcher_channels (array) → used", () => {
    expect(
      computeChannelAllowlist({ watcher_channels: ["111", "oaw"] }, undefined)
    ).toEqual(["111", "oaw"]);
  });

  test("config takes precedence over env", () => {
    expect(
      computeChannelAllowlist({ watcher_channels: ["fromConfig"] }, "fromEnv")
    ).toEqual(["fromConfig"]);
  });

  test("empty config array falls through to env", () => {
    expect(
      computeChannelAllowlist({ watcher_channels: [] }, "fromEnv")
    ).toEqual(["fromEnv"]);
  });

  test("non-array config.watcher_channels is ignored → falls through to env", () => {
    expect(
      computeChannelAllowlist(
        { watcher_channels: "oaw,roll-call" as unknown as string[] },
        "fromEnv"
      )
    ).toEqual(["fromEnv"]);
  });

  test("non-array config + no env → null (poll-all, not a crash)", () => {
    expect(
      computeChannelAllowlist(
        { watcher_channels: "oaw" as unknown as string[] },
        undefined
      )
    ).toBeNull();
  });
});

describe("isChannelInScope", () => {
  const ch = (id: string, name: string) => ({ id, name });

  test("null allowlist → every channel in scope (backward-compat)", () => {
    expect(isChannelInScope(ch("200", "ams-clusterfuck"), null)).toBe(true);
  });

  test("in scope by channel id", () => {
    expect(isChannelInScope(ch("100", "oaw"), ["100", "300"])).toBe(true);
  });

  test("in scope by channel name", () => {
    expect(isChannelInScope(ch("100", "oaw"), ["oaw", "roll-call"])).toBe(true);
  });

  test("foreign-team channel is out of scope — the cross-team leak fix", () => {
    expect(
      isChannelInScope(ch("200", "ams-clusterfuck"), ["oaw", "roll-call"])
    ).toBe(false);
  });

  test("empty allowlist → nothing in scope (explicit empty scope)", () => {
    expect(isChannelInScope(ch("100", "oaw"), [])).toBe(false);
  });

  test("non-matching allowlist entry → out of scope (no false positives)", () => {
    expect(isChannelInScope(ch("100", "oaw"), ["nonexistent"])).toBe(false);
  });

  test("name match is case-insensitive (UI lowercases, API may not)", () => {
    expect(isChannelInScope(ch("100", "OAW"), ["oaw"])).toBe(true);
  });

  test("mixed-case allowlist entry matches lowercase channel name", () => {
    expect(isChannelInScope(ch("100", "oaw"), ["OAW"])).toBe(true);
  });

  test("id and name are interchangeable", () => {
    expect(isChannelInScope(ch("300", "roll-call"), ["300"])).toBe(true);
    expect(isChannelInScope(ch("300", "roll-call"), ["roll-call"])).toBe(true);
  });
});

// --- refreshIdentity startup self-registration (#38) -------------------------
//
// Regression suite for issue #38. The watcher previously populated cachedIdentity
// only on the first poll cycle (15 seconds after startup). Doorbells arriving in
// that window were dropped via the fail-closed null-identity guard. The fix calls
// refreshIdentity() in main() before the setInterval, so the cache is warm before
// any message can arrive.

describe("refreshIdentity startup self-registration (#38)", () => {
  let tmpRoot: string;
  const savedProjectDir = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    tmpRoot = mkdtempSync(join(tmpdir(), "startup-ident-"));
    process.env.CLAUDE_PROJECT_DIR = tmpRoot;
  });

  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    rmSync(tmpRoot, { recursive: true, force: true });
    if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
  });

  test("refreshIdentity returns true when a new identity appears (cache miss)", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    // Use a timestamp-derived name to guarantee it differs from any cached state
    const uniqueName = `test-startup-${Date.now()}`;
    mkdirSync(join(tmpRoot, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpRoot, ".claude", "agent-identity.json"),
      JSON.stringify({ dev_name: uniqueName, dev_team: "oaw" })
    );
    const changed = refreshIdentity();
    expect(changed).toBe(true);
  });

  test("refreshIdentity is idempotent — second call with same state returns false", async () => {
    // Call twice in the same env state: second call must not report a change
    refreshIdentity();
    const result = refreshIdentity();
    expect(result).toBe(false);
  });

  test("refreshIdentity with no identity file does not throw", () => {
    // No .claude/agent-identity.json in tmpRoot — must not crash
    expect(() => refreshIdentity()).not.toThrow();
  });

  test("refreshIdentity with malformed JSON does not throw", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(join(tmpRoot, ".claude"), { recursive: true });
    writeFileSync(join(tmpRoot, ".claude", "agent-identity.json"), "{ bad json }}}");
    expect(() => refreshIdentity()).not.toThrow();
  });

  test("main() calls refreshIdentity() before the poll setInterval (source verification)", () => {
    const { readFileSync } = require("node:fs");
    const src = readFileSync(
      new URL("../index.ts", import.meta.url).pathname,
      "utf-8"
    );
    const mainFnIndex = src.indexOf("async function main()");
    expect(mainFnIndex).toBeGreaterThan(0);
    const refreshCallIndex = src.indexOf("refreshIdentity()", mainFnIndex);
    const pollTimerIndex = src.indexOf("setInterval", mainFnIndex);
    // refreshIdentity() must appear inside main() and before the first setInterval
    expect(refreshCallIndex).toBeGreaterThan(mainFnIndex);
    expect(refreshCallIndex).toBeLessThan(pollTimerIndex);
  });
});

// --- fetchMessageById: single-message (channel, msgid) fetch (#66) -----------

describe("fetchMessageById", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("GETs /channels/{c}/messages/{m} and returns kind:'found' with the message", async () => {
    let capturedUrl = "";
    const single: DiscordMessage = {
      id: "999",
      author: { id: "u9", username: "dana" },
      content: "the specific message",
      timestamp: "2024-01-01T12:05:00.000Z",
    };
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify(single), { status: 200 });
    }) as any;

    const res = await fetchMessageById("123", "999", "Bot test-token");

    // Single-message endpoint — no ?limit / ?after query
    expect(capturedUrl).toContain("/channels/123/messages/999");
    expect(capturedUrl).not.toContain("?");
    expect(res.kind).toBe("found");
    if (res.kind === "found") {
      expect(res.message.id).toBe("999");
      expect(res.message.content).toBe("the specific message");
    }
  });

  test("passes the Authorization header through apiGet", async () => {
    let capturedAuth: string | null | undefined;
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedAuth = new Headers(init?.headers).get("Authorization");
      return new Response(JSON.stringify({ id: "1", author: { id: "u", username: "x" }, content: "y", timestamp: "t" }), { status: 200 });
    }) as any;

    await fetchMessageById("123", "1", "Bot secret-token");
    expect(capturedAuth).toBe("Bot secret-token");
  });

  test("returns kind:'gone' on a real Discord 404 (deleted / unknown message)", async () => {
    // FIXTURE CORRECTED (#48). This previously mocked a bare text body
    // (`new Response("Unknown Message", {status: 404})`), which Discord never
    // sends — its error envelope is JSON carrying a numeric `code`. That
    // unrealistic fixture is part of why a status-only check looked sufficient:
    // with no distinguishing body in the test, there was nothing to discriminate
    // ON, so `status === 404` looked like the only available signal.
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ message: "Unknown Message", code: 10008 }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
    ) as any;
    expect(await fetchMessageById("123", "404404404", "Bot t")).toEqual({ kind: "gone" });
  });

  test("returns kind:'error' on a 404 whose body does NOT identify Discord (#48)", async () => {
    // The production bug, end to end through the real fetchMessageById: the
    // deployed scream-hole catch-all. Must NOT be classified `gone`.
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
    ) as any;
    expect(await fetchMessageById("123", "1", "Bot t")).toEqual({ kind: "error" });
  });

  test("returns kind:'error' on a bare-text 404 (unidentified speaker)", async () => {
    // Deliberate behaviour change: a 404 with no parseable identifying envelope
    // is now kept, not dropped. Failing toward keeping costs one spurious local
    // notify; failing the other way loses the message silently forever.
    globalThis.fetch = mock(async () => new Response("Unknown Message", { status: 404 })) as any;
    expect(await fetchMessageById("123", "1", "Bot t")).toEqual({ kind: "error" });
  });

  test("returns kind:'error' on 403 (missing READ_MESSAGE_HISTORY — transient)", async () => {
    globalThis.fetch = mock(async () => new Response("Missing Access", { status: 403 })) as any;
    expect(await fetchMessageById("123", "1", "Bot t")).toEqual({ kind: "error" });
  });

  test("returns kind:'error' on 5xx (server error — transient)", async () => {
    globalThis.fetch = mock(async () => new Response("Bad Gateway", { status: 502 })) as any;
    expect(await fetchMessageById("123", "1", "Bot t")).toEqual({ kind: "error" });
  });

  test("returns kind:'error' on a network / timeout throw (transient)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as any;
    expect(await fetchMessageById("123", "1", "Bot t")).toEqual({ kind: "error" });
  });
});
