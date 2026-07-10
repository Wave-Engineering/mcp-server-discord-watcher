/**
 * deliver-router — envelope formatting for text transports.
 *
 * The file-drop transport writes the structured {@link DeliveryEnvelope} as
 * JSON (the id is also the filename), so it never needs this. The channel and
 * `aoe send` transports carry a plain-text message, so they prepend a compact,
 * greppable id marker the recipient can parse to dedupe:
 *
 *     [[deliver-id:<uuid>]]
 *     <content>
 *
 * The marker is ASCII-only (no surrogate-pair risk on the Discord path) and on
 * its own line so it is trivially stripped or matched.
 */
import type { DeliveryEnvelope } from "./types.ts";

const MARKER_RE = /^\[\[deliver-id:([^\]]+)\]\]\n?/;

/** Prefix `content` with the idempotency marker for a text transport. */
export function formatEnvelope(env: DeliveryEnvelope): string {
  return `[[deliver-id:${env.id}]]\n${env.content}`;
}

/**
 * Parse a text-transport message back into `{ id, content }`. Returns `null`
 * for `id` when no marker is present (best-effort — a recipient can still
 * dedupe on whatever id it does find). Mirror of {@link formatEnvelope}.
 */
export function parseEnvelope(text: string): { id: string | null; content: string } {
  const m = text.match(MARKER_RE);
  if (!m) return { id: null, content: text };
  return { id: m[1], content: text.slice(m[0].length) };
}
