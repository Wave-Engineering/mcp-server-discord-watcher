/**
 * Workflow-configuration guards.
 *
 * CI config is not unit-testable in the usual sense, but the properties that
 * matter here are textual and cheap to pin — and this repo's standing rule is
 * that config existing is not config working. These assert the properties, so a
 * regression fails a test rather than silently changing what CI does.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_DIR = join(import.meta.dir, "..", ".github", "workflows");

function workflows(): Array<{ name: string; body: string }> {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => ({ name: f, body: readFileSync(join(WORKFLOW_DIR, f), "utf-8") }));
}

describe("workflow dependency installs (#56)", () => {
  test("every workflow install is --frozen-lockfile", () => {
    // A bare `bun install` RESOLVES the declared range and rewrites the
    // lockfile, so CI can test a dependency tree the lockfile does not
    // describe — and a release build can ship one nobody reviewed. The
    // lockfile is the record of what was verified; CI must honour it, not
    // recompute it.
    //
    // Guard against vacuity: if the glob finds no install steps at all, this
    // test would pass while asserting nothing. Assert the denominator first.
    const files = workflows();
    expect(files.length).toBeGreaterThan(0);

    const installs: string[] = [];
    const bare: string[] = [];
    for (const { name, body } of files) {
      for (const line of body.split("\n")) {
        if (!/\bbun install\b/.test(line)) continue;
        installs.push(`${name}: ${line.trim()}`);
        if (!/--frozen-lockfile/.test(line)) bare.push(`${name}: ${line.trim()}`);
      }
    }
    expect(installs.length).toBeGreaterThan(0);
    expect(bare).toEqual([]);
  });

  test("the registry auth token is never written to the tracked .npmrc path", () => {
    // CI legitimately appends a token to .npmrc — safe because the runner is
    // ephemeral. This pins that it stays inside a workflow: the same line in a
    // script that a developer might run locally would commit a live credential,
    // because .npmrc is tracked in this repo.
    const tracked = readFileSync(join(import.meta.dir, "..", ".npmrc"), "utf-8");
    expect(tracked).not.toMatch(/_authToken\s*=\s*\S/);
  });
});
