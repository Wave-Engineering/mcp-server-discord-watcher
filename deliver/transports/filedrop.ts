/**
 * deliver-router — file-drop transport (priority 3, the always-available floor).
 *
 * Writes the delivery to a known file in the target's directory; the target
 * reads it on wake. Available whenever a `dir` is known, so it is the guaranteed
 * fallback when channels are disabled AND the target has no live aoe session.
 *
 * Deliveries land under `<dir>/.deliveries/<id>.json`, one file per message,
 * with the idempotency id AS the filename. That makes the write idempotent by
 * construction: re-delivering the same id never produces a second file, so the
 * recipient reads (and acts on) each delivery exactly once. The full
 * {@link DeliveryEnvelope} is written as JSON — no text marker needed, since the
 * recipient reads structured data here.
 *
 * The filesystem is injected (defaulting to `node:fs`) so tests exercise the
 * real idempotency logic against an in-memory store rather than touching disk.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeliveryEnvelope, DeliveryTarget, Transport } from "../types.ts";

/** Sub-directory (under the target's dir) that holds dropped deliveries. */
export const DROP_SUBDIR = ".deliveries";

/**
 * Make an id safe to use as a filename component. The id may be caller-supplied
 * (for idempotent redelivery), so strip anything that could escape the drop dir
 * or otherwise break a filename — `/`, `\`, `..`, NUL, etc. — down to a flat
 * `[A-Za-z0-9._-]` token. Distinct ids stay distinct (collisions would only
 * merge two already-different messages, and the default id is a UUID anyway).
 */
export function safeIdFilename(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return cleaned.length > 0 ? cleaned : "_";
}

/** The minimal filesystem surface the transport needs. Injected for tests. */
export interface DropFs {
  exists(path: string): boolean;
  mkdirp(path: string): void;
  writeFile(path: string, data: string): void;
}

/** Default filesystem backed by `node:fs`. */
export const defaultDropFs: DropFs = {
  exists: (p) => existsSync(p),
  mkdirp: (p) => {
    mkdirSync(p, { recursive: true });
  },
  writeFile: (p, data) => {
    writeFileSync(p, data, "utf8");
  },
};

export class FileDropTransport implements Transport {
  readonly name = "filedrop";
  constructor(private readonly fs: DropFs = defaultDropFs) {}

  available(target: DeliveryTarget): boolean {
    return typeof target.dir === "string" && target.dir.length > 0;
  }

  /** The drop directory for this target (`<dir>/.deliveries`), or null. */
  resolveAddress(target: DeliveryTarget): string | null {
    return target.dir ? join(target.dir, DROP_SUBDIR) : null;
  }

  async send(target: DeliveryTarget, envelope: DeliveryEnvelope): Promise<void> {
    const dropDir = this.resolveAddress(target);
    if (!dropDir) throw new Error("filedrop transport: no dir");
    const file = join(dropDir, `${safeIdFilename(envelope.id)}.json`);
    // Idempotent by construction: a file for this id already exists ⇒ no-op.
    if (this.fs.exists(file)) return;
    this.fs.mkdirp(dropDir);
    this.fs.writeFile(file, JSON.stringify(envelope));
  }
}
