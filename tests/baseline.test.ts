/**
 * Baseline regression suite (#81): a quiet channel's first message must not be
 * eaten as the baseline.
 *
 * Every baseline path goes through one helper (baselineChannel). These tests
 * drive the REAL poll cycles — the MCP watcher's checkForNewMessages and the
 * doorbell's doorbellCycle — with only `fetch` stubbed, as the other suites do.
 * The cursor is observed through the request the next cycle makes: a baseline
 * fetch is `?limit=1`, a poll is `?after=<cursor>&limit=50`.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkForNewMessages,
  doorbellCycle,
  refreshIdentity,
  __resetPollStateForTests,
  __resetIdentityBreakerForTests,
  DISCORD_API_BASE,
} from "../index";
import type { DiscordChannel, DiscordMessage } from "../index";

const DISCORD_EPOCH = 1420070400000n;
const KILL_FILE = `${process.env.HOME}/.claude/discord-bot.kill`;
const AUTH_FAILED_FILE = `${process.env.HOME}/.claude/discord-bot.auth-failed`;
const CHANNEL: DiscordChannel = { id: "chan-81", name: "quiet-channel", type: 0 };
const BASELINE_URL = `${DISCORD_API_BASE}/channels/${CHANNEL.id}/messages?limit=1`;
const POLL_PREFIX = `${DISCORD_API_BASE}/channels/${CHANNEL.id}/messages?after=`;

function snowflakeToMs(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

function snowflakeAt(ms: number): string {
  return String((BigInt(ms) - DISCORD_EPOCH) << 22n);
}

function makeMsg(id: string, content: string): DiscordMessage {
  return {
    id,
    author: { id: "user-bj", username: "bj" },
    content,
    timestamp: new Date(snowflakeToMs(id)).toISOString(),
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** `after` cursor of a poll URL, or null for anything else. */
function afterCursor(url: string): string | null {
  if (!url.startsWith(POLL_PREFIX)) return null;
  return new URL(url).searchParams.get("after");
}

/**
 * One poll cycle in either transport, returning the message ids it delivered:
 * MCP mode reads them off server.notification, doorbell mode off the stdout
 * line it writes.
 */
type Mode = "mcp" | "doorbell";

async function runCycle(mode: Mode): Promise<string[]> {
  const delivered: string[] = [];
  if (mode === "mcp") {
    const server = {
      notification: mock(async (n: { params: { meta: { message_id: string } } }) => {
        delivered.push(n.params.meta.message_id);
      }),
    };
    await checkForNewMessages(server as any, "Bot fake-token");
    return delivered;
  }
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = String(chunk);
    const m = text.match(/^\[doorbell\] .* msg_id=(\S+) /);
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

describe.each(["mcp", "doorbell"] as Mode[])("baseline (#81) — %s mode", (mode) => {
  let originalFetch: typeof globalThis.fetch;
  let tmpRoot: string;
  const savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
  let requests: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    for (const f of [KILL_FILE, AUTH_FAILED_FILE]) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    // A resolved identity, so an addressed message passes the delivery gate.
    tmpRoot = mkdtempSync(join(tmpdir(), "dw-baseline-"));
    mkdirSync(join(tmpRoot, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpRoot, ".claude", "agent-identity.json"),
      JSON.stringify({ dev_name: "cerberus", dev_team: "oaw" })
    );
    process.env.CLAUDE_PROJECT_DIR = tmpRoot;
    refreshIdentity();
    __resetIdentityBreakerForTests();
    __resetPollStateForTests([CHANNEL]);
    requests = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const f of [KILL_FILE, AUTH_FAILED_FILE]) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
    refreshIdentity();
    __resetPollStateForTests([]);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function stubFetch(handler: (url: string) => Response): void {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      return handler(url);
    }) as any;
  }

  test("empty baseline: cursor is 'now', and the first message after it is delivered", async () => {
    // Cycle 1 — the channel has no recent message (a quiet channel through
    // scream-hole's 4h window looks exactly like this).
    stubFetch((url) => {
      if (url === BASELINE_URL) return jsonResponse([]);
      throw new Error(`unexpected request ${url}`);
    });
    const before = Date.now();
    expect(await runCycle(mode)).toEqual([]);
    const after = Date.now();

    // Cycle 2 — BJ's first message arrives. Before #81 this cycle re-ran the
    // baseline fetch and swallowed the message as the baseline.
    const first = makeMsg(snowflakeAt(after + 1000), "@cerberus are you there?");
    stubFetch((url) => {
      if (afterCursor(url) !== null) return jsonResponse([first]);
      throw new Error(`unexpected request ${url}`);
    });
    expect(await runCycle(mode)).toEqual([first.id]);

    // Exactly one baseline fetch, then a poll whose cursor is a snowflake for
    // the moment the baseline was taken.
    expect(requests.filter((u) => u === BASELINE_URL)).toHaveLength(1);
    const cursor = afterCursor(requests[requests.length - 1]);
    expect(cursor).not.toBeNull();
    const cursorMs = snowflakeToMs(cursor!);
    expect(cursorMs).toBeGreaterThanOrEqual(before);
    expect(cursorMs).toBeLessThanOrEqual(after);
  });

  test("non-empty baseline: seeds at the newest message and never replays it", async () => {
    const boundary = makeMsg(snowflakeAt(Date.now() - 60_000), "@cerberus old news");
    stubFetch((url) => {
      if (url === BASELINE_URL) return jsonResponse([boundary]);
      throw new Error(`unexpected request ${url}`);
    });
    expect(await runCycle(mode)).toEqual([]);

    // The poll returns the boundary again alongside a new message — scream-hole
    // has returned already-seen messages before. Only the new one is delivered.
    const fresh = makeMsg(snowflakeAt(Date.now() + 1000), "@cerberus new news");
    stubFetch((url) => {
      if (afterCursor(url) !== null) return jsonResponse([fresh, boundary]);
      throw new Error(`unexpected request ${url}`);
    });
    expect(await runCycle(mode)).toEqual([fresh.id]);
    expect(afterCursor(requests[requests.length - 1])).toBe(boundary.id);
  });

  test("429 on the baseline fetch: channel stays un-baselined and nothing is delivered", async () => {
    stubFetch((url) => {
      if (url === BASELINE_URL) {
        return new Response("rate limited", { status: 429, headers: { "Retry-After": "1" } });
      }
      throw new Error(`unexpected request ${url}`);
    });
    expect(await runCycle(mode)).toEqual([]);
    expect(existsSync(KILL_FILE)).toBe(true); // apiGet engaged the 429 breaker
    unlinkSync(KILL_FILE);

    // Next cycle is a baseline fetch again (no cursor was set), not a poll.
    const msg = makeMsg(snowflakeAt(Date.now()), "@cerberus during the 429");
    stubFetch((url) => {
      if (url === BASELINE_URL) return jsonResponse([msg]);
      throw new Error(`unexpected request ${url}`);
    });
    expect(await runCycle(mode)).toEqual([]);
    expect(requests.filter((u) => u === BASELINE_URL)).toHaveLength(2);
    expect(requests.some((u) => afterCursor(u) !== null)).toBe(false);
  });
});
