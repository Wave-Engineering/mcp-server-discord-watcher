/**
 * deliver-router — public surface (mcp-server-discord #67).
 *
 * A `deliver(target, content)` primitive that reaches another agent over the
 * first AVAILABLE transport (channel → aoe send → file-drop), selected up front
 * and not retried, with per-delivery idempotency. Consumed by the watcher's
 * `disc forward` (#68) and `//directmsg` (#69) notify-step features — NOT wired
 * into either here (that is those stories' scope).
 */
export type {
  DeliveryTarget,
  DeliveryEnvelope,
  DeliveryResult,
  Transport,
} from "./types.ts";
export { deliver, defaultTransports } from "./router.ts";
export type { DeliverOptions, DefaultTransportDeps } from "./router.ts";
export { formatEnvelope, parseEnvelope } from "./envelope.ts";
export { createDeduplicator } from "./dedupe.ts";
export type { Deduplicator } from "./dedupe.ts";
export { ChannelTransport } from "./transports/channel.ts";
export type { ChannelPoster } from "./transports/channel.ts";
export { AoeTransport, defaultRunner } from "./transports/aoe.ts";
export type { CommandRunner, RunResult } from "./transports/aoe.ts";
export {
  FileDropTransport,
  defaultDropFs,
  DROP_SUBDIR,
  safeIdFilename,
} from "./transports/filedrop.ts";
export type { DropFs } from "./transports/filedrop.ts";
