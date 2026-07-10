/**
 * deliver-router tests (mcp-server-discord #67).
 *
 * Exercises the real router + transports; only the true external boundaries
 * (Discord POST, the `aoe` process, the filesystem) are faked, via the
 * transports' injected side-effects — matching the watcher's "mock only true
 * boundaries" convention.
 */
import { describe, test, expect } from "bun:test";
import {
  deliver,
  defaultTransports,
  formatEnvelope,
  parseEnvelope,
  createDeduplicator,
  ChannelTransport,
  AoeTransport,
  FileDropTransport,
  safeIdFilename,
  DROP_SUBDIR,
  type ChannelPoster,
  type CommandRunner,
  type DropFs,
  type DeliveryTarget,
  type DeliveryEnvelope,
  type Transport,
} from "../deliver/index.ts";

// --- Fakes for the three external boundaries --------------------------------

function fakePoster() {
  const calls: Array<{ address: string; text: string }> = [];
  const poster: ChannelPoster = {
    async postMessage(address, text) {
      calls.push({ address, text });
    },
  };
  return { poster, calls };
}

function fakeRunner(exit: { code: number; stderr?: string } = { code: 0 }) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    return { code: exit.code, stderr: exit.stderr ?? "" };
  };
  return { runner, calls };
}

function fakeFs() {
  const store = new Map<string, string>();
  const mkdirs: string[] = [];
  const fs: DropFs = {
    exists: (p) => store.has(p),
    mkdirp: (p) => {
      mkdirs.push(p);
    },
    writeFile: (p, data) => {
      store.set(p, data);
    },
  };
  return { fs, store, mkdirs };
}

const FIXED_ID = "id-fixed-123";
const withFixedId = { newId: () => FIXED_ID };

// ---------------------------------------------------------------------------
// AC: order channels → aoe send → file-drop; first available wins
// ---------------------------------------------------------------------------

describe("deliver — availability-gated selection (order: channel → aoe → filedrop)", () => {
  function deps() {
    const p = fakePoster();
    const r = fakeRunner();
    const f = fakeFs();
    return { p, r, f, transports: defaultTransports({ poster: p.poster, runner: r.runner, fs: f.fs }) };
  }

  test("channels up → selects channel", async () => {
    const { p, r, f, transports } = deps();
    const target: DeliveryTarget = {
      channel: { enabled: true, address: "chan-1" },
      session: "sess-1",
      dir: "/home/agent",
    };
    const res = await deliver(target, "hello", { transports, ...withFixedId });

    expect(res.ok).toBe(true);
    expect(res.transport).toBe("channel");
    expect(res.address).toBe("chan-1");
    expect(p.calls).toHaveLength(1);
    // Selection, not fan-out: lower-priority transports were NOT touched.
    expect(r.calls).toHaveLength(0);
    expect(f.store.size).toBe(0);
  });

  test("channels disabled → falls to aoe send (lands on a channels-disabled account)", async () => {
    const { p, r, f, transports } = deps();
    const target: DeliveryTarget = {
      channel: { enabled: false, address: "chan-1" },
      session: "sess-1",
      dir: "/home/agent",
    };
    const res = await deliver(target, "hello", { transports, ...withFixedId });

    expect(res.ok).toBe(true);
    expect(res.transport).toBe("aoe");
    expect(res.address).toBe("sess-1");
    expect(p.calls).toHaveLength(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].file).toBe("aoe");
    // ts is irrelevant to the wire format — formatEnvelope only uses id + content.
    expect(r.calls[0].args).toEqual(["send", "sess-1", `[[deliver-id:${FIXED_ID}]]\nhello`]);
    expect(f.store.size).toBe(0);
  });

  test("channels disabled + no session → falls to file-drop (always-available floor)", async () => {
    const { p, r, f, transports } = deps();
    const target: DeliveryTarget = {
      channel: { enabled: false, address: "chan-1" },
      dir: "/home/agent",
    };
    const res = await deliver(target, "hello", { transports, ...withFixedId });

    expect(res.ok).toBe(true);
    expect(res.transport).toBe("filedrop");
    expect(res.address).toBe(`/home/agent/${DROP_SUBDIR}`);
    expect(p.calls).toHaveLength(0);
    expect(r.calls).toHaveLength(0);
    expect(f.store.size).toBe(1);
    expect([...f.store.keys()][0]).toBe(`/home/agent/${DROP_SUBDIR}/${FIXED_ID}.json`);
  });

  test("no transport available → ok:false, transport 'none'", async () => {
    const { transports } = deps();
    const res = await deliver({ channel: { enabled: false, address: "x" } }, "hi", {
      transports,
      ...withFixedId,
    });
    expect(res.ok).toBe(false);
    expect(res.transport).toBe("none");
    expect(res.error).toMatch(/no available transport/);
    expect(res.id).toBe(FIXED_ID);
  });
});

// ---------------------------------------------------------------------------
// Frozen decision: SELECTION, not retry — no delivery-ack reliance
// ---------------------------------------------------------------------------

describe("deliver — selection, not retry", () => {
  test("chosen transport fails → failure reported, NOT escalated to the next", async () => {
    const p = fakePoster();
    const r = fakeRunner();
    const f = fakeFs();
    // Channel is available but its send throws.
    const failingChannel: Transport = {
      name: "channel",
      available: () => true,
      resolveAddress: () => "chan-1",
      send: async () => {
        throw new Error("discord 503");
      },
    };
    const transports: Transport[] = [
      failingChannel,
      new AoeTransport(r.runner),
      new FileDropTransport(f.fs),
    ];
    const res = await deliver(
      { channel: { enabled: true, address: "chan-1" }, session: "sess-1", dir: "/home/agent" },
      "hello",
      { transports, ...withFixedId },
    );

    expect(res.ok).toBe(false);
    expect(res.transport).toBe("channel");
    expect(res.error).toMatch(/discord 503/);
    // Did NOT fall through — the lower transports were never invoked.
    expect(r.calls).toHaveLength(0);
    expect(f.store.size).toBe(0);
    // Unused fake keeps the linter honest.
    expect(p.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC: directed messages are idempotent (dedupe by message-id)
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  test("every delivery is stamped with an id (returned in the result)", async () => {
    const f = fakeFs();
    const res = await deliver({ dir: "/d" }, "x", { transports: [new FileDropTransport(f.fs)] });
    expect(res.id).toBeTruthy();
    expect(typeof res.id).toBe("string");
  });

  test("caller-supplied id wins over generated id", async () => {
    const f = fakeFs();
    const res = await deliver({ dir: "/d" }, "x", {
      id: "deploy-42",
      transports: [new FileDropTransport(f.fs)],
    });
    expect(res.id).toBe("deploy-42");
    expect([...f.store.keys()][0]).toBe(`/d/${DROP_SUBDIR}/deploy-42.json`);
  });

  test("file-drop is idempotent by construction: same id twice → one file, one write", async () => {
    const f = fakeFs();
    const transport = new FileDropTransport(f.fs);
    const target: DeliveryTarget = { dir: "/home/agent" };

    await deliver(target, "deploy now", { id: "deploy-42", transports: [transport] });
    await deliver(target, "deploy now", { id: "deploy-42", transports: [transport] });

    expect(f.store.size).toBe(1);
    // Second call short-circuits before mkdirp/write (id-file already present).
    expect(f.mkdirs).toHaveLength(1);
  });

  test("recipient deduplicator: same id delivered twice → acts once", () => {
    const dedupe = createDeduplicator();
    const id = "msg-abc";
    expect(dedupe.firstSeen(id)).toBe(true); // act
    expect(dedupe.firstSeen(id)).toBe(false); // skip
    expect(dedupe.firstSeen(id)).toBe(false); // skip
    expect(dedupe.has(id)).toBe(true);
  });

  test("deduplicator is bounded (oldest ids evicted past the cap)", () => {
    const dedupe = createDeduplicator(2);
    expect(dedupe.firstSeen("a")).toBe(true);
    expect(dedupe.firstSeen("b")).toBe(true);
    expect(dedupe.firstSeen("c")).toBe(true); // evicts "a"
    expect(dedupe.has("a")).toBe(false);
    expect(dedupe.has("b")).toBe(true);
    expect(dedupe.firstSeen("a")).toBe(true); // "a" seen as new again after eviction
  });
});

// ---------------------------------------------------------------------------
// Envelope format (the text-transport idempotency marker)
// ---------------------------------------------------------------------------

describe("envelope format", () => {
  const env: DeliveryEnvelope = { id: "abc-123", content: "line1\nline2", ts: "2026-07-10T00:00:00.000Z" };

  test("formats an id marker on its own line", () => {
    expect(formatEnvelope(env)).toBe("[[deliver-id:abc-123]]\nline1\nline2");
  });

  test("parse is the inverse of format", () => {
    const parsed = parseEnvelope(formatEnvelope(env));
    expect(parsed.id).toBe("abc-123");
    expect(parsed.content).toBe("line1\nline2");
  });

  test("parse of un-marked text yields id null, content unchanged", () => {
    const parsed = parseEnvelope("just a message");
    expect(parsed.id).toBeNull();
    expect(parsed.content).toBe("just a message");
  });
});

// ---------------------------------------------------------------------------
// Per-transport unit behavior (each pluggable behind the interface)
// ---------------------------------------------------------------------------

describe("ChannelTransport", () => {
  test("available iff enabled && address present", () => {
    const t = new ChannelTransport(fakePoster().poster);
    expect(t.available({ channel: { enabled: true, address: "c" } })).toBe(true);
    expect(t.available({ channel: { enabled: false, address: "c" } })).toBe(false);
    expect(t.available({ channel: { enabled: true, address: "" } })).toBe(false);
    expect(t.available({})).toBe(false);
  });

  test("send posts the formatted envelope to the resolved address", async () => {
    const p = fakePoster();
    const t = new ChannelTransport(p.poster);
    await t.send({ channel: { enabled: true, address: "chan-9" } }, { id: "i1", content: "yo", ts: "t" });
    expect(p.calls[0].address).toBe("chan-9");
    expect(p.calls[0].text).toBe("[[deliver-id:i1]]\nyo");
  });
});

describe("AoeTransport", () => {
  test("available iff a session is named", () => {
    const t = new AoeTransport(fakeRunner().runner);
    expect(t.available({ session: "s" })).toBe(true);
    expect(t.available({ session: "" })).toBe(false);
    expect(t.available({})).toBe(false);
  });

  test("shells `aoe send <session> <formatted-message>` (auto-revive default)", async () => {
    const r = fakeRunner();
    const t = new AoeTransport(r.runner);
    await t.send({ session: "morpheus" }, { id: "i2", content: "wake up", ts: "t" });
    expect(r.calls[0].file).toBe("aoe");
    expect(r.calls[0].args).toEqual(["send", "morpheus", "[[deliver-id:i2]]\nwake up"]);
    // Auto-revive is the default — no --no-revive flag.
    expect(r.calls[0].args).not.toContain("--no-revive");
  });

  test("non-zero exit throws (surfaced as a delivery failure)", async () => {
    const r = fakeRunner({ code: 1, stderr: "no such session" });
    const t = new AoeTransport(r.runner);
    await expect(t.send({ session: "ghost" }, { id: "i3", content: "x", ts: "t" })).rejects.toThrow(
      /aoe send exited 1: no such session/,
    );
  });
});

describe("FileDropTransport", () => {
  test("always available when a dir is given", () => {
    const t = new FileDropTransport(fakeFs().fs);
    expect(t.available({ dir: "/x" })).toBe(true);
    expect(t.available({ dir: "" })).toBe(false);
    expect(t.available({})).toBe(false);
  });

  test("resolveAddress is the <dir>/.deliveries drop directory", () => {
    const t = new FileDropTransport(fakeFs().fs);
    expect(t.resolveAddress({ dir: "/home/agent" })).toBe(`/home/agent/${DROP_SUBDIR}`);
    expect(t.resolveAddress({})).toBeNull();
  });

  test("writes the full JSON envelope keyed by id", async () => {
    const f = fakeFs();
    const t = new FileDropTransport(f.fs);
    const env: DeliveryEnvelope = { id: "i4", content: "payload", ts: "2026-07-10T00:00:00.000Z" };
    await t.send({ dir: "/home/agent" }, env);
    const written = f.store.get(`/home/agent/${DROP_SUBDIR}/i4.json`);
    expect(written).toBeDefined();
    expect(JSON.parse(written!)).toEqual(env);
  });
});

describe("safeIdFilename (path-traversal hardening)", () => {
  test("strips path separators and dot-escapes", () => {
    expect(safeIdFilename("../../etc/passwd")).not.toContain("/");
    expect(safeIdFilename("../../etc/passwd")).not.toMatch(/^\./);
    expect(safeIdFilename("a/b\\c")).toBe("a_b_c");
  });
  test("leaves a plain uuid untouched", () => {
    expect(safeIdFilename("2f8a1c9e-0000-4aaa-bbbb-ccccdddd0001")).toBe(
      "2f8a1c9e-0000-4aaa-bbbb-ccccdddd0001",
    );
  });
  test("empty / all-illegal id degrades to a safe token", () => {
    expect(safeIdFilename("")).toBe("_");
    expect(safeIdFilename("///")).not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// defaultTransports wiring
// ---------------------------------------------------------------------------

describe("defaultTransports", () => {
  test("omits the channel transport when no poster is supplied", () => {
    const names = defaultTransports().map((t) => t.name);
    expect(names).toEqual(["aoe", "filedrop"]);
  });
  test("includes channel first when a poster is supplied", () => {
    const names = defaultTransports({ poster: fakePoster().poster }).map((t) => t.name);
    expect(names).toEqual(["channel", "aoe", "filedrop"]);
  });
});
