/**
 * Poll order (#92): the cursor and delivery must not assume the order a page
 * comes back in.
 *
 * Discord returns a messages page newest-first. scream-hole returns the newest N
 * matches oldest-first, and answers `after`+`limit` by dropping the older
 * matches. These tests drive the REAL poll cycles with only `fetch` stubbed, in
 * both response shapes, and observe the cursor through the `after=` of the next
 * request, as baseline.test.ts does.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkForNewMessages,
  doorbellCycle,
  refreshIdentity,
  __resetPollStateForTests,
  __resetIdentityBreakerForTests,
  __dedupHitsForTests,
  newestId,
  byIdAscending,
  DISCORD_API_BASE,
} from "../index";
import type { DiscordChannel, DiscordMessage } from "../index";

type Shape = "scream-hole" | "discord";
type Mode = "mcp" | "doorbell";

const DISCORD_EPOCH = 1420070400000n;
const KILL_FILE = `${process.env.HOME}/.claude/discord-bot.kill`;
const AUTH_FAILED_FILE = `${process.env.HOME}/.claude/discord-bot.auth-failed`;
const SCREAM_HOLE_BASE = "https://scream-hole.test/api/v10";
const CHANNEL: DiscordChannel = { id: "chan-92", name: "poll-order", type: 0 };

const base = (shape: Shape): string => (shape === "scream-hole" ? SCREAM_HOLE_BASE : DISCORD_API_BASE);
const messagesUrl = (shape: Shape): string => `${base(shape)}/channels/${CHANNEL.id}/messages`;

function snowflakeAt(ms: number): string {
  return String((BigInt(ms) - DISCORD_EPOCH) << 22n);
}

let seq = 0;
/** An addressed message newer than every message made before it. */
function makeMsg(content = "@cerberus ping"): DiscordMessage {
  const ms = Date.now() + 1000 * ++seq;
  return {
    id: snowflakeAt(ms),
    author: { id: "user-bj", username: "bj" },
    content,
    timestamp: new Date(ms).toISOString(),
  };
}

function burst(n: number): DiscordMessage[] {
  return Array.from({ length: n }, (_, i) => makeMsg(`@cerberus burst ${i}`));
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const ascending = (msgs: DiscordMessage[]): DiscordMessage[] =>
  [...msgs].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

/**
 * A fake upstream holding `posted`, answering GET /messages the way `shape` does:
 *   - scream-hole (cache.ts getMessages): the matches after `after`, ascending;
 *     with `limit`, only the NEWEST `limit` of them.
 *   - Discord: with `after`, the OLDEST `limit` (default 50) after it; without,
 *     the newest `limit`. Either way the page is newest-first.
 * Every request URL is appended to `requests`.
 */
function fakeUpstream(shape: Shape, posted: DiscordMessage[], requests: string[]): void {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (!url.startsWith(`${messagesUrl(shape)}?`)) throw new Error(`unexpected request ${url}`);
    const params = new URL(url).searchParams;
    const after = params.get("after");
    const limitParam = params.get("limit");
    const all = ascending(posted);
    if (shape === "scream-hole") {
      if (after === null) throw new Error(`scream-hole requires after: ${url}`);
      let matches = all.filter((m) => BigInt(m.id) > BigInt(after));
      if (limitParam !== null) matches = matches.slice(Math.max(0, matches.length - Number(limitParam)));
      return jsonResponse(matches);
    }
    const limit = limitParam === null ? 50 : Number(limitParam);
    const page = after === null
      ? all.slice(Math.max(0, all.length - limit))
      : all.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, limit);
    return jsonResponse(page.reverse());
  }) as any;
}

/** A poll request (not the baseline fetch): it carries `after` and no `limit=1`. */
function isPoll(url: string): boolean {
  const params = new URL(url).searchParams;
  return params.has("after") && params.get("limit") !== "1";
}

function pollCursors(requests: string[]): string[] {
  return requests.filter(isPoll).map((u) => new URL(u).searchParams.get("after")!);
}

/** One poll cycle in either transport, returning the message ids it delivered, in order. */
async function runCycle(mode: Mode): Promise<string[]> {
  const delivered: string[] = [];
  if (mode === "mcp") {
    const server = {
      notification: async (n: { params: { meta: Record<string, string> } }) => {
        if (n.params.meta.channel_id === CHANNEL.id) delivered.push(n.params.meta.message_id);
      },
    };
    await checkForNewMessages(server as any, "Bot fake-token");
    return delivered;
  }
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const m = String(chunk).match(/^\[doorbell\] .* msg_id=(\S+) /);
    if (m) {
      delivered.push(m[1]);
      return true;
    }
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    await doorbellCycle("Bot fake-token");
  } finally {
    process.stdout.write = originalWrite;
  }
  return delivered;
}

let originalFetch: typeof globalThis.fetch;
let tmpRoot: string;
const savedProjectDir = process.env.CLAUDE_PROJECT_DIR;

function clearSentinels(): void {
  for (const f of [KILL_FILE, AUTH_FAILED_FILE]) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // HOME is a throwaway dir (tests/home-guard.ts), so nothing here touches a live watcher.
  mkdirSync(`${process.env.HOME}/.claude`, { recursive: true });
  clearSentinels();
  tmpRoot = mkdtempSync(join(tmpdir(), "dw-poll-order-"));
  mkdirSync(join(tmpRoot, ".claude"), { recursive: true });
  writeFileSync(
    join(tmpRoot, ".claude", "agent-identity.json"),
    JSON.stringify({ dev_name: "cerberus", dev_team: "oaw" })
  );
  process.env.CLAUDE_PROJECT_DIR = tmpRoot;
  refreshIdentity();
  __resetIdentityBreakerForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSentinels();
  if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
  refreshIdentity();
  __resetPollStateForTests([]);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("newestId / byIdAscending (#92)", () => {
  const [a, b, c] = burst(3);

  test("newestId is the max id in any order", () => {
    expect(newestId([a, b, c])).toBe(c.id);
    expect(newestId([c, b, a])).toBe(c.id);
    expect(newestId([b, c, a])).toBe(c.id);
  });

  test("newestId compares by value, not as strings", () => {
    // "9" > "10" as a string; 10n > 9n as a snowflake.
    const short = { ...a, id: "9" };
    const long = { ...a, id: "10" };
    expect(newestId([short, long])).toBe("10");
  });

  test("byIdAscending sorts a copy, oldest first", () => {
    const input = [c, a, b];
    expect(byIdAscending(input).map((m) => m.id)).toEqual([a.id, b.id, c.id]);
    expect(input.map((m) => m.id)).toEqual([c.id, a.id, b.id]);
  });
});

describe.each(["scream-hole", "discord"] as Shape[])("poll order (#92) — %s shape", (shape) => {
  let requests: string[];
  let posted: DiscordMessage[];

  beforeEach(() => {
    __resetPollStateForTests([CHANNEL], base(shape));
    requests = [];
    posted = [];
    fakeUpstream(shape, posted, requests);
  });

  /** Baseline the channel on an empty upstream, so every later message is new. */
  async function baseline(): Promise<void> {
    expect(await runCycle("mcp")).toEqual([]);
    expect(pollCursors(requests)).toEqual([]);
  }

  test("three new messages: the cursor ends at the max id, and the next poll gets nothing", async () => {
    await baseline();
    const msgs = burst(3);
    posted.push(...msgs);
    expect(await runCycle("mcp")).toEqual(msgs.map((m) => m.id));

    expect(await runCycle("mcp")).toEqual([]);
    const cursors = pollCursors(requests);
    expect(cursors[cursors.length - 1]).toBe(msgs[2].id);
  });

  test.each(["mcp", "doorbell"] as Mode[])("delivery is oldest first, in %s mode", async (mode) => {
    await baseline();
    const msgs = burst(5);
    posted.push(...msgs);
    expect(await runCycle(mode)).toEqual(msgs.map((m) => m.id));
  });

  test("no replay reaches the dedup set across five empty polls", async () => {
    await baseline();
    posted.push(...burst(3));
    expect(await runCycle("mcp")).toHaveLength(3);

    for (let i = 0; i < 5; i++) {
      expect(await runCycle("mcp")).toEqual([]);
    }
    // Before #92 the scream-hole cursor sat on the OLDEST message, so each of
    // these polls re-fetched the rest and only the dedup set kept them out.
    expect(__dedupHitsForTests()).toBe(0);
  });

  test("a non-empty baseline seeds the cursor at the newest message", async () => {
    // Three messages already in the channel when the watcher starts.
    const old = Array.from({ length: 3 }, (_, i) => {
      const ms = Date.now() - 60_000 + i * 1000;
      return { ...makeMsg(), id: snowflakeAt(ms), timestamp: new Date(ms).toISOString() };
    });
    posted.push(...old);
    expect(await runCycle("mcp")).toEqual([]);

    expect(await runCycle("mcp")).toEqual([]);
    expect(pollCursors(requests)).toEqual([old[2].id]);
  });
});

describe("baseline cursor, whatever the page (#92)", () => {
  // Both shapes answer the baseline's `limit=1` with one message, where position
  // and value agree. An upstream that returns more than asked for, oldest first,
  // is where `messages[0]` would seed the cursor at the oldest.
  test.each(["scream-hole", "discord"] as Shape[])("%s: a multi-message baseline seeds at the max id", async (shape) => {
    __resetPollStateForTests([CHANNEL], base(shape));
    const old = Array.from({ length: 3 }, (_, i) => {
      const ms = Date.now() - 60_000 + i * 1000;
      return { ...makeMsg(), id: snowflakeAt(ms), timestamp: new Date(ms).toISOString() };
    });
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      return jsonResponse(isPoll(url) ? [] : old);
    }) as any;

    expect(await runCycle("mcp")).toEqual([]);
    expect(await runCycle("mcp")).toEqual([]);
    expect(pollCursors(requests)).toEqual([old[2].id]);
  });
});

describe("bursts over one page (#92)", () => {
  test("scream-hole: a burst of 60 is delivered whole, in order, once, from one request with no limit", async () => {
    __resetPollStateForTests([CHANNEL], SCREAM_HOLE_BASE);
    const requests: string[] = [];
    const posted: DiscordMessage[] = [];
    fakeUpstream("scream-hole", posted, requests);
    expect(await runCycle("mcp")).toEqual([]);

    const msgs = burst(60);
    posted.push(...msgs);
    requests.length = 0;
    expect(await runCycle("mcp")).toEqual(msgs.map((m) => m.id));

    const polls = requests.filter(isPoll);
    expect(polls).toHaveLength(1);
    expect(new URL(polls[0]).searchParams.has("limit")).toBe(false);
    expect(await runCycle("mcp")).toEqual([]);
    expect(__dedupHitsForTests()).toBe(0);
  });

  test("Discord: a burst of 120 pages as 50, 50 and 20, and is delivered whole, in order, once", async () => {
    __resetPollStateForTests([CHANNEL], DISCORD_API_BASE);
    const requests: string[] = [];
    const posted: DiscordMessage[] = [];
    fakeUpstream("discord", posted, requests);
    expect(await runCycle("mcp")).toEqual([]);

    const msgs = burst(120);
    posted.push(...msgs);
    requests.length = 0;
    expect(await runCycle("mcp")).toEqual(msgs.map((m) => m.id));

    const polls = requests.filter(isPoll);
    expect(polls.map((u) => new URL(u).searchParams.get("limit"))).toEqual(["50", "50", "50"]);
    // Each page starts after the newest message of the one before.
    expect(pollCursors(polls).slice(1)).toEqual([msgs[49].id, msgs[99].id]);
    expect(await runCycle("mcp")).toEqual([]);
    expect(__dedupHitsForTests()).toBe(0);
  });
});
