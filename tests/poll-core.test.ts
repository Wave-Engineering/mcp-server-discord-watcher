/**
 * One poll core, two sinks (#82).
 *
 * The MCP watcher (checkForNewMessages) and the doorbell (doorbellCycle) are now
 * the same pollCycle with a different PollSink. These tests drive both real
 * wrappers with only `fetch` stubbed and hold them to the same behaviour:
 *   - the same message stream delivers the same set, in the same order;
 *   - an unresolved identity is reported once per episode (the doorbell used to
 *     go silently deaf: it never reported at all);
 *   - a voice memo is transcribed (the doorbell used to emit the bare text);
 *   - a forward rule routes the same way in both modes.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkForNewMessages,
  doorbellCycle,
  refreshIdentity,
  refreshForwardRule,
  __resetPollStateForTests,
  __resetIdentityBreakerForTests,
  IDENTITY_NOTIFY_AFTER_CYCLES,
  DOORBELL_IDENTITY_LINE_PREFIX,
  DISCORD_API_BASE,
} from "../index";
import type { DiscordChannel, DiscordMessage } from "../index";
import { clearForwardRule, forwardRulePath, writeForwardRule } from "../forward";
import { DROP_SUBDIR } from "../deliver/index";

type Mode = "mcp" | "doorbell";
const MODES: Mode[] = ["mcp", "doorbell"];

const DISCORD_EPOCH = 1420070400000n;
const AUTH = "Bot fake-token";
const KILL_FILE = `${process.env.HOME}/.claude/discord-bot.kill`;
const AUTH_FAILED_FILE = `${process.env.HOME}/.claude/discord-bot.auth-failed`;
const CHANNEL: DiscordChannel = { id: "chan-82", name: "poll-core", type: 0 };
const BASELINE_URL = `${DISCORD_API_BASE}/channels/${CHANNEL.id}/messages?limit=1`;
const POLL_PREFIX = `${DISCORD_API_BASE}/channels/${CHANNEL.id}/messages?after=`;
const FETCH_BY_ID_PREFIX = `${DISCORD_API_BASE}/channels/${CHANNEL.id}/messages/`;
const AUDIO_URL = "https://cdn.discordapp.com/attachments/voice-82.ogg";

function snowflakeAt(ms: number): string {
  return String((BigInt(ms) - DISCORD_EPOCH) << 22n);
}

let seq = 0;
/** A message newer than every message made before it. */
function makeMsg(content: string, extra: Partial<DiscordMessage> = {}): DiscordMessage {
  const ms = Date.now() + 1000 * ++seq;
  return {
    id: snowflakeAt(ms),
    author: { id: "user-bj", username: "bj" },
    content,
    timestamp: new Date(ms).toISOString(),
    ...extra,
  };
}

function voiceMemo(content: string): DiscordMessage {
  return makeMsg(content, {
    attachments: [
      { id: "att-82", filename: "voice.ogg", content_type: "audio/ogg", url: AUDIO_URL, size: 2048 },
    ],
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A fake Discord: baseline fetches see an empty channel, polls honour `after=`
 * against `posted` and return newest-first (as Discord does) plus any `stale`
 * messages (scream-hole has returned already-seen messages before), fetch-by-id
 * serves `byId`, and the CDN and STT endpoints serve a voice memo saying
 * `transcript`.
 */
function fakeDiscord(state: {
  posted: DiscordMessage[];
  stale?: DiscordMessage[];
  byId?: Record<string, Response>;
  transcript?: string;
  sttCalls?: string[];
}): void {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === BASELINE_URL) return jsonResponse([]);
    if (url.startsWith(POLL_PREFIX)) {
      const after = BigInt(new URL(url).searchParams.get("after")!);
      const newer = state.posted.filter((m) => BigInt(m.id) > after);
      const page = [...newer, ...(state.stale ?? [])];
      return jsonResponse(page.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)));
    }
    if (url.startsWith(FETCH_BY_ID_PREFIX)) {
      const id = url.slice(FETCH_BY_ID_PREFIX.length);
      return state.byId?.[id] ?? jsonResponse({ message: "Unknown Message", code: 10008 }, 404);
    }
    if (url === AUDIO_URL) return new Response(new ArrayBuffer(64), { status: 200 });
    if (url.includes("audio/transcriptions")) {
      state.sttCalls?.push(url);
      return jsonResponse({ text: state.transcript ?? "" });
    }
    throw new Error(`unexpected request ${url}`);
  }) as any;
}

interface CycleOutput {
  /** Message ids handed to the session, in order. */
  delivered: string[];
  /** What the session saw for each delivered message. */
  texts: string[];
  /** Unresolved-identity alerts: MCP notifications, or doorbell stderr lines. */
  identityAlerts: number;
}

/** One poll cycle in either transport, reading what reached the session. */
async function runCycle(mode: Mode): Promise<CycleOutput> {
  const out: CycleOutput = { delivered: [], texts: [], identityAlerts: 0 };
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (String(chunk).startsWith(DOORBELL_IDENTITY_LINE_PREFIX)) {
      out.identityAlerts++;
      return true;
    }
    return (originalErr as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    if (mode === "mcp") {
      const server = {
        notification: async (n: { params: { content: string; meta: Record<string, string> } }) => {
          const { meta, content } = n.params;
          if (meta.channel_id === "identity-unresolved") out.identityAlerts++;
          if (meta.channel_id === CHANNEL.id) {
            out.delivered.push(meta.message_id);
            out.texts.push(content);
          }
        },
      };
      await checkForNewMessages(server as any, AUTH);
      return out;
    }
    const originalOut = process.stdout.write.bind(process.stdout);
    const stdoutLines: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      const text = String(chunk);
      if (text.startsWith("[doorbell] ")) {
        stdoutLines.push(text);
        return true;
      }
      return (originalOut as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    try {
      await doorbellCycle(AUTH);
    } finally {
      process.stdout.write = originalOut;
    }
    for (const line of stdoutLines) {
      out.delivered.push(line.match(/ msg_id=(\S+) /)![1]);
      out.texts.push(line);
    }
    return out;
  } finally {
    process.stderr.write = originalErr;
  }
}

let originalFetch: typeof globalThis.fetch;
let projectRoot: string;
const savedProjectDir = process.env.CLAUDE_PROJECT_DIR;

function writeIdentity(): void {
  mkdirSync(join(projectRoot, ".claude"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".claude", "agent-identity.json"),
    JSON.stringify({ dev_name: "cerberus", dev_team: "oaw" })
  );
}

function wipeIdentity(): void {
  rmSync(join(projectRoot, ".claude", "agent-identity.json"), { force: true });
}

function resetAll(): void {
  for (const f of [KILL_FILE, AUTH_FAILED_FILE]) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
  clearForwardRule();
  refreshForwardRule();
  refreshIdentity();
  __resetIdentityBreakerForTests();
  __resetPollStateForTests([CHANNEL]);
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // HOME is a throwaway dir (tests/home-guard.ts), so the sentinels and the
  // forward rule written here never touch a live watcher.
  mkdirSync(`${process.env.HOME}/.claude`, { recursive: true });
  projectRoot = mkdtempSync(join(tmpdir(), "dw-poll-core-"));
  process.env.CLAUDE_PROJECT_DIR = projectRoot;
  writeIdentity();
  resetAll();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
  rmSync(projectRoot, { recursive: true, force: true });
  resetAll();
  __resetPollStateForTests([]);
});

describe("one poll core (#82) — both sinks deliver the same set", () => {
  test("the same message stream yields the same delivered ids, in order, in both modes", async () => {
    // One stream, fed to each mode in turn from a fresh state.
    const stream = [
      makeMsg("@cerberus hello"),                          // addressed by name
      makeMsg("chatter nobody asked for"),                 // unaddressed
      makeMsg("@oaw team ping"),                           // addressed by team
      makeMsg("@all heads up"),                            // broadcast
      makeMsg("@cerberus ack — **cerberus** 🐕 (oaw)"),    // our own echo
      makeMsg(""),                                         // empty, no attachments
      voiceMemo("@cerberus listen"),                       // addressed voice memo
    ];
    const later = makeMsg("@cerberus again");

    const results: Record<Mode, CycleOutput> = {} as any;
    for (const mode of MODES) {
      resetAll();
      const state = {
        posted: [] as DiscordMessage[],
        stale: [] as DiscordMessage[],
        transcript: "status is green",
      };
      fakeDiscord(state);
      expect((await runCycle(mode)).delivered).toEqual([]); // baseline: empty channel

      state.posted.push(...stream);
      const first = await runCycle(mode);

      // A redelivered message alongside a new one: only the new one goes out.
      state.posted.push(later);
      state.stale.push(stream[0]);
      const second = await runCycle(mode);

      results[mode] = {
        delivered: [...first.delivered, ...second.delivered],
        texts: [...first.texts, ...second.texts],
        identityAlerts: first.identityAlerts + second.identityAlerts,
      };
      expect(results[mode].delivered).toEqual(
        [stream[0], stream[2], stream[3], stream[6], later].map((m) => m.id)
      );
      expect(results[mode].texts[3]).toContain('[voice memo from bj: "status is green"]');
      expect(results[mode].identityAlerts).toBe(0);
    }
    expect(results.doorbell.delivered).toEqual(results.mcp.delivered);
  });
});

describe.each(MODES)("unresolved identity (#28, #82) — %s mode", (mode) => {
  test("reported once per episode, nothing delivered, and again after a recovery and a new break", async () => {
    wipeIdentity();
    refreshIdentity();
    const state = { posted: [] as DiscordMessage[] };
    fakeDiscord(state);
    let alerts = (await runCycle(mode)).identityAlerts; // baseline cycle
    state.posted.push(makeMsg("@cerberus are you there?"));

    let delivered: string[] = [];
    // The startup grace, then many more cycles: exactly one alert, no repeat.
    for (let i = 0; i < IDENTITY_NOTIFY_AFTER_CYCLES + 20; i++) {
      const out = await runCycle(mode);
      alerts += out.identityAlerts;
      delivered = delivered.concat(out.delivered);
    }
    expect(alerts).toBe(1);
    expect(delivered).toEqual([]); // fail-closed: deaf, but no longer silent

    // Recovery: no alert.
    writeIdentity();
    expect((await runCycle(mode)).identityAlerts).toBe(0);

    // A new break after a recovery alerts again, at once (no startup grace).
    wipeIdentity();
    const out = await runCycle(mode);
    expect(out.identityAlerts).toBe(1);
    expect((await runCycle(mode)).identityAlerts).toBe(0);
  });
});

describe("doorbell voice memo (#82)", () => {
  test("the doorbell line carries the transcription, from the stubbed STT endpoint", async () => {
    const sttCalls: string[] = [];
    const state = { posted: [] as DiscordMessage[], transcript: "deploy is green", sttCalls };
    fakeDiscord(state);
    await runCycle("doorbell"); // baseline

    const memo = voiceMemo("@cerberus");
    state.posted.push(memo);
    const out = await runCycle("doorbell");

    expect(out.delivered).toEqual([memo.id]);
    expect(out.texts[0]).toContain('[voice memo from bj: "deploy is green"] @cerberus');
    expect(out.texts[0].trimEnd()).not.toContain("\n"); // still one physical line
    expect(sttCalls).toHaveLength(1);
  });
});

describe.each(MODES)("forward rule (#68/#69, #82) — %s mode", (mode) => {
  let dropDir: string;

  beforeEach(() => {
    dropDir = mkdtempSync(join(tmpdir(), "dw-forward-82-"));
    // A file-drop target: the deliver-router's floor, so no `aoe send` runs.
    writeForwardRule({ target: { label: "grunt-82", dir: dropDir }, exclude: [] }, forwardRulePath());
  });

  afterEach(() => {
    rmSync(dropDir, { recursive: true, force: true });
  });

  test("forwards a matching message, keeps a local //directmsg, falls back locally on a failed fetch", async () => {
    const state = { posted: [] as DiscordMessage[], byId: {} as Record<string, Response> };
    fakeDiscord(state);
    await runCycle(mode); // baseline

    const handled = makeMsg("@cerberus please handle the release notes");
    const redPhone = makeMsg("//dm @cerberus parked, need you");
    const flaky = makeMsg("@cerberus the fetch for this one fails");
    state.posted.push(handled, redPhone, flaky);
    state.byId[handled.id] = jsonResponse(handled);
    state.byId[flaky.id] = jsonResponse({ message: "upstream sad" }, 500);

    const out = await runCycle(mode);

    // Forwarded away: not delivered locally, landed in the target's drop dir.
    expect(out.delivered).toEqual([redPhone.id, flaky.id]);
    const drops = readdirSync(join(dropDir, DROP_SUBDIR));
    expect(drops).toHaveLength(1);
    const dropped = readFileSync(join(dropDir, DROP_SUBDIR, drops[0]), "utf-8");
    expect(dropped).toContain("[disc-forward from bj in #poll-core]");
    expect(dropped).toContain("please handle the release notes");
  });

  test("with the rule removed, everything is delivered locally again", async () => {
    clearForwardRule();
    const state = { posted: [] as DiscordMessage[] };
    fakeDiscord(state);
    await runCycle(mode); // baseline

    const msg = makeMsg("@cerberus no rule now");
    state.posted.push(msg);
    expect((await runCycle(mode)).delivered).toEqual([msg.id]);
  });
});
