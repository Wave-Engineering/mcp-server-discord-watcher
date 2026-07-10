/**
 * deliver-router — recipient-side idempotency.
 *
 * A directed message must never execute twice (a re-delivered deploy dispatch
 * would be a real incident). The router stamps every delivery with a message-id
 * (see {@link DeliveryEnvelope.id}); the recipient runs each id past a
 * deduplicator and acts only the first time it sees one.
 *
 * This mirrors the bounded seen-set the watcher already keeps for its own
 * wake-up notifications (`deliveredMessageIds` in `index.ts`) — same shape,
 * exported here so the deliver-router's recipients can share it.
 */

export interface Deduplicator {
  /**
   * Record `id` and report whether it is NEW. Returns `true` the first time an
   * id is seen (act on it) and `false` on every repeat (skip — already done).
   */
  firstSeen(id: string): boolean;
  /** Non-mutating check: has this id been seen before? */
  has(id: string): boolean;
}

/**
 * A bounded FIFO deduplicator. Keeps at most `max` ids; the oldest are evicted
 * once the cap is reached (a re-delivery long after eviction is vanishingly
 * unlikely given availability-gated single-select, and bounding the set keeps
 * a long-lived recipient from leaking memory).
 */
export function createDeduplicator(max = 4096): Deduplicator {
  const seen = new Set<string>();
  const order: string[] = [];
  return {
    firstSeen(id: string): boolean {
      if (seen.has(id)) return false;
      seen.add(id);
      order.push(id);
      while (order.length > max) {
        const evicted = order.shift();
        if (evicted !== undefined) seen.delete(evicted);
      }
      return true;
    },
    has(id: string): boolean {
      return seen.has(id);
    },
  };
}
