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

  test("the registry auth token is never COMMITTED to .npmrc", () => {
    // Asserts the COMMITTED blob, not the working-tree file.
    //
    // The first version of this test read `.npmrc` off disk. It passed locally
    // and FAILED in CI — because ci.yml appends the token to .npmrc before the
    // tests run, which is legitimate: the runner is ephemeral and the file dies
    // with the job. The property that actually matters is that the token is
    // never COMMITTED, and the working tree cannot answer that question.
    //
    // That is the defect this suite exists to catch, one level up: a guard
    // measuring a different artifact than the one it claims to protect.
    const r = Bun.spawnSync(["git", "show", "HEAD:.npmrc"], {
      cwd: join(import.meta.dir, ".."),
    });
    // Fail loudly rather than vacuously if git or the path is unavailable — a
    // guard that silently checks nothing is worse than no guard at all.
    expect(r.exitCode).toBe(0);
    const committed = new TextDecoder().decode(r.stdout);
    expect(committed.length).toBeGreaterThan(0);
    expect(committed).toMatch(/npm\.pkg\.github\.com/); // sanity: correct file
    expect(committed).not.toMatch(/_authToken\s*=\s*\S/);
  });
});
