/**
 * deliver-router — Discord channel/DM transport (priority 1).
 *
 * Available iff the target's account has Discord channels enabled and a channel
 * address is known. The actual "post to Discord" side-effect is injected so the
 * transport stays unit-testable and home-agnostic: the router lives in the
 * watcher, which is a poller by PRD design, so the concrete POST is supplied by
 * the caller (or a thin default) rather than reaching into disc-server's REST
 * client across a process boundary that does not exist.
 */
import type { DeliveryEnvelope, DeliveryTarget, Transport } from "../types.ts";
import { formatEnvelope } from "../envelope.ts";

/** The one side-effect the channel transport needs: post text to an address. */
export interface ChannelPoster {
  postMessage(address: string, text: string): Promise<void>;
}

export class ChannelTransport implements Transport {
  readonly name = "channel";
  constructor(private readonly poster: ChannelPoster) {}

  available(target: DeliveryTarget): boolean {
    return target.channel?.enabled === true && !!target.channel.address;
  }

  resolveAddress(target: DeliveryTarget): string | null {
    return target.channel?.address ?? null;
  }

  async send(target: DeliveryTarget, envelope: DeliveryEnvelope): Promise<void> {
    const address = this.resolveAddress(target);
    if (!address) throw new Error("channel transport: no address");
    await this.poster.postMessage(address, formatEnvelope(envelope));
  }
}
