/**
 * Test preload (bunfig.toml): refuse to run the suite against a real home
 * directory.
 *
 * The suite creates and deletes ~/.claude/discord-bot.kill and
 * ~/.claude/discord-bot.auth-failed, and appends to ~/.claude/logs/mcp.jsonl.
 * Those are fleet-wide: every live discord-watcher on the box reads the
 * sentinels each cycle, so a bare `bun test` paused or deafened the whole fleet
 * (2026-10-23, every watcher reported "401 auth failed"). Run the suite through
 * scripts/ci/test.sh, which points HOME at a throwaway directory.
 *
 * The check is "HOME is inside the temp directory", not "HOME differs from the
 * user's home": Bun's os.userInfo().homedir follows $HOME instead of reading the
 * passwd entry, so it cannot tell the real home from an override. mktemp -d and
 * os.tmpdir() both honour $TMPDIR, so an isolated HOME always lands under it.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";

const home = process.env.HOME;
const tmp = realpathSync(tmpdir());
if (!home || !realpathSync(home).startsWith(tmp + sep)) {
  throw new Error(
    `refusing to run tests with HOME=${home ?? "(unset)"}: the suite writes ` +
      "fleet-wide ~/.claude sentinels, so HOME must be a throwaway directory " +
      `under ${tmp}. Run ./scripts/ci/test.sh, or HOME="$(mktemp -d)" bun test.`
  );
}

// An agent session exports LOG_FILE as an absolute path to the real
// ~/.claude/logs/mcp.jsonl, which the HOME override above does not redirect.
// Drop it before index.ts creates its logger, so test log lines go to stderr only.
delete process.env.LOG_FILE;

// Same for XDG_STATE_HOME, where the saved poll cursor lives (#83): a session
// that exports it would put test cursors beside the live watchers' cursors.
// Unset, the cursor falls back to $HOME/.local/state, inside the throwaway HOME.
delete process.env.XDG_STATE_HOME;
