/**
 * deliver-router — `aoe send` transport (priority 2).
 *
 * Shells to `aoe send <session> <message>` (aoe CLI). `aoe send` auto-revives a
 * stopped session by default, so a `send` after a crash or stop just works —
 * exactly the "always reach her on wake" property this transport is chosen for.
 * Available iff the target names an aoe session.
 *
 * The command runner is injected so tests never spawn a real process; the
 * default runner uses `node:child_process.execFile` (no shell → the message is
 * passed as a single argv entry, immune to shell metacharacters).
 */
import { execFile } from "node:child_process";
import type { DeliveryEnvelope, DeliveryTarget, Transport } from "../types.ts";
import { formatEnvelope } from "../envelope.ts";

/** Result of running the aoe CLI. */
export interface RunResult {
  code: number;
  stderr: string;
}

/** Runs an argv (no shell). Injected for testability. */
export type CommandRunner = (file: string, args: string[]) => Promise<RunResult>;

/** Default runner: `execFile` (no shell interpolation of the message). */
export const defaultRunner: CommandRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
      const code =
        err && typeof (err as { code?: unknown }).code === "number"
          ? ((err as { code: number }).code)
          : err
            ? 1
            : 0;
      resolve({ code, stderr: stderr?.toString() ?? "" });
    });
  });

export class AoeTransport implements Transport {
  readonly name = "aoe";
  constructor(private readonly run: CommandRunner = defaultRunner) {}

  available(target: DeliveryTarget): boolean {
    return typeof target.session === "string" && target.session.length > 0;
  }

  resolveAddress(target: DeliveryTarget): string | null {
    return target.session ?? null;
  }

  async send(target: DeliveryTarget, envelope: DeliveryEnvelope): Promise<void> {
    const session = this.resolveAddress(target);
    if (!session) throw new Error("aoe transport: no session");
    // Default is auto-revive (no `--no-revive`), matching the transport's intent.
    const { code, stderr } = await this.run("aoe", [
      "send",
      session,
      formatEnvelope(envelope),
    ]);
    if (code !== 0) {
      throw new Error(`aoe send exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`);
    }
  }
}
