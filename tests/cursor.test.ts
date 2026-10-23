/**
 * Persisted poll cursor (#83).
 *
 * A restarted watcher, or a re-armed doorbell-oneshot, used to re-seed every
 * channel to its newest message and skip whatever arrived while it was down.
 * These tests drive the real startup (initializeBaselines) and the real poll
 * cycles with only `fetch` stubbed. A "restart" is what a new process sees:
 * the in-memory poll state is reset and only the cursor file survives.
 *
 * Every test points XDG_STATE_HOME at its own temp directory, so no cursor is
 * ever written beside a live watcher's.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  checkForNewMessages,
  doorbellCycle,
  initializeBaselines,
  refreshIdentity,
  refreshForwardRule,
  cursorPath,
  saveCursor,
  __resetPollStateForTests,
  __resetIdentityBreakerForTests,
  CURSOR_MAX_AGE_MS,
  DISCORD_API_BASE,
} from "../index";
import type { AgentIdentity, CursorFile, DiscordChannel, DiscordMessage } from "../index";
import { clearForwardRule } from "../forward";

type Mode = "mcp" | "doorbell";
const MODES: Mode[] = ["mcp", "doorbell"];

const DISCORD_EPOCH = 1420070400000n;
const AUTH = "Bot fake-token";
const KILL_FILE = `${process.env.HOME}/.claude/discord-bot.kill`;
const AUTH_FAILED_FILE = `${process.env.HOME}/.claude/discord-bot.auth-failed`;
const CHAN_A: DiscordChannel = { id: "chan-83-a", name: "alpha", type: 0 };
const CHAN_B: DiscordChannel = { id: "chan-83-b", name: "bravo", type: 0 };
const CHANNELS = [CHAN_A, CHAN_B];
const AUDIO_URL = "https://cdn.discordapp.com/attachments/voice-83.ogg";

const CERBERUS: AgentIdentity = { devName: "cerberus", devTeam: "oaw" };
const HYDRA: AgentIdentity = { devName: "hydra", devTeam: "oaw" };

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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const newestFirst = (msgs: DiscordMessage[]): DiscordMessage[] =>
  [...msgs].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));

/**
 * A fake Discord with two channels. Like the real API, a baseline fetch
 * (`?limit=1`) returns the newest message, so a baseline sits AT the latest
 * message: anything posted before it is never delivered. Polls honour `after=`.
 * `requests` records every URL; `onStt` runs when the STT endpoint answers.
 */
interface FakeState {
  posted: Record<string, DiscordMessage[]>;
  requests: string[];
  onStt?: () => void;
}

function fakeDiscord(): FakeState {
  const state: FakeState = { posted: { [CHAN_A.id]: [], [CHAN_B.id]: [] }, requests: [] };
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input);
    state.requests.push(url);
    for (const ch of CHANNELS) {
      const base = `${DISCORD_API_BASE}/channels/${ch.id}/messages`;
      if (url === `${base}?limit=1`) {
        return jsonResponse(newestFirst(state.posted[ch.id]).slice(0, 1));
      }
      if (url.startsWith(`${base}?after=`)) {
        const after = BigInt(new URL(url).searchParams.get("after")!);
        return jsonResponse(newestFirst(state.posted[ch.id].filter((m) => BigInt(m.id) > after)));
      }
    }
    if (url === AUDIO_URL) return new Response(new ArrayBuffer(64), { status: 200 });
    if (url.includes("audio/transcriptions")) {
      state.onStt?.();
      return jsonResponse({ text: "on my way" });
    }
    throw new Error(`unexpected request ${url}`);
  }) as any;
  return state;
}

const baselineFetches = (state: FakeState): string[] =>
  state.requests.filter((u) => u.endsWith("?limit=1"));

/** Captured `cursor` log events from the stderr JSONL stream. */
let cursorLogs: Record<string, unknown>[] = [];
let originalErr: typeof process.stderr.write;

function captureCursorLogs(): void {
  cursorLogs = [];
  originalErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = String(chunk);
    try {
      const line = JSON.parse(text);
      if (line.event === "cursor") {
        cursorLogs.push(line);
        return true;
      }
    } catch {
      /* not a log line */
    }
    return (originalErr as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
}

/**
 * One poll cycle in either transport, returning the message ids delivered, in
 * order. `onLine` sees each doorbell stdout line as it is written.
 */
async function runCycle(
  mode: Mode,
  opts: { onLine?: (msgId: string) => void; failNotify?: boolean } = {}
): Promise<string[]> {
  const delivered: string[] = [];
  if (mode === "mcp") {
    const server = {
      notification: async (n: { params: { meta: Record<string, string> } }) => {
        const { meta } = n.params;
        if (!CHANNELS.some((c) => c.id === meta.channel_id)) return;
        if (opts.failNotify) throw new Error("transport down");
        delivered.push(meta.message_id);
      },
    };
    await checkForNewMessages(server as any, AUTH);
    return delivered;
  }
  const originalOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    const id = String(chunk).match(/ msg_id=(\S+) /)?.[1];
    if (id) {
      delivered.push(id);
      opts.onLine?.(id);
    }
    return true;
  }) as typeof process.stdout.write;
  try {
    await doorbellCycle(AUTH);
  } finally {
    process.stdout.write = originalOut;
  }
  return delivered;
}

let projectRoot: string;
let stateHome: string;
let originalFetch: typeof globalThis.fetch;
const savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
const savedStateHome = process.env.XDG_STATE_HOME;

function setIdentity(identity: AgentIdentity | null): void {
  const file = join(projectRoot, ".claude", "agent-identity.json");
  if (identity) {
    mkdirSync(join(projectRoot, ".claude"), { recursive: true });
    writeFileSync(file, JSON.stringify({ dev_name: identity.devName, dev_team: identity.devTeam }));
  } else {
    rmSync(file, { force: true });
  }
  refreshIdentity();
}

/** What a new process sees: fresh poll state, then startup. */
async function restart(): Promise<number> {
  __resetPollStateForTests(CHANNELS);
  __resetIdentityBreakerForTests();
  refreshIdentity();
  return initializeBaselines(AUTH);
}

function readCursor(identity: AgentIdentity = CERBERUS): CursorFile {
  return JSON.parse(readFileSync(cursorPath(identity)!, "utf-8"));
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mkdirSync(`${process.env.HOME}/.claude`, { recursive: true });
  for (const f of [KILL_FILE, AUTH_FAILED_FILE]) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
  clearForwardRule();
  refreshForwardRule();
  projectRoot = mkdtempSync(join(tmpdir(), "dw-cursor-project-"));
  stateHome = mkdtempSync(join(tmpdir(), "dw-cursor-state-"));
  process.env.CLAUDE_PROJECT_DIR = projectRoot;
  process.env.XDG_STATE_HOME = stateHome;
  setIdentity(CERBERUS);
  captureCursorLogs();
});

afterEach(() => {
  process.stderr.write = originalErr;
  globalThis.fetch = originalFetch;
  if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
  if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedStateHome;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(stateHome, { recursive: true, force: true });
  refreshIdentity();
  __resetIdentityBreakerForTests();
  __resetPollStateForTests([]);
});

describe("cursor file location (#83)", () => {
  test("per guild and identity, under XDG_STATE_HOME, falling back to ~/.local/state", () => {
    expect(cursorPath(CERBERUS, "g1")).toBe(
      join(stateHome, "discord-watcher", "cursor-g1-oaw-cerberus.json")
    );
    expect(cursorPath(CERBERUS, "g2")).not.toBe(cursorPath(CERBERUS, "g1"));
    expect(cursorPath(HYDRA, "g1")).not.toBe(cursorPath(CERBERUS, "g1"));

    delete process.env.XDG_STATE_HOME;
    expect(cursorPath(CERBERUS, "g1")).toBe(
      join(process.env.HOME!, ".local", "state", "discord-watcher", "cursor-g1-oaw-cerberus.json")
    );
    process.env.XDG_STATE_HOME = "relative/state"; // the XDG spec says ignore it
    expect(cursorPath(CERBERUS, "g1")!.startsWith(join(process.env.HOME!, ".local", "state"))).toBe(true);
  });

  test("an identity cannot escape the state directory through its name", () => {
    const path = cursorPath({ devName: "../../evil", devTeam: "a/b" }, "g1")!;
    expect(dirname(path)).toBe(join(stateHome, "discord-watcher"));
  });

  test("an unresolved identity has no cursor file", () => {
    expect(cursorPath({ devName: null, devTeam: "oaw" })).toBeNull();
    expect(cursorPath({ devName: "cerberus", devTeam: null })).toBeNull();
  });
});

describe.each(MODES)("restart resumes from the saved cursor (#83) — %s mode", (mode) => {
  test("messages that arrived while the watcher was down are delivered after the restart", async () => {
    const state = fakeDiscord();
    state.posted[CHAN_A.id].push(makeMsg("history, before the first start"));
    await restart();
    expect(await runCycle(mode)).toEqual([]);
    expect(Object.keys(readCursor().channels).sort()).toEqual([CHAN_A.id, CHAN_B.id]);

    // Down: two addressed messages and one chatter line arrive.
    const missedA = makeMsg("@cerberus while you were out");
    const chatter = makeMsg("nobody asked");
    const missedB = makeMsg("@oaw team ping");
    state.posted[CHAN_A.id].push(missedA, chatter);
    state.posted[CHAN_B.id].push(missedB);

    state.requests.length = 0;
    expect(await restart()).toBe(2);
    expect(baselineFetches(state)).toEqual([]); // resumed, not re-seeded
    expect(await runCycle(mode)).toEqual([missedA.id, missedB.id]);
    expect(cursorLogs.find((l) => l.action === "resumed")).toMatchObject({ channels: 2, baselined: 0 });

    // And they are now behind the cursor: a second restart replays nothing.
    await restart();
    expect(await runCycle(mode)).toEqual([]);
  });

  test("without a saved cursor the same restart skips them (the pre-#83 behaviour)", async () => {
    const state = fakeDiscord();
    await restart();
    await runCycle(mode);
    rmSync(cursorPath(CERBERUS)!);

    state.posted[CHAN_A.id].push(makeMsg("@cerberus while you were out"));
    await restart();
    expect(await runCycle(mode)).toEqual([]);
  });

  test("a channel missing from the cursor is baselined as today", async () => {
    const state = fakeDiscord();
    await restart();
    await runCycle(mode);
    const saved = readCursor();
    delete saved.channels[CHAN_B.id];
    writeFileSync(cursorPath(CERBERUS)!, JSON.stringify(saved));

    const missedA = makeMsg("@cerberus resumed channel");
    const missedB = makeMsg("@cerberus baselined channel");
    state.posted[CHAN_A.id].push(missedA);
    state.posted[CHAN_B.id].push(missedB);
    state.requests.length = 0;
    expect(await restart()).toBe(1);
    expect(baselineFetches(state)).toEqual([
      `${DISCORD_API_BASE}/channels/${CHAN_B.id}/messages?limit=1`,
    ]);
    expect(await runCycle(mode)).toEqual([missedA.id]);
  });
});

// doorbell-oneshot drains ~0.2 s after the FIRST doorbell line and then SIGTERMs
// the watcher, almost always mid-cycle. A signal handler runs only between
// event-loop turns, so the first macrotask after the first line is the earliest
// moment the process can die: the file as it stands then is all a re-armed
// doorbell gets. It must cover every line already printed (or the re-arm
// re-delivers that batch, every time, forever) and nothing not yet printed (or
// the re-arm skips it).
describe("doorbell-oneshot re-arm (#83)", () => {
  test("the cursor at the kill covers every printed line and nothing unprinted", async () => {
    const state = fakeDiscord();
    await restart();
    await runCycle("doorbell");
    const before = readCursor().channels;

    const a1 = makeMsg("@cerberus first");
    const a2 = makeMsg("@cerberus second, same channel");
    const b1 = makeMsg("@cerberus other channel, polled after the jitter");
    state.posted[CHAN_A.id].push(a1, a2);
    state.posted[CHAN_B.id].push(b1);

    // Arm a "kill" at the first macrotask after the first line.
    let atKill: string | null = null;
    let printedBeforeKill: string[] | null = null;
    const printed: string[] = [];
    await runCycle("doorbell", {
      onLine: (id) => {
        printed.push(id);
        if (printed.length === 1) {
          setTimeout(() => {
            atKill = readFileSync(cursorPath(CERBERUS)!, "utf-8");
            printedBeforeKill = [...printed];
          }, 0);
        }
      },
    });
    expect(printedBeforeKill!).toEqual([a1.id, a2.id]); // B was not printed yet
    const killed: CursorFile = JSON.parse(atKill!);
    expect(killed.channels[CHAN_A.id]).toBe(a2.id); // covers what was printed
    expect(killed.channels[CHAN_B.id]).toBe(before[CHAN_B.id]); // not what wasn't

    // The process died there: the file is what it was at the kill. Re-arm, with
    // one more message having arrived in between.
    writeFileSync(cursorPath(CERBERUS)!, atKill!);
    const a3 = makeMsg("@cerberus arrived while re-arming");
    state.posted[CHAN_A.id].push(a3);
    await restart();
    expect(await runCycle("doorbell")).toEqual([a3.id, b1.id]);
  });

  test("a kill while a channel is still preparing (slow transcription) leaves its cursor where it was", async () => {
    const state = fakeDiscord();
    await restart();
    await runCycle("doorbell");
    const before = readCursor().channels[CHAN_A.id];

    const text = makeMsg("@cerberus text");
    const memo = makeMsg("@cerberus", {
      attachments: [
        { id: "att-83", filename: "voice.ogg", content_type: "audio/ogg", url: AUDIO_URL, size: 2048 },
      ],
    });
    state.posted[CHAN_A.id].push(text, memo);
    // The in-memory cursor is already past both messages here; nothing is printed.
    let duringPrepare: string | null = null;
    state.onStt = () => {
      duringPrepare = readCursor().channels[CHAN_A.id];
    };
    expect(await runCycle("doorbell")).toEqual([text.id, memo.id]);
    expect(duringPrepare!).toBe(before);
    expect(readCursor().channels[CHAN_A.id]).toBe(memo.id);
  });
});

describe("a failed delivery keeps the channel's previous entry (#83)", () => {
  test("MCP notifications that throw are not committed, so a restart delivers them", async () => {
    const state = fakeDiscord();
    await restart();
    await runCycle("mcp");
    const before = readCursor().channels[CHAN_A.id];

    const msg = makeMsg("@cerberus did this arrive?");
    state.posted[CHAN_A.id].push(msg);
    expect(await runCycle("mcp", { failNotify: true })).toEqual([]);
    expect(readCursor().channels[CHAN_A.id]).toBe(before);

    await restart();
    expect(await runCycle("mcp")).toEqual([msg.id]);
  });
});

describe.each(MODES)("unusable cursor falls back to the baseline (#83) — %s mode", (mode) => {
  async function savedThenDown(state: FakeState): Promise<DiscordMessage> {
    await restart();
    await runCycle(mode);
    const missed = makeMsg("@cerberus would only be seen via the cursor");
    state.posted[CHAN_A.id].push(missed);
    return missed;
  }

  test("a stale cursor (older than CURSOR_MAX_AGE_MS) is ignored with one log line", async () => {
    const state = fakeDiscord();
    await savedThenDown(state);
    const saved = readCursor();
    saved.saved_at = Date.now() - CURSOR_MAX_AGE_MS - 1000;
    writeFileSync(cursorPath(CERBERUS)!, JSON.stringify(saved));

    cursorLogs.length = 0;
    state.requests.length = 0;
    expect(await restart()).toBe(0);
    expect(baselineFetches(state)).toHaveLength(2);
    expect(await runCycle(mode)).toEqual([]);
    const ignored = cursorLogs.filter((l) => l.action === "ignored");
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toMatchObject({ level: "warn", reason: "stale" });
  });

  test("a cursor just inside CURSOR_MAX_AGE_MS still resumes", async () => {
    const state = fakeDiscord();
    const missed = await savedThenDown(state);
    const saved = readCursor();
    saved.saved_at = Date.now() - CURSOR_MAX_AGE_MS + 60_000;
    writeFileSync(cursorPath(CERBERUS)!, JSON.stringify(saved));
    expect(await restart()).toBe(2);
    expect(await runCycle(mode)).toEqual([missed.id]);
  });

  test.each([
    ["not JSON", "{\"version\":1,\"saved_at\":"],
    ["JSON null", "null"],
    ["a non-snowflake cursor", (s: CursorFile) => ({ ...s, channels: { [CHAN_A.id]: "../x" } })],
    ["an unknown version", (s: CursorFile) => ({ ...s, version: 2 })],
    ["a missing saved_at", (s: CursorFile) => ({ ...s, saved_at: undefined })],
  ] as const)("a corrupt cursor (%s) is ignored with one log line", async (_label, corrupt) => {
    const state = fakeDiscord();
    await savedThenDown(state);
    const content =
      typeof corrupt === "string" ? corrupt : JSON.stringify(corrupt(readCursor()));
    writeFileSync(cursorPath(CERBERUS)!, content);

    cursorLogs.length = 0;
    expect(await restart()).toBe(0);
    expect(await runCycle(mode)).toEqual([]);
    expect(cursorLogs.filter((l) => l.action === "ignored")).toHaveLength(1);
    // The next save replaces the bad file with a good one.
    expect(readCursor().version).toBe(1);
  });
});

describe("two identities (#83)", () => {
  test("each reads and writes only its own file", async () => {
    const state = fakeDiscord();
    await restart();
    await runCycle("doorbell");
    const cerberusFile = readFileSync(cursorPath(CERBERUS)!, "utf-8");

    // A message for hydra arrives; hydra starts with no cursor of its own.
    setIdentity(HYDRA);
    const forHydra = makeMsg("@hydra before your first start");
    state.posted[CHAN_A.id].push(forHydra);
    expect(await restart()).toBe(0); // cerberus's file is not hydra's
    expect(await runCycle("doorbell")).toEqual([]);
    expect(readCursor(HYDRA).dev_name).toBe("hydra");
    expect(readFileSync(cursorPath(CERBERUS)!, "utf-8")).toBe(cerberusFile);

    // Back to cerberus: it resumes from its own file, unchanged by hydra.
    setIdentity(CERBERUS);
    const forCerberus = makeMsg("@cerberus welcome back");
    state.posted[CHAN_B.id].push(forCerberus);
    expect(await restart()).toBe(2);
    expect(await runCycle("doorbell")).toEqual([forCerberus.id]);
  });

  test("a file whose identity fields name someone else is ignored", async () => {
    const state = fakeDiscord();
    setIdentity(HYDRA);
    await restart();
    await runCycle("doorbell");
    // Put hydra's cursor where cerberus's belongs (a name collision, or a copy).
    setIdentity(CERBERUS);
    mkdirSync(dirname(cursorPath(CERBERUS)!), { recursive: true });
    writeFileSync(cursorPath(CERBERUS)!, readFileSync(cursorPath(HYDRA)!, "utf-8"));
    state.posted[CHAN_A.id].push(makeMsg("@cerberus not via hydra's cursor"));

    cursorLogs.length = 0;
    expect(await restart()).toBe(0);
    expect(await runCycle("doorbell")).toEqual([]);
    expect(cursorLogs.filter((l) => l.action === "ignored")).toEqual([
      expect.objectContaining({ reason: "wrong identity" }),
    ]);
  });

  test("an unresolved identity neither loads nor saves", async () => {
    const state = fakeDiscord();
    await restart();
    await runCycle("doorbell");
    const cerberusFile = readFileSync(cursorPath(CERBERUS)!, "utf-8");

    setIdentity(null);
    state.posted[CHAN_A.id].push(makeMsg("@cerberus deaf"));
    cursorLogs.length = 0;
    expect(await restart()).toBe(0);
    expect(cursorLogs.filter((l) => l.action === "skipped")).toHaveLength(1);
    for (let i = 0; i < 3; i++) await runCycle("doorbell");
    // Nothing new in the state dir, and cerberus's file is untouched.
    expect(readdirSync(dirname(cursorPath(CERBERUS)!))).toEqual([
      "cursor-1486516321385578576-oaw-cerberus.json",
    ]);
    expect(readFileSync(cursorPath(CERBERUS)!, "utf-8")).toBe(cerberusFile);
  });
});

describe("api_base (#83)", () => {
  test("a cursor saved through scream-hole resumes in direct mode: the ids are Discord's either way", async () => {
    const state = fakeDiscord();
    const missed = makeMsg("@cerberus via either path");
    await restart();
    await runCycle("doorbell");
    const saved = readCursor();
    writeFileSync(cursorPath(CERBERUS)!, JSON.stringify({ ...saved, api_base: "scream-hole" }));
    state.posted[CHAN_A.id].push(missed);

    cursorLogs.length = 0;
    expect(await restart()).toBe(2);
    expect(await runCycle("doorbell")).toEqual([missed.id]);
    expect(cursorLogs.find((l) => l.action === "api_base_changed")).toMatchObject({
      from: "scream-hole",
      to: "direct",
    });
  });
});

describe("the cursor write is atomic (#83)", () => {
  test("a save replaces the file by rename and leaves no temp file", async () => {
    const state = fakeDiscord();
    await restart();
    await runCycle("doorbell");
    const path = cursorPath(CERBERUS)!;
    const oldContent = readFileSync(path, "utf-8");
    // Hold the old file open: a reader mid-read keeps its inode, so it can't be reused.
    const reader = openSync(path, "r");
    try {
      const msg = makeMsg("@cerberus move the cursor");
      state.posted[CHAN_A.id].push(msg);
      await runCycle("doorbell");
      expect(fstatSync(reader).ino).not.toBe(statSync(path).ino); // a new file, renamed in
      // The open reader still sees the whole old file: nothing was written in place.
      expect(readFileSync(reader, "utf-8")).toBe(oldContent);
      expect(readCursor().channels[CHAN_A.id]).toBe(msg.id);
    } finally {
      closeSync(reader);
    }
    expect(readdirSync(dirname(path))).toEqual([basename(path)]);
  });

  test("a failed write leaves the previous file whole, logs once, and polling goes on", async () => {
    const state = fakeDiscord();
    await restart();
    await runCycle("doorbell");
    const path = cursorPath(CERBERUS)!;
    const good = readFileSync(path, "utf-8");

    // Block the temp file: if the save wrote the target in place, this would not stop it.
    mkdirSync(`${path}.${process.pid}.tmp`);
    const m1 = makeMsg("@cerberus one");
    const m2 = makeMsg("@cerberus two");
    state.posted[CHAN_A.id].push(m1);
    cursorLogs.length = 0;
    expect(await runCycle("doorbell")).toEqual([m1.id]);
    state.posted[CHAN_A.id].push(m2);
    expect(await runCycle("doorbell")).toEqual([m2.id]);
    expect(readFileSync(path, "utf-8")).toBe(good);
    expect(cursorLogs.filter((l) => l.action === "save_failed")).toHaveLength(1);

    // Unblocked, the next save lands and says so.
    rmSync(`${path}.${process.pid}.tmp`, { recursive: true });
    saveCursor();
    expect(readCursor().channels[CHAN_A.id]).toBe(m2.id);
    expect(cursorLogs.filter((l) => l.action === "save_recovered")).toHaveLength(1);
  });
});

test("the state directory is created on first save, not before", async () => {
  fakeDiscord();
  const dir = dirname(cursorPath(CERBERUS)!);
  await restart();
  expect(existsSync(dir)).toBe(false);
  await runCycle("doorbell");
  expect(existsSync(cursorPath(CERBERUS)!)).toBe(true);
});
