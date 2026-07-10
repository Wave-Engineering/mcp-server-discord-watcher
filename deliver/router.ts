/**
 * deliver-router — `deliver(target, content)` (mcp-server-discord #67).
 *
 * Reaches an agent over whatever transport is AVAILABLE, selected up front and
 * NOT retried on failure, in priority order:
 *
 *     channel (Discord DM/channel)  →  aoe send  →  file-drop
 *
 * The router stamps one idempotency id, picks the first transport whose
 * `available?` is true, and hands the stamped envelope to it. Selection — not
 * retry: if the chosen transport's `send` throws, the router reports the
 * failure; it does NOT fall through to the next transport. Availability is
 * knowable up front, so falling through would risk a double-delivery or a
 * timeout-escalate storm, both of which this design deliberately avoids
 * (frozen decision, epic #65).
 */
import type {
  DeliveryResult,
  DeliveryTarget,
  Transport,
} from "./types.ts";
import { ChannelTransport, type ChannelPoster } from "./transports/channel.ts";
import { AoeTransport, type CommandRunner } from "./transports/aoe.ts";
import { FileDropTransport, type DropFs } from "./transports/filedrop.ts";

/** Options for {@link deliver}. */
export interface DeliverOptions {
  /**
   * Idempotency id. Supply one to make a redelivery a no-op at the recipient
   * (dedupe by id) or in the file-drop transport (write keyed by id). Omit to
   * mint a fresh UUID per call.
   */
  id?: string;
  /**
   * Transport priority list. Defaults to `channel → aoe → filedrop`. The first
   * transport whose `available?` is true is selected.
   */
  transports?: Transport[];
  /** Clock injection for the envelope timestamp (tests). Defaults to `Date`. */
  now?: () => Date;
  /** Id generator injection (tests). Defaults to `crypto.randomUUID`. */
  newId?: () => string;
}

/** Mint an id: caller-supplied wins, else a UUID. */
function mintId(opts?: DeliverOptions): string {
  if (opts?.id) return opts.id;
  if (opts?.newId) return opts.newId();
  return crypto.randomUUID();
}

/**
 * Deliver `content` to `target` over the first available transport.
 *
 * @returns a {@link DeliveryResult} — always resolves (never rejects); a
 *   transport failure or "no available transport" is reported as `ok: false`.
 */
export async function deliver(
  target: DeliveryTarget,
  content: string,
  opts?: DeliverOptions,
): Promise<DeliveryResult> {
  const id = mintId(opts);
  const ts = (opts?.now?.() ?? new Date()).toISOString();
  const envelope = { id, content, ts };
  const transports = opts?.transports ?? defaultTransports();

  // Availability-gated SELECTION (up front), not retry.
  const chosen = transports.find((t) => t.available(target));
  if (!chosen) {
    return { ok: false, transport: "none", id, error: "no available transport" };
  }

  try {
    await chosen.send(target, envelope);
    return {
      ok: true,
      transport: chosen.name,
      id,
      address: chosen.resolveAddress(target) ?? undefined,
    };
  } catch (err) {
    // Selection, not retry: the failure is reported, NOT escalated to the next
    // transport (that would risk double-delivery / timeout-escalate).
    return {
      ok: false,
      transport: chosen.name,
      id,
      address: chosen.resolveAddress(target) ?? undefined,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Wiring for the default transport set (side-effects injectable per transport). */
export interface DefaultTransportDeps {
  poster?: ChannelPoster;
  runner?: CommandRunner;
  fs?: DropFs;
}

/**
 * Build the default `channel → aoe → filedrop` transport list. The channel
 * transport needs a {@link ChannelPoster}; if none is provided it is omitted
 * (an account with no Discord poster simply falls to `aoe send` / file-drop —
 * the same behavior as a channels-disabled target).
 */
export function defaultTransports(deps: DefaultTransportDeps = {}): Transport[] {
  const list: Transport[] = [];
  if (deps.poster) list.push(new ChannelTransport(deps.poster));
  list.push(new AoeTransport(deps.runner));
  list.push(new FileDropTransport(deps.fs));
  return list;
}
