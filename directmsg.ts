/**
 * //directmsg (#69) — the override lane that makes `disc forward` (#68) safe.
 *
 * A message tagged `//directmsg <target> <content>` (alias `//dm <target>`) is a
 * RED PHONE: a distilled must-see that must land on `<target>` regardless of any
 * forward rule. It is the escalate-back path — a grunt buried under a forwarded
 * firehose sends `//directmsg <main> "parked: X, need you"` and it reaches the
 * main agent even though the main agent forwards its own firehose to that grunt.
 *
 * MECHANISM — two touchpoints, both bypassing forward, composing with #68:
 *
 *   1. RECEIVE side (the piece that makes forward safe). At the watcher's
 *      notify step, a doorbell that is a `//directmsg` addressed to the LOCAL
 *      agent (its dev-name or dev-team) must NOT be swallowed by a forward rule
 *      — it falls through to the local notify path. Precedence is enforced by
 *      the caller ordering the checks `directmsg > forward > fanout`; this module
 *      supplies the single predicate {@link directMsgOverridesForward}. The
 *      addressing itself is unchanged — the `@<target>` mention is what makes the
 *      existing `shouldDeliverMessage` route the doorbell to the target's watcher
 *      in the first place, so the directmsg target and the addressee are one and
 *      the same. This module never touches `shouldDeliverMessage`.
 *
 *   2. SEND side. `discord-watcher directmsg <target> <content>` pushes a
 *      distilled ask straight to `<target>` via the deliver-router (#67) —
 *      channel → aoe send → file-drop — reaching the target even on a
 *      channels-disabled account, and bypassing forward by routing around
 *      Discord entirely. {@link sendDirectMsg}.
 *
 * PARSE — the sigil is `//` (two slashes), deliberately distinct from a `/skill`
 * invocation (one slash) and from an `@mention`. The alias `//dm` is matched on a
 * word boundary so `//dmx …` is NOT a directmsg. Distilled / red-phone are NORMS
 * (documented), not code — a directmsg is for genuine must-see only; overusing it
 * re-creates the firehose it bypasses.
 *
 * LOOP / ECHO GUARD (consistent with #68) — a re-circulated delivery that already
 * carries a forward header or a deliver-id marker is not re-interpreted as a
 * fresh directmsg, so a delivered payload can never bounce as a new override.
 */
import { normalizeToken, FORWARD_HEADER_PREFIX } from "./forward.ts";
import { deliver, defaultTransports } from "./deliver/index.ts";
import type { DeliveryTarget, DeliveryResult } from "./deliver/types.ts";

/** A parsed `//directmsg <target> <content>` verb. */
export interface DirectMsg {
  /** Normalized target token (dev-name or dev-team), `@`/`#` stripped, lowercased. */
  target: string;
  /** The distilled payload after the target token (trimmed, non-empty). */
  content: string;
}

/** The minimal identity view the override needs (mirrors AgentIdentity). */
export interface DirectMsgIdentity {
  devName?: string | null;
  devTeam?: string | null;
}

/** Logger shape the send helper writes to (matches mcp-logger / ForwardLogger). */
export interface DirectMsgLogger {
  info(event: string, data: Record<string, unknown>): void;
  warn(event: string, data: Record<string, unknown>): void;
  error(event: string, data: Record<string, unknown>, err?: string): void;
}

/**
 * The directmsg sigil: `//directmsg` or the `//dm` alias, case-insensitive, on a
 * word boundary. Two slashes distinguish it from a `/skill` invocation; the `//`
 * sigil distinguishes it from an `@mention`.
 */
const DIRECTMSG_SIGIL_RE = /^\/\/(?:directmsg|dm)\b\s*/i;

/** Marker the deliver-router stamps onto text-transport payloads (mirrors forward.ts). */
const DELIVER_MARKER_RE = /\[\[deliver-id:[^\]]+\]\]/;

/**
 * Parse `//directmsg <target> <content>` (or `//dm <target> <content>`). Returns
 * `null` when the content is not a well-formed directmsg (wrong sigil, no target,
 * or no content). Leading whitespace is tolerated; the sigil must otherwise start
 * the message so prose that merely mentions `//directmsg` is not misread.
 */
export function parseDirectMsg(raw: string): DirectMsg | null {
  const trimmed = raw.trimStart();
  const sigil = DIRECTMSG_SIGIL_RE.exec(trimmed);
  if (!sigil) return null;
  const rest = trimmed.slice(sigil[0].length);
  // <target> is the next whitespace-delimited token; the remainder is the body.
  const parts = /^(\S+)\s+([\s\S]+)$/.exec(rest);
  if (!parts) return null; // needs BOTH a target and a non-empty body
  const target = normalizeToken(parts[1]);
  const content = parts[2].trim();
  if (!target || !content) return null;
  return { target, content };
}

/**
 * Does this directmsg target the LOCAL agent — its dev-name or its dev-team?
 * Team match mirrors `shouldDeliverMessage`'s `@team` addressing so a
 * `//directmsg @<team> …` red-phone reaches every agent on the team.
 */
export function isDirectMsgForLocal(
  dm: DirectMsg,
  identity: DirectMsgIdentity
): boolean {
  const targets: string[] = [];
  if (identity.devName) targets.push(normalizeToken(identity.devName));
  if (identity.devTeam) targets.push(normalizeToken(identity.devTeam));
  return targets.includes(dm.target);
}

/**
 * Loop / echo guard (consistent with #68's {@link isForwardLoop}). A message that
 * already carries our forward header or a deliver-id marker is a re-circulated
 * delivery, not a fresh directmsg — treating it as one could bounce a delivery
 * around forever.
 */
export function isDirectMsgEcho(raw: string): boolean {
  return raw.includes(FORWARD_HEADER_PREFIX) || DELIVER_MARKER_RE.test(raw);
}

/**
 * The single precedence predicate the notify step consults: is this doorbell a
 * `//directmsg` addressed to the local agent that must override a forward rule?
 * True → the caller notifies the local agent directly and must NOT forward it.
 * A re-circulated delivery (echo) never overrides.
 */
export function directMsgOverridesForward(
  raw: string,
  identity: DirectMsgIdentity
): boolean {
  if (isDirectMsgEcho(raw)) return false;
  const dm = parseDirectMsg(raw);
  return dm !== null && isDirectMsgForLocal(dm, identity);
}

// --- Send side ---------------------------------------------------------------

/** Parse the `directmsg <target> <content...>` CLI argv into a target + body. */
export function parseDirectMsgArgs(
  args: string[]
): { target?: string; content?: string } {
  if (args.length < 2) return {};
  const [target, ...rest] = args;
  const content = rest.join(" ").trim();
  if (!target || !content) return {};
  return { target, content };
}

/** Injectable deps for {@link sendDirectMsg} (keeps it unit-testable). */
export interface SendDirectMsgDeps {
  /** The deliver-router (defaults to the real `deliver`). */
  deliverFn?: typeof deliver;
  /** Optional logger. */
  log?: DirectMsgLogger;
}

/**
 * Push a distilled directmsg straight to `<target>` via the deliver-router,
 * bypassing any forward rule on the target (it never touches Discord / the
 * target's poll loop). Uses the router's default transports; the CLI wires no
 * ChannelPoster, so selection falls to `aoe send → file-drop` (as `disc forward`
 * does) — the target is reached even on a channels-disabled account. The target
 * descriptor mirrors `disc forward`: `<target>` populates the
 * aoe `session` (and `label` for logs). Never throws — a failed delivery is
 * reported in the {@link DeliveryResult}. The deliver-router mints the
 * idempotency id when one is not supplied.
 */
export async function sendDirectMsg(
  target: string,
  content: string,
  deps: SendDirectMsgDeps = {}
): Promise<DeliveryResult> {
  const deliverFn = deps.deliverFn ?? deliver;
  const deliveryTarget: DeliveryTarget = { label: target, session: target };
  const result = await deliverFn(deliveryTarget, content, {
    transports: defaultTransports(),
  });
  deps.log?.[result.ok ? "info" : "warn"]("directmsg", {
    to: target,
    transport: result.transport,
    ok: result.ok,
    id: result.id,
    ...(result.error ? { error: result.error } : {}),
  });
  return result;
}
