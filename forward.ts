/**
 * disc forward (#68) — grunt-as-receptionist.
 *
 * A per-forwarder LOCAL rule: "forward my doorbells to <target>, except this
 * exclude-list." When a rule is active, a doorbell that would have woken THIS
 * agent is instead fetched in full and delivered to <target> via the
 * deliver-router (#67) — unless it is excluded, in which case it wakes the local
 * agent exactly as today. `--exclude` is the local agent's allowlist: traffic
 * that still reaches it directly (channels/authors it wants to keep).
 *
 * STORAGE DECISION — a sibling file re-read each poll cycle, NOT a block in
 * ~/.claude/discord.json:
 *   - discord.json is loaded ONCE at process start (loadConfig at module load).
 *     A forward rule must be installable / changeable / removable AT RUNTIME
 *     without restarting the watcher (the receptionist is stood up on demand),
 *     so it belongs with the other live-read files — the identity file
 *     (re-resolved every cycle) and the kill / auth-failed sentinels — not with
 *     boot-time infra config.
 *   - Lifecycle & ownership differ: discord.json is operator/infra config
 *     (guild, token, channel allowlist); the forward rule is per-session agent
 *     intent. Different lifecycle → different file. `--off` is then just an
 *     unlink of the sibling file.
 *
 * The forwarder holds a single pairwise pointer to the target (no fleet
 * registry that rots) — the frozen #65 decision. `<target>` populates the aoe
 * `session` (and `label` for logs); the deliver-router then reaches the grunt
 * over `aoe send` (auto-revive) or the file-drop floor even when the grunt has
 * no Discord of its own. A hand-edited rule file may carry a richer
 * DeliveryTarget (dir / channel) for advanced use.
 */
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { deliver, defaultTransports } from "./deliver/index.ts";
import type { DeliveryTarget, DeliveryResult } from "./deliver/types.ts";

/** A per-forwarder local forward rule. */
export interface ForwardRule {
  /** The grunt to forward doorbells to (pairwise pointer, no registry). */
  target: DeliveryTarget;
  /**
   * Channel names/ids or author (agent) names whose traffic stays with the
   * LOCAL agent (the allowlist). A match here → notify local, do not forward.
   */
  exclude: string[];
}

/** Minimal structural view of a message the forward logic needs. */
export interface ForwardableMessage {
  id: string;
  author: { username: string };
  content: string;
}

/** Minimal structural view of a channel the forward logic needs. */
export interface ForwardableChannel {
  id: string;
  name: string;
}

/** Logger shape the runtime forward helper writes to (matches mcp-logger). */
export interface ForwardLogger {
  info(event: string, data: Record<string, unknown>): void;
  warn(event: string, data: Record<string, unknown>): void;
  error(event: string, data: Record<string, unknown>, err?: string): void;
}

/** Location of the live-read forward-rule file. */
export function forwardRulePath(home: string = homedir()): string {
  return join(home, ".claude", "discord-forward.json");
}

/**
 * The header prefixed to forwarded content so the grunt knows the source (and
 * so an echoed forward is detectable as a loop). ASCII-only — no surrogate-pair
 * risk on the delivery path.
 */
export const FORWARD_HEADER_PREFIX = "[disc-forward";
export function forwardHeader(author: string, channelName: string): string {
  return `${FORWARD_HEADER_PREFIX} from ${author} in #${channelName}]`;
}

/** Marker the deliver-router stamps onto text-transport payloads. */
const DELIVER_MARKER_RE = /\[\[deliver-id:[^\]]+\]\]/;

/** Normalize an exclude / channel / author token: lowercase, strip @ or #. */
export function normalizeToken(s: string): string {
  return s.trim().toLowerCase().replace(/^[@#]+/, "");
}

/**
 * Parse `<target> [--exclude a,b,c]` (or `--off`) argv into a ForwardRule.
 * Returns `{ off: true }` to clear, `{ rule }` to install, or `{}` on bad input.
 */
export function parseForwardArgs(
  args: string[]
): { off?: true; rule?: ForwardRule } {
  const rest = [...args];
  if (rest.length === 0) return {};
  if (rest[0] === "--off" || rest[0] === "off") return { off: true };

  let target: string | undefined;
  const exclude: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--exclude") {
      const list = rest[++i];
      if (list) exclude.push(...splitList(list));
    } else if (arg.startsWith("--exclude=")) {
      exclude.push(...splitList(arg.slice("--exclude=".length)));
    } else if (!arg.startsWith("--") && target === undefined) {
      target = arg;
    }
  }
  if (!target) return {};
  return {
    rule: { target: { label: target, session: target }, exclude },
  };
}

function splitList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * Read the active forward rule, or `null` if none / unreadable / malformed.
 * Fail-safe like resolveIdentity: any error degrades to `null` (= no forward,
 * today's behavior), never a throw.
 */
export function resolveForwardRule(
  path: string = forwardRulePath()
): ForwardRule | null {
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8"));
    const target = data?.target;
    if (!target || typeof target !== "object") return null;
    // Addressable iff at least one transport can reach it (label is log-only).
    const addressable =
      !!target.session || !!target.dir || !!target.channel?.address;
    if (!addressable) return null;
    const exclude = Array.isArray(data.exclude)
      ? data.exclude.filter((x: unknown): x is string => typeof x === "string")
      : [];
    return { target, exclude };
  } catch {
    return null;
  }
}

/** Persist a forward rule (creates ~/.claude if needed). */
export function writeForwardRule(
  rule: ForwardRule,
  path: string = forwardRulePath()
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rule, null, 2) + "\n");
}

/** Remove the forward rule. Returns true if a rule was present. */
export function clearForwardRule(path: string = forwardRulePath()): boolean {
  try {
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this message excluded from forwarding (→ stays with the LOCAL agent)?
 * Matches an exclude entry against the channel name, channel id, or author.
 */
export function isExcludedFromForward(
  msg: ForwardableMessage,
  channel: ForwardableChannel,
  rule: ForwardRule
): boolean {
  if (rule.exclude.length === 0) return false;
  const ex = new Set(rule.exclude.map(normalizeToken));
  return (
    ex.has(normalizeToken(channel.name)) ||
    ex.has(normalizeToken(channel.id)) ||
    ex.has(normalizeToken(msg.author.username))
  );
}

/**
 * Loop / echo guard. A message must NOT be forwarded when it is the target's
 * OWN post coming back (author == target), or when it carries forwarded-content
 * markers (our forward header or the deliver-router id marker) — either would
 * bounce a delivery back to the grunt forever. The target talking back to us
 * reaches the LOCAL agent, not a loop.
 */
export function isForwardLoop(msg: ForwardableMessage, rule: ForwardRule): boolean {
  const targetNames = [rule.target.label, rule.target.session]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .map(normalizeToken);
  if (targetNames.includes(normalizeToken(msg.author.username))) return true;
  if (msg.content.includes(FORWARD_HEADER_PREFIX)) return true;
  if (DELIVER_MARKER_RE.test(msg.content)) return true;
  return false;
}

/**
 * The forward decision: should this already-addressed doorbell be forwarded to
 * the target (vs. delivered to the local agent)? True → forward; false → notify
 * local (excluded, or a loop-guarded echo/own-post).
 *
 * Callers gate on an active rule first, so a null rule is byte-for-byte today's
 * path — this function is only consulted when a rule exists.
 */
export function shouldForward(
  msg: ForwardableMessage,
  channel: ForwardableChannel,
  rule: ForwardRule
): boolean {
  if (isExcludedFromForward(msg, channel, rule)) return false;
  if (isForwardLoop(msg, rule)) return false;
  return true;
}

/**
 * The outcome of a single-message fetch, discriminated so a caller can tell a
 * genuinely-deleted message (`gone` = HTTP 404 — nothing to forward) from a
 * transient failure (`error` = network / timeout / rate-limit / 5xx / 403 — the
 * message likely still exists and must NOT be silently lost). `M` defaults to
 * the minimal structural view the forwarder needs; index.ts specializes it to
 * the full `DiscordMessage`.
 */
export type FetchMessageResult<M = { content: string }> =
  | { kind: "found"; message: M }
  | { kind: "gone" }
  | { kind: "error" };

/** Injectable deps for {@link forwardMessage} (keeps it unit-testable). */
export interface ForwardMessageDeps {
  /** Fetch the full message content (index.ts passes fetchMessageById). */
  fetchMessage: (
    channelId: string,
    messageId: string,
    authHeader: string
  ) => Promise<FetchMessageResult>;
  /** The deliver-router (defaults to the real `deliver`). */
  deliverFn?: typeof deliver;
  /** Optional logger. */
  log?: ForwardLogger;
}

/**
 * Outcome of a forward attempt (never throws — poll-loop safe). The four
 * non-delivered reasons mirror the fetch discrimination:
 *   - `gone`          — real 404, the message was deleted; drop it.
 *   - `fetch_error`   — transient fetch failure; the caller MUST fall back to the
 *                       local notify (see {@link shouldFallbackToLocalNotify}) so
 *                       the addressed message still reaches the local agent.
 *   - `deliver_error` — the deliver-router reported `ok: false` (transport send
 *                       failed, or no transport was available). The message
 *                       provably did NOT reach the target, so — exactly as with
 *                       `fetch_error` — the caller MUST fall back to the local
 *                       notify rather than lose it.
 *   - `exception`     — an unexpected throw on the delivery side; dropped (logged).
 */
export type ForwardOutcome =
  | { forwarded: true; result: DeliveryResult }
  | {
      forwarded: false;
      reason: "gone" | "fetch_error" | "deliver_error" | "exception";
      result?: DeliveryResult;
    };

/**
 * After a forward attempt, should the caller fall back to the LOCAL notify path
 * (`server.notification`, the same path a non-forwarded addressed message takes)
 * so the message still reaches the local agent?
 *
 * True whenever the message provably did NOT reach the target but still exists:
 * a transient fetch error, or a failed delivery. A real 404 (`gone`) is dropped
 * (nothing left to forward), a SUCCESSFUL delivery already reached the target
 * (waking the local agent too would defeat the point of forwarding), and an
 * `exception` is dropped (logged) — its delivery state is unknown, so it is
 * treated as possibly-delivered rather than risking a spurious local wake.
 *
 * Note this is NOT transport fallthrough/retry: the frozen "selection, not
 * retry" decision of epic #65 is untouched. The router still picks one
 * transport and never escalates. This only ensures a message the router could
 * not deliver still reaches the local agent instead of vanishing.
 */
export function shouldFallbackToLocalNotify(outcome: ForwardOutcome): boolean {
  if (outcome.forwarded !== false) return false;
  return outcome.reason === "fetch_error" || outcome.reason === "deliver_error";
}

/**
 * Fetch the full message content and deliver it to the target via the
 * deliver-router. Fire-and-forget in the sense that it NEVER throws — a failed
 * fetch or delivery is logged and reported, never escalated to the caller, so
 * the poll loop can never crash on a forward. Idempotency id = the Discord
 * message id (the recipient / file-drop dedupes a re-forward).
 */
export async function forwardMessage(
  rule: ForwardRule,
  channel: ForwardableChannel,
  msg: ForwardableMessage,
  authHeader: string,
  deps: ForwardMessageDeps
): Promise<ForwardOutcome> {
  try {
    const fetched = await deps.fetchMessage(channel.id, msg.id, authHeader);
    if (fetched.kind === "gone") {
      // Real 404 — the message was deleted. Nothing to forward; drop it.
      deps.log?.warn("forward", { to: label(rule), msg: msg.id, skip: "gone" });
      return { forwarded: false, reason: "gone" };
    }
    if (fetched.kind === "error") {
      // Transient fetch failure (network / timeout / rate-limit / 5xx / 403).
      // The addressed message likely still exists — do NOT drop it. Signal the
      // caller (via ForwardOutcome) to fall back to the LOCAL notify so it
      // still reaches the local agent instead of vanishing.
      deps.log?.warn("forward", { to: label(rule), msg: msg.id, fallback: "local_notify" });
      return { forwarded: false, reason: "fetch_error" };
    }
    const full = fetched.message;
    const payload = `${forwardHeader(msg.author.username, channel.name)}\n${full.content}`;
    const deliverFn = deps.deliverFn ?? deliver;
    const result = await deliverFn(rule.target, payload, {
      id: msg.id,
      transports: defaultTransports(),
    });
    deps.log?.[result.ok ? "info" : "warn"]("forward", {
      to: label(rule),
      transport: result.transport,
      ok: result.ok,
      id: msg.id,
      ...(result.error ? { error: result.error } : {}),
      ...(result.ok ? {} : { fallback: "local_notify" }),
    });
    if (!result.ok) {
      // The router could not deliver (transport send threw, or nothing was
      // available). The message provably did NOT reach the target — do NOT
      // report it as forwarded, or the caller skips the local notify and the
      // addressed message is lost to both the target and the local agent.
      return { forwarded: false, reason: "deliver_error", result };
    }
    return { forwarded: true, result };
  } catch (err) {
    deps.log?.error("forward", { to: label(rule), msg: msg.id }, String(err));
    return { forwarded: false, reason: "exception" };
  }
}

function label(rule: ForwardRule): string {
  return rule.target.label ?? rule.target.session ?? "target";
}
