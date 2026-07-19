/**
 * disc forward (#68) tests — the per-forwarder local rule, the forward decision
 * (exclude gate + loop guard), the no-rule passthrough, rule-file I/O, and the
 * guarded runtime forward helper.
 *
 * Pure logic is tested directly; the one true boundary (the deliver-router POST
 * and the Discord fetch) is injected, matching the repo's "mock only real
 * boundaries" convention.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseForwardArgs,
  resolveForwardRule,
  writeForwardRule,
  clearForwardRule,
  forwardRulePath,
  isExcludedFromForward,
  isForwardLoop,
  shouldForward,
  forwardMessage,
  shouldFallbackToLocalNotify,
  forwardHeader,
  normalizeToken,
  type ForwardRule,
  type ForwardableMessage,
  type ForwardableChannel,
  type ForwardOutcome,
} from "../forward.ts";
import { refreshForwardRule, currentForwardRule } from "../index.ts";
import type { DeliveryResult, DeliveryTarget } from "../deliver/types.ts";

// --- Fixtures ----------------------------------------------------------------

function makeMsg(overrides: Partial<ForwardableMessage> = {}): ForwardableMessage {
  return {
    id: "msg-1",
    author: { username: "alice" },
    content: "hello",
    ...overrides,
  };
}

const CH: ForwardableChannel = { id: "chan-100", name: "general" };

function rule(overrides: Partial<ForwardRule> = {}): ForwardRule {
  return {
    target: { label: "grunt-oaw-1", session: "grunt-oaw-1" },
    exclude: [],
    ...overrides,
  };
}

// --- parseForwardArgs --------------------------------------------------------

describe("parseForwardArgs", () => {
  test("target only → session+label from target, empty exclude", () => {
    const { rule, off } = parseForwardArgs(["grunt-oaw-1"]);
    expect(off).toBeUndefined();
    expect(rule?.target).toEqual({ label: "grunt-oaw-1", session: "grunt-oaw-1" });
    expect(rule?.exclude).toEqual([]);
  });

  test("target + --exclude splits and trims the list", () => {
    const { rule } = parseForwardArgs(["grunt", "--exclude", "oaw, roll-call ,brian"]);
    expect(rule?.exclude).toEqual(["oaw", "roll-call", "brian"]);
  });

  test("--exclude=a,b inline form", () => {
    const { rule } = parseForwardArgs(["grunt", "--exclude=general,alice"]);
    expect(rule?.exclude).toEqual(["general", "alice"]);
  });

  test("--off → clear", () => {
    expect(parseForwardArgs(["--off"])).toEqual({ off: true });
    expect(parseForwardArgs(["off"])).toEqual({ off: true });
  });

  test("empty argv → neither install nor clear", () => {
    expect(parseForwardArgs([])).toEqual({});
  });

  test("flags with no target → no rule", () => {
    expect(parseForwardArgs(["--exclude", "a,b"]).rule).toBeUndefined();
  });
});

// --- rule file I/O roundtrip -------------------------------------------------

describe("forward rule file I/O", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fwd-"));
    path = join(dir, "discord-forward.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("write → resolve roundtrip", () => {
    const r = rule({ exclude: ["oaw", "brian"] });
    writeForwardRule(r, path);
    expect(existsSync(path)).toBe(true);
    expect(resolveForwardRule(path)).toEqual(r);
  });

  test("write creates missing parent dir", () => {
    const nested = join(dir, "sub", "discord-forward.json");
    writeForwardRule(rule(), nested);
    expect(existsSync(nested)).toBe(true);
  });

  test("clear removes the rule and reports presence", () => {
    writeForwardRule(rule(), path);
    expect(clearForwardRule(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
    // second clear → nothing was there
    expect(clearForwardRule(path)).toBe(false);
  });

  test("absent file → null (the no-rule passthrough condition)", () => {
    expect(resolveForwardRule(path)).toBeNull();
  });

  test("malformed JSON → null (fail-safe, never throws)", () => {
    writeFileSync(path, "{ not json");
    expect(resolveForwardRule(path)).toBeNull();
  });

  test("non-addressable target (label only) → null", () => {
    writeFileSync(path, JSON.stringify({ target: { label: "x" }, exclude: [] }));
    expect(resolveForwardRule(path)).toBeNull();
  });

  test("target with dir only is addressable (file-drop floor)", () => {
    writeFileSync(path, JSON.stringify({ target: { dir: "/tmp/grunt" }, exclude: [] }));
    expect(resolveForwardRule(path)).toEqual({ target: { dir: "/tmp/grunt" }, exclude: [] });
  });

  test("non-string exclude entries are dropped", () => {
    writeFileSync(
      path,
      JSON.stringify({ target: { session: "g" }, exclude: ["ok", 42, null, "also"] })
    );
    expect(resolveForwardRule(path)?.exclude).toEqual(["ok", "also"]);
  });

  test("forwardRulePath honors a passed home", () => {
    expect(forwardRulePath("/home/x")).toBe("/home/x/.claude/discord-forward.json");
  });
});

// --- normalizeToken ----------------------------------------------------------

describe("normalizeToken", () => {
  test("lowercases and strips a leading @ or #", () => {
    expect(normalizeToken("@Alice")).toBe("alice");
    expect(normalizeToken("#General")).toBe("general");
    expect(normalizeToken("  RollCall ")).toBe("rollcall");
  });
});

// --- the exclude gate --------------------------------------------------------

describe("isExcludedFromForward", () => {
  test("empty exclude → never excluded", () => {
    expect(isExcludedFromForward(makeMsg(), CH, rule())).toBe(false);
  });

  test("excludes by channel name", () => {
    expect(isExcludedFromForward(makeMsg(), CH, rule({ exclude: ["general"] }))).toBe(true);
  });

  test("excludes by channel id", () => {
    expect(isExcludedFromForward(makeMsg(), CH, rule({ exclude: ["chan-100"] }))).toBe(true);
  });

  test("excludes by author", () => {
    expect(
      isExcludedFromForward(makeMsg({ author: { username: "brian" } }), CH, rule({ exclude: ["brian"] }))
    ).toBe(true);
  });

  test("match is normalized (@/# prefix + case)", () => {
    expect(isExcludedFromForward(makeMsg(), CH, rule({ exclude: ["#General"] }))).toBe(true);
    expect(
      isExcludedFromForward(makeMsg({ author: { username: "Alice" } }), CH, rule({ exclude: ["@alice"] }))
    ).toBe(true);
  });

  test("no match → not excluded", () => {
    expect(isExcludedFromForward(makeMsg(), CH, rule({ exclude: ["other", "someone"] }))).toBe(false);
  });
});

// --- the loop guard ----------------------------------------------------------

describe("isForwardLoop", () => {
  test("author == target session/label → loop (target's own post back)", () => {
    const msg = makeMsg({ author: { username: "grunt-oaw-1" } });
    expect(isForwardLoop(msg, rule())).toBe(true);
  });

  test("content carrying the forward header → loop (echoed forward)", () => {
    const msg = makeMsg({ content: `${forwardHeader("bob", "ops")}\nre-posted` });
    expect(isForwardLoop(msg, rule())).toBe(true);
  });

  test("content carrying a deliver-id marker → loop", () => {
    const msg = makeMsg({ content: "[[deliver-id:abc-123]]\nwhatever" });
    expect(isForwardLoop(msg, rule())).toBe(true);
  });

  test("ordinary message from a third party → not a loop", () => {
    expect(isForwardLoop(makeMsg(), rule())).toBe(false);
  });
});

// --- the composite forward decision -----------------------------------------

describe("shouldForward", () => {
  test("ordinary addressed doorbell → forward", () => {
    expect(shouldForward(makeMsg(), CH, rule())).toBe(true);
  });

  test("excluded channel → do NOT forward (stays with local agent)", () => {
    expect(shouldForward(makeMsg(), CH, rule({ exclude: ["general"] }))).toBe(false);
  });

  test("excluded author → do NOT forward", () => {
    expect(
      shouldForward(makeMsg({ author: { username: "brian" } }), CH, rule({ exclude: ["brian"] }))
    ).toBe(false);
  });

  test("loop/echo → do NOT forward", () => {
    expect(shouldForward(makeMsg({ author: { username: "grunt-oaw-1" } }), CH, rule())).toBe(false);
  });
});

// --- the guarded runtime forward helper -------------------------------------

describe("forwardMessage", () => {
  function fakeDeliver(result: Partial<DeliveryResult> = {}) {
    const calls: Array<{ target: DeliveryTarget; content: string; opts?: { id?: string } }> = [];
    const fn = async (target: DeliveryTarget, content: string, opts?: { id?: string }) => {
      calls.push({ target, content, opts });
      return { ok: true, transport: "aoe", id: opts?.id ?? "x", ...result } as DeliveryResult;
    };
    return { fn, calls };
  }

  test("found → fetches full content, delivers it with header + msg.id idempotency", async () => {
    const { fn, calls } = fakeDeliver();
    const out = await forwardMessage(rule(), CH, makeMsg({ id: "m-42" }), "Bot t", {
      fetchMessage: async () => ({ kind: "found", message: { content: "the full body" } }),
      deliverFn: fn as any,
    });
    expect(out.forwarded).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].target).toEqual(rule().target);
    expect(calls[0].content).toContain("the full body");
    expect(calls[0].content).toContain(forwardHeader("alice", "general"));
    expect(calls[0].opts?.id).toBe("m-42"); // idempotency = Discord message id
  });

  test("gone (identified deletion) → dropped, deliver never called, no local fallback", async () => {
    const { fn, calls } = fakeDeliver();
    const out = await forwardMessage(rule(), CH, makeMsg(), "Bot t", {
      fetchMessage: async () => ({ kind: "gone" }),
      deliverFn: fn as any,
    });
    expect(out).toEqual({ forwarded: false, reason: "gone" });
    expect(calls).toHaveLength(0);
    expect(shouldFallbackToLocalNotify(out)).toBe(false);
  });

  test("error (transient) → not forwarded, deliver never called, falls back to local notify", async () => {
    const { fn, calls } = fakeDeliver();
    const out = await forwardMessage(rule(), CH, makeMsg(), "Bot t", {
      fetchMessage: async () => ({ kind: "error" }),
      deliverFn: fn as any,
    });
    expect(out).toEqual({ forwarded: false, reason: "fetch_error" });
    expect(calls).toHaveLength(0);
    expect(shouldFallbackToLocalNotify(out)).toBe(true);
  });

  test("a delivery failure is reported, not thrown (poll-loop safe)", async () => {
    const out = await forwardMessage(rule(), CH, makeMsg(), "Bot t", {
      fetchMessage: async () => ({ kind: "found", message: { content: "body" } }),
      deliverFn: (async () => ({ ok: false, transport: "aoe", id: "m", error: "aoe send exited 1" })) as any,
    });
    // NOT `forwarded: true` — the router reported ok:false, so the message never
    // reached the target (#46). Reporting it as forwarded made the caller skip
    // the local notify and the message was lost to target AND local agent.
    expect(out.forwarded).toBe(false);
    if (!out.forwarded) {
      expect(out.reason).toBe("deliver_error");
      expect(out.result?.error).toBe("aoe send exited 1");
    }
  });

  test("delivery failure → falls back to local notify (message not lost, #46)", async () => {
    const out = await forwardMessage(rule(), CH, makeMsg(), "Bot t", {
      fetchMessage: async () => ({ kind: "found", message: { content: "body" } }),
      deliverFn: (async () => ({ ok: false, transport: "aoe", id: "m", error: "aoe send exited 1" })) as any,
    });
    expect(shouldFallbackToLocalNotify(out)).toBe(true);
  });

  test("no available transport → deliver_error, falls back to local notify", async () => {
    const out = await forwardMessage(rule(), CH, makeMsg(), "Bot t", {
      fetchMessage: async () => ({ kind: "found", message: { content: "body" } }),
      deliverFn: (async () => ({
        ok: false,
        transport: "none",
        id: "m",
        error: "no available transport",
      })) as any,
    });
    expect(out.forwarded).toBe(false);
    if (!out.forwarded) expect(out.reason).toBe("deliver_error");
    expect(shouldFallbackToLocalNotify(out)).toBe(true);
  });

  test("a SUCCESSFUL delivery still suppresses local notify (no double-delivery)", async () => {
    const { fn } = fakeDeliver();
    const out = await forwardMessage(rule(), CH, makeMsg(), "Bot t", {
      fetchMessage: async () => ({ kind: "found", message: { content: "body" } }),
      deliverFn: fn as any,
    });
    expect(out.forwarded).toBe(true);
    expect(shouldFallbackToLocalNotify(out)).toBe(false);
  });

  test("an exception in fetch/deliver is swallowed (never crashes the loop)", async () => {
    const out = await forwardMessage(rule(), CH, makeMsg(), "Bot t", {
      fetchMessage: async () => {
        throw new Error("boom");
      },
    });
    expect(out).toEqual({ forwarded: false, reason: "exception" });
  });
});

// --- shouldFallbackToLocalNotify: the transient-error fall-through decision --

describe("shouldFallbackToLocalNotify", () => {
  test("transient fetch error → fall back to local notify", () => {
    const out: ForwardOutcome = { forwarded: false, reason: "fetch_error" };
    expect(shouldFallbackToLocalNotify(out)).toBe(true);
  });

  test("failed delivery → fall back to local notify (#46)", () => {
    const out: ForwardOutcome = { forwarded: false, reason: "deliver_error" };
    expect(shouldFallbackToLocalNotify(out)).toBe(true);
  });

  test("identified deletion (gone) → drop, do NOT notify local", () => {
    const out: ForwardOutcome = { forwarded: false, reason: "gone" };
    expect(shouldFallbackToLocalNotify(out)).toBe(false);
  });

  test("unexpected exception → drop, do NOT notify local", () => {
    const out: ForwardOutcome = { forwarded: false, reason: "exception" };
    expect(shouldFallbackToLocalNotify(out)).toBe(false);
  });

  test("delivered → already reached the target, do NOT notify local", () => {
    const out: ForwardOutcome = {
      forwarded: true,
      result: { ok: true, transport: "aoe", id: "m" } as DeliveryResult,
    };
    expect(shouldFallbackToLocalNotify(out)).toBe(false);
  });
});

// --- index integration: live re-read + no-rule passthrough ------------------

describe("refreshForwardRule (live re-read)", () => {
  const path = forwardRulePath();
  let saved: string | null = null;

  beforeEach(() => {
    // Preserve any real rule file so the test never clobbers the operator's.
    saved = existsSync(path) ? require("node:fs").readFileSync(path, "utf-8") : null;
    clearForwardRule(path);
    refreshForwardRule(); // settle cache to null
  });
  afterEach(() => {
    clearForwardRule(path);
    if (saved !== null) writeFileSync(path, saved);
    refreshForwardRule();
  });

  test("no rule file → currentForwardRule() is null (the passthrough)", () => {
    expect(currentForwardRule()).toBeNull();
  });

  test("writing a rule → next refresh picks it up; clearing → back to null", () => {
    writeForwardRule(rule({ exclude: ["oaw"] }), path);
    expect(refreshForwardRule()).toBe(true);
    expect(currentForwardRule()?.target.label).toBe("grunt-oaw-1");
    expect(currentForwardRule()?.exclude).toEqual(["oaw"]);

    clearForwardRule(path);
    expect(refreshForwardRule()).toBe(true);
    expect(currentForwardRule()).toBeNull();
  });
});
