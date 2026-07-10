/**
 * //directmsg (#69) tests — the override lane that makes `disc forward` safe.
 *
 * Covers the parse (sigil `//`, `//dm` alias, distinct from `/skill` and
 * `@mention`), the local-target match, the loop/echo guard, the send-side
 * deliver-router push, and — the crux — the notify-step precedence
 * (`directmsg > forward > fanout`) as exercised by `decideNotifyRoute`:
 *   - a directmsg for the local agent BYPASSES an active forward rule,
 *   - the ordinary (no-directmsg) path is unchanged from #68,
 *   - a re-circulated echo never counts as an override.
 *
 * Pure logic is tested directly; the one true boundary (the deliver-router POST)
 * is injected, matching the repo's "mock only real boundaries" convention.
 */
import { describe, test, expect } from "bun:test";
import {
  parseDirectMsg,
  isDirectMsgForLocal,
  isDirectMsgEcho,
  directMsgOverridesForward,
  parseDirectMsgArgs,
  sendDirectMsg,
} from "../directmsg.ts";
import { forwardHeader } from "../forward.ts";
import type {
  ForwardRule,
  ForwardableMessage,
  ForwardableChannel,
} from "../forward.ts";
import { decideNotifyRoute } from "../index.ts";
import type { AgentIdentity } from "../index.ts";
import type { DeliveryResult, DeliveryTarget } from "../deliver/types.ts";

// --- Fixtures ----------------------------------------------------------------

// Typed as AgentIdentity (the real call site's type) — assignable to the wider
// DirectMsgIdentity the pure predicates accept, so it serves both.
const LOCAL: AgentIdentity = { devName: "sanford", devTeam: "oaw" };

function makeMsg(overrides: Partial<ForwardableMessage> = {}): ForwardableMessage {
  return {
    id: "msg-1",
    author: { username: "carol" }, // a third party (not the forward target)
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

// --- parseDirectMsg ----------------------------------------------------------

describe("parseDirectMsg", () => {
  test("//directmsg <target> <content> → target + body", () => {
    expect(parseDirectMsg("//directmsg @sanford parked: X, need you")).toEqual({
      target: "sanford",
      content: "parked: X, need you",
    });
  });

  test("//dm alias parses the same", () => {
    expect(parseDirectMsg("//dm sanford ping")).toEqual({
      target: "sanford",
      content: "ping",
    });
  });

  test("sigil + alias are case-insensitive", () => {
    expect(parseDirectMsg("//DirectMsg @Sanford hey")?.target).toBe("sanford");
    expect(parseDirectMsg("//DM sanford hey")?.content).toBe("hey");
  });

  test("target token is normalized (@/# stripped, lowercased)", () => {
    expect(parseDirectMsg("//dm @Sanford x")?.target).toBe("sanford");
    expect(parseDirectMsg("//dm #oaw x")?.target).toBe("oaw");
  });

  test("leading whitespace is tolerated", () => {
    expect(parseDirectMsg("   //dm sanford hi")?.target).toBe("sanford");
  });

  test("multi-word body is preserved and trimmed", () => {
    expect(parseDirectMsg("//dm sanford   a b c   ")?.content).toBe("a b c");
  });

  // --- distinctness from neighbouring sigils ---
  test("a single-slash /skill is NOT a directmsg", () => {
    expect(parseDirectMsg("/directmsg sanford x")).toBeNull();
    expect(parseDirectMsg("/dm sanford x")).toBeNull();
  });

  test("a bare @mention is NOT a directmsg", () => {
    expect(parseDirectMsg("@sanford please look")).toBeNull();
  });

  test("//dm must be on a word boundary (//dmx is not the alias)", () => {
    expect(parseDirectMsg("//dmx sanford x")).toBeNull();
    expect(parseDirectMsg("//directmsgs sanford x")).toBeNull();
  });

  test("prose that merely mentions //directmsg mid-line does not parse", () => {
    expect(parseDirectMsg("use the //directmsg lane for must-see")).toBeNull();
  });

  test("no body (target only) → null (a red-phone always carries a signal)", () => {
    expect(parseDirectMsg("//dm sanford")).toBeNull();
    expect(parseDirectMsg("//directmsg @sanford   ")).toBeNull();
  });
});

// --- isDirectMsgForLocal -----------------------------------------------------

describe("isDirectMsgForLocal", () => {
  test("matches the local dev-name", () => {
    expect(isDirectMsgForLocal({ target: "sanford", content: "x" }, LOCAL)).toBe(true);
  });

  test("matches the local dev-team (a //directmsg @team red-phone)", () => {
    expect(isDirectMsgForLocal({ target: "oaw", content: "x" }, LOCAL)).toBe(true);
  });

  test("a different target → not for the local agent", () => {
    expect(isDirectMsgForLocal({ target: "other", content: "x" }, LOCAL)).toBe(false);
  });

  test("unresolved identity → never a local target", () => {
    expect(
      isDirectMsgForLocal({ target: "sanford", content: "x" }, { devName: null, devTeam: null })
    ).toBe(false);
  });
});

// --- isDirectMsgEcho (loop/echo guard) --------------------------------------

describe("isDirectMsgEcho", () => {
  test("content carrying the forward header → echo", () => {
    expect(isDirectMsgEcho(`${forwardHeader("bob", "ops")}\n//dm sanford x`)).toBe(true);
  });

  test("content carrying a deliver-id marker → echo", () => {
    expect(isDirectMsgEcho("[[deliver-id:abc-123]] //dm sanford x")).toBe(true);
  });

  test("an ordinary directmsg → not an echo", () => {
    expect(isDirectMsgEcho("//dm sanford parked: X")).toBe(false);
  });
});

// --- directMsgOverridesForward ----------------------------------------------

describe("directMsgOverridesForward", () => {
  test("a directmsg for the local agent overrides", () => {
    expect(directMsgOverridesForward("//dm @sanford urgent", LOCAL)).toBe(true);
    expect(directMsgOverridesForward("//directmsg @oaw urgent", LOCAL)).toBe(true);
  });

  test("a directmsg for a DIFFERENT target does not override", () => {
    expect(directMsgOverridesForward("//dm @someone-else urgent", LOCAL)).toBe(false);
  });

  test("an ordinary (non-directmsg) doorbell does not override", () => {
    expect(directMsgOverridesForward("hey @sanford take a look", LOCAL)).toBe(false);
  });

  test("a re-circulated echo never overrides (loop guard)", () => {
    // Even though it targets the local agent, the deliver marker marks it as an
    // already-delivered payload — treating it as a fresh directmsg could loop.
    expect(
      directMsgOverridesForward("[[deliver-id:x]] //dm @sanford urgent", LOCAL)
    ).toBe(false);
    expect(
      directMsgOverridesForward(`${forwardHeader("bob", "ops")}\n//dm @sanford urgent`, LOCAL)
    ).toBe(false);
  });
});

// --- decideNotifyRoute: the notify-step precedence (directmsg > forward > fanout)

describe("decideNotifyRoute", () => {
  // (1) THE CRUX — the override bypasses an ACTIVE forward rule.
  test("a local directmsg under an active forward rule → notify (bypasses forward)", () => {
    const dm = makeMsg({ content: "//dm @sanford parked: X, need you" });
    // Without the override this ordinary third-party doorbell WOULD be forwarded
    // (see the passthrough test below) — the directmsg punches through instead.
    expect(decideNotifyRoute(dm, CH, rule(), LOCAL)).toBe("notify");
  });

  // (2) precedence: directmsg wins over a rule that otherwise forwards.
  test("directmsg > forward — a @team red-phone also overrides", () => {
    const dm = makeMsg({ content: "//directmsg @oaw all-hands: prod is down" });
    expect(decideNotifyRoute(dm, CH, rule(), LOCAL)).toBe("notify");
  });

  test("a directmsg NOT for the local agent does not override this agent's rule", () => {
    const dm = makeMsg({ content: "//dm @someone-else fyi" });
    // Not for us → the #68 forward decision stands (third party, not excluded).
    expect(decideNotifyRoute(dm, CH, rule(), LOCAL)).toBe("forward");
  });

  // (3) no-directmsg passthrough — unchanged from #68.
  test("ordinary doorbell + active rule → forward (unchanged #68 path)", () => {
    expect(decideNotifyRoute(makeMsg(), CH, rule(), LOCAL)).toBe("forward");
  });

  test("ordinary doorbell + NO rule → notify (byte-for-byte today's path)", () => {
    expect(decideNotifyRoute(makeMsg(), CH, null, LOCAL)).toBe("notify");
  });

  test("even a directmsg + NO rule → notify (nothing to override; same outcome)", () => {
    const dm = makeMsg({ content: "//dm @sanford hi" });
    expect(decideNotifyRoute(dm, CH, null, LOCAL)).toBe("notify");
  });

  test("excluded doorbell + active rule → notify (the #68 allowlist, unchanged)", () => {
    expect(decideNotifyRoute(makeMsg(), CH, rule({ exclude: ["general"] }), LOCAL)).toBe("notify");
  });

  // (4) loop/echo guard at the routing seam.
  test("a directmsg-shaped echo does not override, and its markers keep it un-forwarded", () => {
    // Carries a deliver marker → not an override (echo) AND the #68 loop guard
    // also refuses to forward marker-bearing content → notify locally.
    const echo = makeMsg({ content: "[[deliver-id:x]] //dm @sanford urgent" });
    expect(decideNotifyRoute(echo, CH, rule(), LOCAL)).toBe("notify");
  });

  test("a forward-target's own post is still a #68 loop → notify (guard intact)", () => {
    const back = makeMsg({ author: { username: "grunt-oaw-1" }, content: "ack" });
    expect(decideNotifyRoute(back, CH, rule(), LOCAL)).toBe("notify");
  });
});

// --- parseDirectMsgArgs (send-side CLI) --------------------------------------

describe("parseDirectMsgArgs", () => {
  test("target + multi-word content", () => {
    expect(parseDirectMsgArgs(["main-agent", "parked:", "X,", "need", "you"])).toEqual({
      target: "main-agent",
      content: "parked: X, need you",
    });
  });

  test("target with no content → nothing (a red-phone carries a signal)", () => {
    expect(parseDirectMsgArgs(["main-agent"])).toEqual({});
    expect(parseDirectMsgArgs([])).toEqual({});
  });
});

// --- sendDirectMsg (rides the deliver-router) --------------------------------

describe("sendDirectMsg", () => {
  function fakeDeliver(result: Partial<DeliveryResult> = {}) {
    const calls: Array<{ target: DeliveryTarget; content: string; opts?: { id?: string } }> = [];
    const fn = async (target: DeliveryTarget, content: string, opts?: { id?: string }) => {
      calls.push({ target, content, opts });
      return { ok: true, transport: "aoe", id: opts?.id ?? "minted", ...result } as DeliveryResult;
    };
    return { fn, calls };
  }

  test("delivers the content to <target> as a session+label target via deliver()", async () => {
    const { fn, calls } = fakeDeliver();
    const res = await sendDirectMsg("main-agent", "parked: X", { deliverFn: fn as any });
    expect(calls).toHaveLength(1);
    expect(calls[0].target).toEqual({ label: "main-agent", session: "main-agent" });
    expect(calls[0].content).toBe("parked: X");
    expect(res.ok).toBe(true);
    expect(res.transport).toBe("aoe");
  });

  test("a delivery failure is reported, not thrown", async () => {
    const res = await sendDirectMsg("nobody", "x", {
      deliverFn: (async () => ({
        ok: false,
        transport: "none",
        id: "y",
        error: "no available transport",
      })) as any,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no available transport");
  });
});
