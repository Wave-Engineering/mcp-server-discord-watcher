/**
 * deliver-router — shared types (mcp-server-discord issue #67).
 *
 * The deliver-router reaches another agent over whatever transport is
 * AVAILABLE, selected up front (NOT retried on failure), in priority order:
 *
 *     channels (Discord DM/channel)  →  `aoe send <session>`  →  file-drop
 *
 * First available transport wins. Availability is knowable up front (a
 * channels-disabled account skips the channel transport, a target with no aoe
 * session skips the aoe transport), so no delivery-ack is needed — this is
 * availability-gated *selection*, not retry. That is a frozen design decision
 * from epic #65 ("Selection, not retry … avoids double-delivery /
 * timeout-escalate").
 *
 * Address resolution is pairwise/local: the CALLER supplies the target
 * descriptor. There is NO fleet-wide registry to rot.
 */

/**
 * A delivery target, supplied by the caller (pairwise/local resolution — no
 * central identity→address map). Each field, when present, both *enables* and
 * *addresses* one transport:
 *
 *   - `channel` → the Discord channel/DM transport (available iff `enabled`)
 *   - `session` → the `aoe send` transport (available iff a session is named)
 *   - `dir`     → the file-drop transport (always available if a dir is given)
 *
 * A target will typically carry several of these; the router picks the first
 * available one in priority order.
 */
export interface DeliveryTarget {
  /** Human label for logs (e.g. the target's dev-name or session title). */
  label?: string;
  /**
   * Discord channel/DM transport. `enabled` is false on a client account that
   * has disabled Discord channels — the router then skips straight to `aoe
   * send` / file-drop. `address` is the channel or DM id to post into.
   */
  channel?: { enabled: boolean; address: string };
  /** aoe session id or title. Presence ⇒ the target has an aoe session. */
  session?: string;
  /** The target agent's directory. Presence ⇒ file-drop is possible. */
  dir?: string;
}

/**
 * A stamped delivery. `id` is the message-id that makes a directed message
 * idempotent: the recipient dedupes on it so the message never executes twice
 * (matters for deploy dispatch). The router stamps this once, up front, and the
 * same envelope is handed to whichever transport is selected.
 */
export interface DeliveryEnvelope {
  /** Idempotency key — recipient dedupes on this. */
  id: string;
  /** The message payload. */
  content: string;
  /** ISO-8601 timestamp of when the delivery was stamped. */
  ts: string;
}

/** Outcome of a `deliver()` call. */
export interface DeliveryResult {
  ok: boolean;
  /** Which transport was selected: its `name`, or `"none"` if none available. */
  transport: string;
  /** The idempotency id that was stamped (returned even on failure). */
  id: string;
  /** The resolved address the content was sent to, when known. */
  address?: string;
  /** Failure reason. Present iff `ok` is false. */
  error?: string;
}

/**
 * A pluggable transport. The three methods mirror the interface frozen in #67
 * (`available?`, `resolveAddress`, `send`). `send` receives the stamped
 * {@link DeliveryEnvelope} rather than a bare string so the idempotency id
 * travels with the content across every transport.
 */
export interface Transport {
  /** Stable identifier used in {@link DeliveryResult.transport} and logs. */
  readonly name: string;
  /** `available?(target)` — can this transport reach the target right now? */
  available(target: DeliveryTarget): boolean;
  /** Resolve the concrete address for the target, or null if unaddressable. */
  resolveAddress(target: DeliveryTarget): string | null;
  /** Deliver the stamped envelope. Throws on failure (the router reports it). */
  send(target: DeliveryTarget, envelope: DeliveryEnvelope): Promise<void>;
}
