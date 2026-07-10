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

/** Injectable deps for {@link forwardMessage} (keeps it unit-testable). */
export interface ForwardMessageDeps {
  /** Fetch the full message content (index.ts passes fetchMessageById). */
  fetchMessage: (
    channelId: string,
    messageId: string,
    authHeader: string
  ) => Promise<{ content: string } | null>;
  /** The deliver-router (defaults to the real `deliver`). */
  deliverFn?: typeof deliver;
  /** Optional logger. */
  log?: ForwardLogger;
}

/** Outcome of a forward attempt (never throws — poll-loop safe). */
export type ForwardOutcome =
  | { forwarded: true; result: DeliveryResult }
  | { forwarded: false; reason: "fetch_null" | "exception" };

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
    const full = await deps.fetchMessage(channel.id, msg.id, authHeader);
    if (!full) {
      // Deleted / 403 / transient — "nothing to forward" (#66 semantics).
      deps.log?.warn("forward", { to: label(rule), msg: msg.id, skip: "fetch_null" });
      return { forwarded: false, reason: "fetch_null" };
    }
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
    });
    return { forwarded: true, result };
  } catch (err) {
    deps.log?.error("forward", { to: label(rule), msg: msg.id }, String(err));
    return { forwarded: false, reason: "exception" };
  }
}

function label(rule: ForwardRule): string {
  return rule.target.label ?? rule.target.session ?? "target";
}
