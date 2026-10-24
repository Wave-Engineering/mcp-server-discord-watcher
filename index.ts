#!/usr/bin/env bun
/**
 * discord-watcher — MCP channel server for Claude Code
 *
 * Watches all text channels on the Oak and Wave Discord server and pushes
 * wake-up notifications into the Claude Code session when new messages arrive.
 *
 * This is a "doorbell, not a mailroom" — it notifies the agent that something
 * new appeared, then the agent uses the disc_read / disc_send MCP tools (from
 * the disc-server MCP server) to interact.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { sanitizeSurrogates } from "./sanitize.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@wave-engineering/mcp-logger";
import {
  parseForwardArgs,
  writeForwardRule,
  clearForwardRule,
  resolveForwardRule,
  shouldForward,
  forwardMessage,
  shouldFallbackToLocalNotify,
  type ForwardRule,
  type ForwardableMessage,
  type ForwardableChannel,
  type FetchMessageResult,
} from "./forward.ts";
import {
  parseDirectMsgArgs,
  sendDirectMsg,
  directMsgOverridesForward,
} from "./directmsg.ts";

// --- Build-date query (early exit) ------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILDINFO_PATH = join(__dirname, ".buildinfo");

if (process.argv.includes("--builddate")) {
  if (existsSync(BUILDINFO_PATH)) {
    process.stdout.write(readFileSync(BUILDINFO_PATH, "utf-8").trim() + "\n");
  } else {
    process.stdout.write("unknown\n");
  }
  process.exit(0);
}

// --- `disc forward` command surface (early exit) -----------------------------
//
// Thin writer for the per-forwarder LOCAL rule (#68). The runtime forward at the
// poll/notify step is the meat; this just records the rule the watcher re-reads
// each cycle. Mirrors the `--builddate` early-exit convention.
//
//   discord-watcher forward <target> [--exclude a,b,c]   # install
//   discord-watcher forward --off                        # remove
//
if (process.argv[2] === "forward") {
  const parsed = parseForwardArgs(process.argv.slice(3));
  if (parsed.off) {
    const cleared = clearForwardRule();
    process.stdout.write(
      cleared ? "disc forward: rule cleared\n" : "disc forward: no rule to clear\n"
    );
    process.exit(0);
  } else if (parsed.rule) {
    writeForwardRule(parsed.rule);
    const suffix = parsed.rule.exclude.length
      ? ` (except: ${parsed.rule.exclude.join(", ")})`
      : "";
    process.stdout.write(
      `disc forward: forwarding doorbells to ${parsed.rule.target.label}${suffix}\n`
    );
    process.exit(0);
  }
  process.stderr.write(
    "usage: discord-watcher forward <target> [--exclude a,b,c] | forward --off\n"
  );
  process.exit(2);
}

// --- `//directmsg` send surface (early exit) ---------------------------------
//
// The SEND side of #69: push a distilled must-see straight to <target> via the
// deliver-router (#67), bypassing any forward rule on the target — it reaches
// the target even on a channels-disabled account. Mirrors the `forward` and
// `--builddate` early-exit convention. The RECEIVE side (the precedence override
// that keeps a directmsg from being forwarded away) lives at the notify step.
//
//   discord-watcher directmsg <target> <content...>   # alias: dm
//
if (process.argv[2] === "directmsg" || process.argv[2] === "dm") {
  const { target, content } = parseDirectMsgArgs(process.argv.slice(3));
  if (!target || !content) {
    process.stderr.write(
      "usage: discord-watcher directmsg <target> <content...>\n"
    );
    process.exit(2);
  }
  const result = await sendDirectMsg(target, content);
  process.stdout.write(
    result.ok
      ? `//directmsg: delivered to ${target} via ${result.transport}\n`
      : `//directmsg: FAILED to reach ${target} (${result.error ?? "no transport"})\n`
  );
  process.exit(result.ok ? 0 : 1);
}

// --- Configuration -----------------------------------------------------------

// Hardcoded defaults (Oak and Wave — last-resort fallback)
const DEFAULT_GUILD_ID = "1486516321385578576";
const DEFAULT_TOKEN_PATH = "~/secrets/discord-bot-token";

/** Discord configuration schema as stored in ~/.claude/discord.json */
export interface DiscordConfig {
  guild_id?: string;
  token_path?: string;
  scream_hole_url?: string;
  channels?: {
    [role: string]: { name: string; id: string };
  };
  /** Poll-scope allowlist: channel IDs or names this watcher may watch. */
  watcher_channels?: string[];
}

/**
 * Compute the channel allowlist (deliver-scope) from config + env.
 * Precedence: discord.json `watcher_channels` (non-empty array) → env
 * `DISCORD_WATCHER_CHANNELS` (comma-separated channel IDs or names) → null.
 * `null` means "no allowlist" — deliver from every channel (backward-compatible),
 * so existing single-team setups are unaffected. Entries may be channel IDs or
 * names; matching is by either (see isChannelInScope).
 */
export function computeChannelAllowlist(
  config: DiscordConfig,
  envValue: string | undefined
): string[] | null {
  if (Array.isArray(config.watcher_channels)) {
    const fromConfig = config.watcher_channels
      .map((c) => String(c).trim())
      .filter((c) => c.length > 0);
    if (fromConfig.length > 0) return fromConfig;
  }
  if (envValue) {
    const fromEnv = envValue
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (fromEnv.length > 0) return fromEnv;
  }
  return null;
}

/**
 * Load Discord config using the fallback chain:
 * 1. ~/.claude/discord.json
 * 2. Environment variables
 * 3. Hardcoded defaults
 */
export function loadConfig(): {
  guildId: string;
  tokenPath: string;
  screamHoleUrl: string | null;
  channelAllowlist: string[] | null;
} {
  let config: DiscordConfig = {};
  const configPath = join(homedir(), ".claude", "discord.json");

  // 1. Try config file
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      log.warn("state_change", { what: "config", to: "defaults", reason: "invalid JSON in discord.json" });
    }
  }

  // 2. Guild ID: config → env → default
  const guildId =
    config.guild_id ||
    process.env.DISCORD_GUILD_ID ||
    DEFAULT_GUILD_ID;

  // 3. Token path: config → env → default
  const tokenPath =
    config.token_path ||
    process.env.DISCORD_TOKEN_PATH ||
    DEFAULT_TOKEN_PATH;

  // 4. Scream-hole URL: config → env → null (disabled)
  const screamHoleUrl =
    config.scream_hole_url ||
    process.env.SCREAM_HOLE_URL ||
    null;

  // 5. Channel allowlist (deliver-scope): config → env → null (deliver from all).
  // Warn loudly if watcher_channels is present but not an array — a string like
  // "oaw,roll-call" is a common mistake that would be silently ignored and
  // reopen the cross-team leak by falling through to deliver-from-all.
  if (
    config.watcher_channels !== undefined &&
    !Array.isArray(config.watcher_channels)
  ) {
    log.warn("state_change", {
      what: "config",
      to: "watcher_channels_ignored",
      reason: "watcher_channels must be an array of channel ids/names",
    });
  }
  const channelAllowlist = computeChannelAllowlist(
    config,
    process.env.DISCORD_WATCHER_CHANNELS
  );

  return { guildId, tokenPath, screamHoleUrl, channelAllowlist };
}

// Attribution (`pid` + per-process `instance`) is provided NATIVELY by
// @wave-engineering/mcp-logger >= 1.1.0, injected inside emit() after the level
// threshold check. This repo previously wrapped the logger to inject them (#54);
// that wrapper is retired (#57) because native coverage is strictly broader:
//   - EARLIER: the instance id is module-scope in mcp-logger, evaluated at first
//     import, so there is no unattributed window before the wrapper was applied.
//   - BROADER: it attributes every logger in the process — including the
//     `deps.log` call sites in forward.ts / directmsg.ts — all sharing one id.
// The dependency is pinned to an EXACT version, not a caret: 1.1.0 reserves
// `pid`/`instance`, so a range that could drift back to a version without that
// contract, or forward to one that changes it, is not safe to leave floating.
const log = createLogger("watcher");

const { guildId: GUILD_ID, tokenPath: CONFIGURED_TOKEN_PATH, screamHoleUrl: CONFIGURED_SCREAM_HOLE_URL, channelAllowlist: CHANNEL_ALLOWLIST } = loadConfig();

export const DISCORD_API_BASE = "https://discord.com/api/v10";
let API_BASE = DISCORD_API_BASE;
const POLL_INTERVAL_MS = 15_000;
const CHANNEL_REFRESH_MS = 5 * 60_000;
const MESSAGES_PER_PAGE = 50;
const VERBOSE = process.env.DISCORD_WATCHER_VERBOSE === "1";
// `@agents` is the fleet broadcast (#84). `@all` is still heard during the transition;
// DISCORD_WATCHER_ACCEPT_ALL=0 stops hearing it without a code change. On Mattermost
// `@all` pages every human in a channel, so the fleet moves off it on both backends.
export const ACCEPT_ALL = process.env.DISCORD_WATCHER_ACCEPT_ALL !== "0";

// Random delay between per-channel polls within a single cycle. Spreads
// outbound Discord API calls across the cycle window so guilds with many
// channels don't fire 20+ requests in a tight burst that trips the global
// rate limit.
const INTER_CHANNEL_JITTER_MIN_MS = 50;
const INTER_CHANNEL_JITTER_MAX_MS = 150;

// --- Kill switch -------------------------------------------------------------

const KILL_FILE = join(homedir(), ".claude", "discord-bot.kill");

/**
 * Check the kill switch file (~/.claude/discord-bot.kill).
 *
 * Returns:
 *   "active"  — kill switch is active, skip the poll cycle
 *   "clear"   — no kill switch or it was auto-lifted, proceed normally
 *
 * Kill file format (compatible with discord-bot shell script):
 *   - Empty file: manual kill, no expiry — always active
 *   - File containing a Unix timestamp: active until that time, auto-lifted when expired
 */
export function checkKillSwitch(): "active" | "clear" {
  if (!existsSync(KILL_FILE)) return "clear";

  const content = readFileSync(KILL_FILE, "utf-8").trim();

  if (!content || !/^\d+$/.test(content)) {
    // Manual kill — no expiry
    log.warn("state_change", { what: "kill_switch", to: "active", reason: "manual" });
    return "active";
  }

  const expiryTimestamp = parseInt(content, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (nowSeconds >= expiryTimestamp) {
    // Ban expired — auto-lift
    try {
      unlinkSync(KILL_FILE);
      log.info("state_change", { what: "kill_switch", to: "clear", reason: "expired" });
    } catch {
      // File may have been removed by another process
    }
    return "clear";
  }

  const remaining = expiryTimestamp - nowSeconds;
  log.warn("state_change", { what: "kill_switch", to: "active", reason: "timed", remaining_s: remaining });
  return "active";
}

/**
 * Engage the kill switch with an expiry timestamp.
 * Called when a 429 (rate limit) response is received.
 * Uses atomic write (write to temp + rename) to prevent empty kill files.
 */
export function engageKillSwitch(retryAfterSeconds: number): void {
  const expiry = Math.floor(Date.now() / 1000) + Math.ceil(retryAfterSeconds);
  const tmpFile = `${KILL_FILE}.${process.pid}`;
  try {
    writeFileSync(tmpFile, `${expiry}\n`);
    renameSync(tmpFile, KILL_FILE);
    log.warn("state_change", { what: "kill_switch", to: "engaged", reason: "429", duration_s: Math.ceil(retryAfterSeconds) });
  } catch (err) {
    log.error("state_change", { what: "kill_switch", to: "write_failed" }, String(err));
    // Clean up temp file if rename failed
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// --- Auth-failure circuit breaker --------------------------------------------
//
// Distinct from the kill switch (which handles transient 429s with auto-lift):
// auth failure is a *permanent* state for the current bot token. Once Discord
// returns 401 the token is expired/revoked and no amount of retrying will fix
// it — only operator intervention (new token + watcher restart) recovers.
//
// State lives in a sentinel file at ~/.claude/discord-bot.auth-failed. The
// file is cleared at watcher startup (clearAuthFailed in main()) so a fresh
// process with a fresh token retries cleanly.

const AUTH_FAILED_FILE = join(homedir(), ".claude", "discord-bot.auth-failed");

/**
 * Returns true if the auth-failed sentinel file exists. The watcher uses
 * this to short-circuit polling and channel-refresh cycles when the bot
 * token is known to be bad.
 */
export function checkAuthFailed(): boolean {
  return existsSync(AUTH_FAILED_FILE);
}

/**
 * Engage the auth-failure circuit breaker. Called from `apiGet` when Discord
 * returns 401 Unauthorized. Idempotent — only logs and writes the sentinel
 * file once per process so repeated 401s during a single poll cycle don't
 * spam stderr.
 */
export function engageAuthFailed(): void {
  if (existsSync(AUTH_FAILED_FILE)) return;
  try {
    writeFileSync(
      AUTH_FAILED_FILE,
      `${new Date().toISOString()} Discord 401 Unauthorized\n`
    );
    log.error("state_change", { what: "auth", to: "failed", reason: "401 Unauthorized" });
  } catch (err) {
    log.error("state_change", { what: "auth", to: "sentinel_write_failed" }, String(err));
  }
}

/**
 * Clear the auth-failed sentinel file. Called from `main()` at watcher
 * startup so a fresh process with a fresh token retries cleanly. Idempotent —
 * silently does nothing if the file does not exist.
 */
export function clearAuthFailed(): void {
  try {
    unlinkSync(AUTH_FAILED_FILE);
  } catch {
    // File doesn't exist — nothing to clear
  }
}

// --- Scream-hole health check ------------------------------------------------

/**
 * Extract the origin (scheme + host + port) from a URL string, stripping any
 * path components. Used to hit the health endpoint at the root of the
 * scream-hole proxy regardless of whether the config URL includes `/api/v10`.
 */
export function extractOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    // If URL parsing fails, strip trailing slashes and path as best we can
    return url.replace(/\/+$/, "").replace(/\/api\/v10\/?$/, "");
  }
}

/**
 * Check if scream-hole is reachable by hitting its /health endpoint.
 * Always hits the origin root (e.g. https://host/health), regardless of
 * whether the configured URL includes /api/v10.
 * Returns true if reachable, false otherwise.
 */
export async function checkScreamHoleHealth(url: string): Promise<boolean> {
  const origin = extractOrigin(url);
  const healthUrl = `${origin}/health`;
  try {
    log.debug("health_check", { url: healthUrl });
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    log.debug("health_check", { url: healthUrl, status: res.status, ok: res.ok });
    return res.ok;
  } catch (err) {
    log.debug("health_check", { url: healthUrl, error: String(err) });
    return false;
  }
}

/**
 * Ensure a scream-hole URL ends with `/api/v10` (the Discord-compatible API
 * prefix). Handles both forms:
 *   - Origin only: `https://host` → `https://host/api/v10`
 *   - Already suffixed: `https://host/api/v10/` → `https://host/api/v10`
 */
export function ensureApiV10Suffix(url: string): string {
  const stripped = url.replace(/\/+$/, "");
  if (/\/api\/v10$/.test(stripped)) {
    return stripped;
  }
  return `${stripped}/api/v10`;
}

/**
 * Resolve which API base URL to use. If scream-hole is configured and reachable,
 * use it (with /api/v10 suffix); otherwise fall back to direct Discord API.
 */
export async function resolveApiBase(screamHoleUrl: string | null): Promise<string> {
  if (!screamHoleUrl) {
    log.info("state_change", { what: "mode", to: "direct" });
    return DISCORD_API_BASE;
  }

  const healthy = await checkScreamHoleHealth(screamHoleUrl);
  if (healthy) {
    const baseUrl = ensureApiV10Suffix(screamHoleUrl);
    log.info("state_change", { what: "mode", to: "scream-hole", url: baseUrl });
    return baseUrl;
  }

  log.warn("state_change", { what: "mode", from: "scream-hole", to: "direct", reason: "scream-hole unreachable" });
  return DISCORD_API_BASE;
}

// --- Auth --------------------------------------------------------------------

function loadToken(): string {
  const envToken = process.env.DISCORD_BOT_TOKEN;
  if (envToken) return envToken.trim();

  // Expand ~ in configured token path
  const tokenPath = CONFIGURED_TOKEN_PATH.replace(/^~/, homedir());
  try {
    return readFileSync(tokenPath, "utf-8").replace(/\r?\n/g, "").trim();
  } catch {
    throw new Error(
      `DISCORD_BOT_TOKEN not set and ${tokenPath} not found. Save your bot token there.`
    );
  }
}

// --- Agent identity (self-echo filtering + targeted routing) -----------------

export interface AgentIdentity {
  devName: string | null;
  devTeam: string | null;
}

let cachedIdentity: AgentIdentity = { devName: null, devTeam: null };

/**
 * The identity locations, in read order. Exported so the unresolved-identity
 * notification can name the exact paths the operator must create (#28) rather
 * than describing them — a message that says "run /name" without saying *where*
 * it looked is what made the 2026-06-01 outage take three days to spot.
 */
export function identityPaths(): {
  projectRoot: string;
  durableFile: string;
  legacyTmpFile: string;
} {
  const projectRoot = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const dirHash = createHash("md5").update(projectRoot).digest("hex");
  return {
    projectRoot,
    durableFile: join(projectRoot, ".claude", "agent-identity.json"),
    legacyTmpFile: `/tmp/claude-agent-${dirHash}.json`,
  };
}

export function resolveIdentity(): AgentIdentity {
  // Claude Code sets CLAUDE_PROJECT_DIR in every spawned MCP server's environment
  // to the session project root (the locked identity-path contract) — it is the
  // authoritative root and is immune to cwd drift. Fall back to process.cwd() only
  // if it is somehow unset. We dropped `git rev-parse --show-toplevel`, which
  // returned the *wrong* toplevel whenever the watcher's cwd sat inside an
  // unrelated git repo — the nested-repo hazard cacophonix flagged on #34.
  // Read order (cc-workflow #723): the durable project-local file first, then
  // the legacy /tmp path during the transition window. /tmp is emptied on every
  // reboot (systemd-tmpfiles `D /tmp`), so a watcher that booted after a reboot
  // resolved a null identity from /tmp — the null-at-boot over-broad bleed. The
  // project-local `.claude/` file survives reboots.
  const { projectRoot, durableFile, legacyTmpFile } = identityPaths();

  for (const file of [durableFile, legacyTmpFile]) {
    try {
      const data = JSON.parse(readFileSync(file, "utf-8"));
      const devName = data.dev_name || null;
      const devTeam = data.dev_team || null;
      // A file that parses but yields no usable identity (empty `{}`, half-written,
      // or null fields) must NOT shadow a complete identity in a later location.
      // Require BOTH fields — matching the fail-closed delivery contract — and
      // otherwise fall through to the next file (mother's #34 shadowing finding).
      if (devName && devTeam) {
        return { devName, devTeam };
      }
    } catch {
      // not present / unreadable — try the next location
    }
  }
  // Unresolved. Emit a greppable breadcrumb with the resolved root and the exact
  // paths tried, so a writer/reader root mismatch (identity written under a
  // different project root) is diagnosable instead of degrading silently to a
  // Claude/🤖/unknown fallout downstream (cacophonix's #34 note). Debug level: it
  // runs every poll cycle while unresolved, so it must not become info-noise.
  log.debug("identity_unresolved", {
    project_root: projectRoot,
    tried: [durableFile, legacyTmpFile],
  });
  return { devName: null, devTeam: null };
}

/**
 * Re-resolve the agent identity and update the cache when it changes. Lets a
 * watcher that booted before `/name` wrote the identity file (the /tmp-wipe /
 * null-at-boot case) self-heal without a restart. Returns true if the identity
 * changed. Logs on transition.
 */
export function refreshIdentity(): boolean {
  const next = resolveIdentity();
  if (
    next.devName === cachedIdentity.devName &&
    next.devTeam === cachedIdentity.devTeam
  ) {
    return false;
  }
  log.info("state_change", {
    what: "identity",
    from: `${cachedIdentity.devName}/${cachedIdentity.devTeam}`,
    to: `${next.devName}/${next.devTeam}`,
  });
  cachedIdentity = next;
  return true;
}

// --- Unresolved-identity circuit breaker (#28) -------------------------------
//
// shouldDeliverMessage fails CLOSED on unresolved identity — correct, and kept
// (deaf beats over-broad). The bug was that it also failed SILENT: the poll loop
// logged healthy cycles while delivering nothing, so a wiped identity file
// deafened an agent with no event to correlate. That produced a multi-day
// fleet-wide outage (2026-06-01 → 06-03) noticed only when a human asked why
// agents had gone quiet, and it recurred live on 2026-07-19.
//
// This mirrors the auth-failure breaker, with one deliberate difference: auth
// latches until restart, whereas identity RE-ARMS. Identity self-heals the
// moment the file reappears (refreshIdentity runs every cycle), so an outage is
// an *episode* with a start and an end, and each new episode deserves its own
// notification.

/** Default cycles between repeat `identity_outage` warn logs. */
export const DEFAULT_IDENTITY_WARN_CYCLES = 100;

/**
 * Unresolved cycles to tolerate before NOTIFYING the session (~45s at a 15s
 * poll). `/name` runs at session start and takes non-trivial time — load the
 * skill, pick a name, write the file, announce, check in on Discord — which can
 * exceed one poll interval. Without this grace the watcher's first cycle would
 * tell the agent "identity unresolved, run /name" while it is *at that moment*
 * running /name, then immediately recover.
 *
 * That false alarm is not merely noisy, it is corrosive: an alert that fires on
 * nearly every startup is one everyone learns to ignore, and the next real
 * multi-day outage then produces a notification indistinguishable from routine
 * startup noise — defeating the entire point of the breaker.
 *
 * The warn LOG still fires on cycle 1 (diagnosability is not delayed); only the
 * session-facing notification waits. Against an outage measured in days, 45s of
 * grace costs nothing.
 */
export const IDENTITY_NOTIFY_AFTER_CYCLES = 3;

/**
 * Cycles between repeat warn logs while identity is unresolved. Override with
 * `DISCORD_IDENTITY_WARN_CYCLES`; a non-positive or non-integer value falls
 * back to the default rather than disabling the warning entirely.
 */
export function identityWarnCycles(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DISCORD_IDENTITY_WARN_CYCLES);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_IDENTITY_WARN_CYCLES;
}

/** Breaker state for the current unresolved-identity episode. */
export interface IdentityBreakerState {
  /** Has the one-per-episode MCP notification already fired? */
  notified: boolean;
  /** Consecutive unresolved poll cycles in the current episode. */
  cycles: number;
  /**
   * Has identity EVER resolved in this process? The startup grace period is
   * only legitimate before the first successful resolve — see
   * {@link stepIdentityBreaker}. Without this, an identity that FLAPS on a
   * sub-grace cycle (unresolved 2, resolved 1, repeat) never accumulates
   * enough consecutive cycles to notify, so an agent deaf most of the time is
   * silently deaf — the exact failure #28 exists to eliminate, reintroduced by
   * the fix for the startup false alarm.
   */
  everResolved: boolean;
}

export const INITIAL_IDENTITY_BREAKER: IdentityBreakerState = {
  notified: false,
  cycles: 0,
  everResolved: false,
};

/** What the caller should do this cycle, given the breaker transition. */
export interface IdentityBreakerStep {
  state: IdentityBreakerState;
  /** Emit the one-per-episode MCP notification (delivery is suspended). */
  notify: boolean;
  /** Emit a `warn`-level `identity_unresolved` log this cycle. */
  warn: boolean;
  /** Identity just came back after an episode — log recovery. */
  recovered: boolean;
}

/**
 * Advance the unresolved-identity breaker by one poll cycle.
 *
 * Pure — all I/O stays with the caller — so the arm / fire / re-arm / recover
 * transitions are directly unit-testable, which is the point: this state
 * machine is the only thing standing between a wiped identity file and another
 * silent multi-day outage.
 *
 * - unresolved, first cycle of an episode → notify once, warn once
 * - unresolved, subsequent cycles         → warn every `warnEveryN` cycles
 * - resolved after an episode             → recovered, state reset (RE-ARMS, so
 *                                           a later wipe notifies again)
 * - resolved with no prior episode        → nothing (the healthy steady state)
 */
export function stepIdentityBreaker(
  prev: IdentityBreakerState,
  resolved: boolean,
  warnEveryN: number = DEFAULT_IDENTITY_WARN_CYCLES
): IdentityBreakerStep {
  if (resolved) {
    // Only a transition OUT of an episode is a recovery; a steady healthy cycle
    // is silent. Resetting `notified` is what re-arms the breaker.
    const recovered = prev.notified || prev.cycles > 0;
    return {
      state: { ...INITIAL_IDENTITY_BREAKER, everResolved: true },
      notify: false,
      warn: false,
      recovered,
    };
  }
  const cycles = prev.cycles + 1;
  const n = Number.isInteger(warnEveryN) && warnEveryN > 0
    ? warnEveryN
    : DEFAULT_IDENTITY_WARN_CYCLES;
  // Notify once per episode, but only after the grace period — see
  // IDENTITY_NOTIFY_AFTER_CYCLES. `notified` latches only when we actually
  // notify, so the grace window does not silently consume the episode's one
  // notification.
  // The grace period is a STARTUP allowance, not a per-episode one. Once
  // identity has resolved even once, any later unresolved cycle is a genuine
  // regression and notifies immediately — otherwise a flapping identity that
  // never reaches the grace threshold would be silent forever.
  const notify =
    !prev.notified &&
    (prev.everResolved || cycles >= IDENTITY_NOTIFY_AFTER_CYCLES);
  return {
    state: {
      notified: prev.notified || notify,
      cycles,
      everResolved: prev.everResolved,
    },
    notify,
    warn: cycles === 1 || cycles % n === 0,
    recovered: false,
  };
}

// --- Forward rule (disc forward #68) -----------------------------------------
//
// A per-forwarder LOCAL rule, re-read every poll cycle (like the identity file
// and the kill/auth sentinels) so an agent can install / change / remove it at
// runtime with no watcher restart. `null` = no rule = today's behavior, exactly.

let cachedForwardRule: ForwardRule | null = null;

/** The forward rule in effect for the current cycle (null = notify locally). */
export function currentForwardRule(): ForwardRule | null {
  return cachedForwardRule;
}

/**
 * Re-resolve the forward rule and update the cache when it changes. Logs on
 * transition. Returns true if the rule changed this cycle.
 */
export function refreshForwardRule(): boolean {
  const next = resolveForwardRule();
  if (JSON.stringify(next) === JSON.stringify(cachedForwardRule)) {
    return false;
  }
  log.info("state_change", {
    what: "forward_rule",
    to: next ? (next.target.label ?? next.target.session ?? "target") : "off",
  });
  cachedForwardRule = next;
  return true;
}

// --- Notify-step routing (disc forward #68 + //directmsg #69) -----------------
//
// The single decision the poll loop makes for an already-addressed doorbell:
// forward it to the grunt, or notify/deliver it to the local agent? Precedence
// is `directmsg > forward > fanout`:
//
//   1. //directmsg addressed to the local agent  → "notify"  (the #69 override:
//      a red-phone must-see is NEVER forwarded away — this is what makes forward
//      safe). Checked FIRST so a forward rule can't swallow it.
//   2. an active forward rule that matches         → "forward" (the #68 path,
//      shouldForward unchanged: exclude gate + loop guard).
//   3. otherwise                                   → "notify"  (default fanout).
//
// With `rule === null` it short-circuits to "notify" without inspecting the
// message, so the no-forward-rule case is byte-for-byte the pre-#68 path.
export type NotifyRoute = "forward" | "notify";

export function decideNotifyRoute(
  msg: ForwardableMessage,
  channel: ForwardableChannel,
  rule: ForwardRule | null,
  identity: AgentIdentity
): NotifyRoute {
  if (!rule) return "notify";
  // #69 precedence: a local-addressed directmsg overrides the forward rule.
  if (directMsgOverridesForward(msg.content, identity)) return "notify";
  // #68 forward decision, unchanged.
  return shouldForward(msg, channel, rule) ? "forward" : "notify";
}

// --- Discord API helpers -----------------------------------------------------

/**
 * Non-secret description of an Authorization header, for 401 diagnostics (#54).
 *
 * Returns ONLY the length and the scheme prefix. This is deliberately the whole
 * surface: a length does not narrow a fixed-length credential, and the prefix is
 * the public scheme name (`"Bot "`). Together they answer "is this process
 * sending a well-formed header?" without putting any part of the secret into a
 * log file that is not treated as a secret store.
 *
 * Do NOT extend this to include token characters, a hash of the token, or a
 * longer slice. A hash is still a credential oracle across log exports, and a
 * longer slice narrows the keyspace directly.
 */
export function describeAuthHeader(
  authHeader: string
): { auth_len: number; auth_prefix: string } {
  return {
    auth_len: authHeader.length,
    auth_prefix: authHeader.slice(0, 4),
  };
}

/**
 * Read and parse an error response body, best-effort. Returns the parsed JSON,
 * or `undefined` if the body is absent/unreadable/not JSON.
 *
 * Needed because a bare status code cannot tell us WHO answered (#48): a 404
 * from Discord and a 404 from an unrouted path on the scream-hole proxy are the
 * same number with different meanings, and only the body distinguishes them.
 * Never throws — a body we can't read simply yields `undefined`, which callers
 * must treat as "unidentified speaker".
 */
async function readErrorBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text.slice(0, 200) };
    }
  } catch {
    return undefined;
  }
}

async function apiGet(
  endpoint: string,
  authHeader: string
): Promise<
  | { ok: true; data: unknown }
  | { ok: false; status: number; retryAfter?: number; body?: unknown }
> {
  const service = API_BASE === DISCORD_API_BASE ? "discord" : "scream-hole";
  // Strip query params for logging (path only)
  const pathOnly = endpoint.split("?")[0];
  const t0 = performance.now();
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { Authorization: authHeader },
  });
  const ms = Math.round(performance.now() - t0);
  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get("Retry-After") ?? "5");
    log.warn("api_call", { method: "GET", endpoint: pathOnly, status: 429, ms, service });
    engageKillSwitch(retryAfter);
    return { ok: false, status: 429, retryAfter };
  }
  if (res.status === 401) {
    // Bot token is expired or revoked. Engage the auth-failure circuit
    // breaker so subsequent poll cycles short-circuit instead of spamming
    // 401s every 15 seconds. Recovery requires operator intervention
    // (new token + watcher restart).
    // Auth diagnostics (#54): emit NON-SECRET properties of the credential this
    // process actually sent. A persistent 401 on some watchers, while a manual
    // probe with the same token succeeds, is otherwise undiagnosable — these two
    // fields discriminate "credential construction differs on this process" from
    // "credential is identical, so the cause is transport/environment" within a
    // single poll cycle.
    //
    // NEVER log the token or any substring beyond the scheme prefix. `auth_len`
    // is a length, `auth_prefix` is the 4-char scheme (`"Bot "`) — neither
    // narrows the secret. mcp.jsonl is not treated as a secret store.
    log.error("api_call", {
      method: "GET",
      endpoint: pathOnly,
      status: 401,
      ms,
      service,
      ...describeAuthHeader(authHeader),
    });
    engageAuthFailed();
    return { ok: false, status: 401 };
  }
  if (!res.ok) {
    log.warn("api_call", { method: "GET", endpoint: pathOnly, status: res.status, ms, service });
    // Surface the body so callers can tell WHO answered (#48) — origin vs proxy.
    return { ok: false, status: res.status, body: await readErrorBody(res) };
  }
  log.debug("api_call", { method: "GET", endpoint: pathOnly, status: res.status, ms, service });
  return { ok: true, data: await res.json() };
}

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  url: string;
  size: number;
}

export interface DiscordMessage {
  id: string;
  author: { id: string; username: string };
  content: string;
  timestamp: string;
  attachments?: DiscordAttachment[];
  /**
   * Populated by Discord when this message is a reply (type 19). Contains the
   * parent message object so the watcher can route replies to whoever signed
   * the parent, even when the reply text doesn't include an @<dev-name> token.
   * `null` when the parent has been deleted.
   */
  referenced_message?: DiscordMessage | null;
}

// --- Voice message STT -------------------------------------------------------

/** Strip punctuation from a lowercased token, keeping only routing-key chars. */
export function stripTokenPunctuation(token: string): string {
  return token.replace(/[^a-z0-9@_-]/g, "");
}

/**
 * Strip fenced code blocks and inline code spans from a markdown string.
 * Used to prevent false-positive signature matches when a message quotes
 * the signature format in a code block (e.g. "the format is `— **morpheus**`").
 */
function stripMarkdownCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "") // fenced code blocks
    .replace(/`[^`\n]*`/g, "");     // inline code spans
}

/**
 * Check whether a message is a reply to another message we (the current
 * agent identity) signed. Looks at `referenced_message.content` for the
 * signature pattern `— **<dev-name>**` (case-insensitive), with markdown
 * code blocks and inline code spans stripped first to avoid false positives
 * from quoted signature examples.
 *
 * Replies in Discord carry their addressing in `referenced_message`, not in
 * the reply's text content. Without this check, a reply like "good point" to
 * a message we just posted would be silently dropped by the token-based
 * filter — even though Discord's UI clearly shows it as directed at us.
 */
export function isReplyToOurSignature(
  msg: DiscordMessage,
  identity: AgentIdentity
): boolean {
  const parent = msg.referenced_message;
  if (!parent || !parent.content || !identity.devName) return false;
  const cleaned = stripMarkdownCode(parent.content).toLowerCase();
  return cleaned.includes(`— **${identity.devName.toLowerCase()}**`);
}

/**
 * Pure-function targeted routing filter. Returns true if the message should
 * be delivered as a wake-up notification to the current agent, false otherwise.
 *
 * Decision order (the fail-closed identity check intentionally precedes
 * VERBOSE so that an unattributed agent gets nothing even in verbose mode —
 * VERBOSE bypasses targeted routing, not security boundaries):
 *   1. Empty messages (no content, no attachments) → drop
 *   2. Self-echo (message contains our own signature) → drop
 *   3. Identity unresolved (no devName, no devTeam) → drop (fail closed,
 *      prevents cross-project leakage to unattributed sessions)
 *   4. VERBOSE mode bypasses targeted routing → deliver
 *   5. Addressed via @agents (or @all while acceptAll), @<dev-team>, @<dev-name>,
 *      or reply to a message we signed → deliver
 *   6. Otherwise → drop
 */
export function shouldDeliverMessage(
  msg: DiscordMessage,
  identity: AgentIdentity,
  options: { verbose?: boolean; acceptAll?: boolean } = {}
): boolean {
  const acceptAll = options.acceptAll ?? ACCEPT_ALL;
  // 1. Skip empty messages (e.g. bot embeds, sticker-only)
  if (!msg.content.trim() && !msg.attachments?.length) {
    return false;
  }

  // 2. Self-echo filter — drop messages containing our own signature
  if (
    identity.devName &&
    msg.content
      .toLowerCase()
      .includes(`— **${identity.devName.toLowerCase()}**`)
  ) {
    return false;
  }

  // 3. Fail closed on ANY unresolved identity field (devName OR devTeam null/
  // empty), not only both-null — a partial identity can still match over-broad.
  // Deaf > over-broad. Precedes VERBOSE so the boundary holds even in verbose.
  if (!identity.devName || !identity.devTeam) {
    return false;
  }

  // 4. VERBOSE mode bypasses targeted routing entirely
  if (options.verbose) {
    return true;
  }

  // 5. Token-based addressing
  const tokens = msg.content
    .toLowerCase()
    .split(/\s+/)
    .map(stripTokenPunctuation);
  const isAddressedToAll =
    tokens.includes("@agents") || (acceptAll && tokens.includes("@all"));
  const isAddressedToTeam = identity.devTeam
    ? tokens.includes(`@${identity.devTeam.toLowerCase()}`)
    : false;
  const isAddressedToMe = identity.devName
    ? tokens.includes(`@${identity.devName.toLowerCase()}`)
    : false;
  const replyToUs = isReplyToOurSignature(msg, identity);

  return isAddressedToAll || isAddressedToTeam || isAddressedToMe || replyToUs;
}

const STT_ENDPOINT = process.env.STT_ENDPOINT ?? "http://archer:8300/v1/audio/transcriptions";
const STT_MODEL = process.env.STT_MODEL ?? "deepdml/faster-whisper-large-v3-turbo-ct2";

export async function transcribeAudioAttachments(
  msg: DiscordMessage,
  _authHeader: string
): Promise<string | null> {
  if (!msg.attachments?.length) return null;

  const audioAttachments = msg.attachments.filter(
    (a) => a.content_type?.startsWith("audio/")
  );
  if (audioAttachments.length === 0) return null;

  const transcriptions: string[] = [];

  for (const attachment of audioAttachments) {
    try {
      // Download audio
      const audioResp = await fetch(attachment.url);
      if (!audioResp.ok) {
        log.warn("api_call", { method: "GET", endpoint: "audio_attachment", status: audioResp.status, service: "discord" });
        transcriptions.push(`[voice memo attached — download failed]`);
        continue;
      }
      const audioBuffer = await audioResp.arrayBuffer();

      // Transcribe via Whisper
      const form = new FormData();
      form.append("file", new Blob([audioBuffer]), attachment.filename);
      form.append("model", STT_MODEL);

      const sttResp = await fetch(STT_ENDPOINT, {
        method: "POST",
        body: form,
      });

      if (!sttResp.ok) {
        log.warn("api_call", { method: "POST", endpoint: "/v1/audio/transcriptions", status: sttResp.status, service: "stt" });
        transcriptions.push(`[voice memo attached — transcription failed]`);
        continue;
      }

      const result = (await sttResp.json()) as { text: string };
      if (result.text?.trim()) {
        transcriptions.push(`[voice memo from ${msg.author.username}: "${result.text.trim()}"]`);
      }
    } catch (err) {
      log.error("api_call", { method: "POST", endpoint: "/v1/audio/transcriptions", service: "stt" }, String(err));
      transcriptions.push(`[voice memo attached — transcription failed]`);
    }
  }

  return transcriptions.length > 0 ? transcriptions.join("\n") : null;
}

// --- Snowflake helper --------------------------------------------------------

const DISCORD_EPOCH = 1420070400000n;

/**
 * Generate a snowflake ID for a given timestamp (ms since Unix epoch).
 * Used for baseline initialization when going through scream-hole,
 * which requires the `after` parameter on GET /messages.
 */
function timestampToSnowflake(timestampMs: number): string {
  return String((BigInt(timestampMs) - DISCORD_EPOCH) << 22n);
}

/**
 * Build the messages endpoint URL for a single recent-message fetch.
 * When going through scream-hole, includes `after` (5 minutes ago).
 * When direct to Discord, uses the original `?limit=1` pattern.
 */
function recentMessageUrl(channelId: string): string {
  if (API_BASE !== DISCORD_API_BASE) {
    // Through scream-hole — `after` is required. Use 4h window to match
    // scream-hole's cache window — ensures baseline works for low-traffic channels.
    const fourHoursAgo = timestampToSnowflake(Date.now() - 4 * 60 * 60_000);
    return `/channels/${channelId}/messages?after=${fourHoursAgo}&limit=1`;
  }
  return `/channels/${channelId}/messages?limit=1`;
}

// --- State -------------------------------------------------------------------

let watchedChannels: DiscordChannel[] = [];
const lastSeenMessageId = new Map<string, string>();

// Deduplication: track recently delivered message IDs so a message an upstream
// returns twice is never delivered twice. A guard only: the cursor, not this set,
// is what keeps a poll from asking for what it already has (#92), so a hit means
// the upstream replayed something; pollCycle counts it and logs it. Bounded to prevent unbounded
// memory growth — oldest entries evicted via FIFO.
const DELIVERED_SET_MAX = 500;
const deliveredMessageIds = new Set<string>();
const deliveredOrder: string[] = [];
let dedupHits = 0;

function markDelivered(messageId: string): void {
  if (deliveredMessageIds.has(messageId)) return;
  deliveredMessageIds.add(messageId);
  deliveredOrder.push(messageId);
  while (deliveredOrder.length > DELIVERED_SET_MAX) {
    deliveredMessageIds.delete(deliveredOrder.shift()!);
  }
}

/**
 * Reset for tests — the poll state is process-global otherwise. Sets the
 * watched channels and clears every cursor and the delivered set, so a test can
 * drive checkForNewMessages / doorbellCycle from a known un-baselined start.
 * `apiBase` selects the transport (a scream-hole base, or direct by default).
 */
export function __resetPollStateForTests(
  channels: DiscordChannel[],
  apiBase: string = DISCORD_API_BASE
): void {
  watchedChannels = channels;
  API_BASE = apiBase;
  lastSeenMessageId.clear();
  committedCursor.clear();
  cursorSaveFailing = false;
  deliveredMessageIds.clear();
  deliveredOrder.length = 0;
  dedupHits = 0;
}

/** For tests: how many polled messages the dedup set has caught since the reset. */
export function __dedupHitsForTests(): number {
  return dedupHits;
}

/**
 * The newest message's id, by snowflake value (#92). Never by position: Discord
 * pages newest-first and scream-hole oldest-first. `messages` must be non-empty.
 */
export function newestId(messages: DiscordMessage[]): string {
  let max = messages[0].id;
  for (const msg of messages) {
    if (BigInt(msg.id) > BigInt(max)) max = msg.id;
  }
  return max;
}

/** A copy of `messages`, oldest first by snowflake value, whatever order they came in (#92). */
export function byIdAscending(messages: DiscordMessage[]): DiscordMessage[] {
  return [...messages].sort((a, b) => {
    const x = BigInt(a.id);
    const y = BigInt(b.id);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

// --- Persisted cursor (#83) --------------------------------------------------
//
// Without this, every start re-seeds each channel to its newest message, so
// whatever arrived while the watcher was down is skipped. That bites hardest on
// doorbell-oneshot (cc-workflow), which starts a fresh `doorbell` on every
// re-arm: each message posted while the agent handled the last batch was lost.
//
// The file holds, per channel, the newest message id whose cycle has FINISHED
// with it: delivered, filtered, or forwarded. That is `committedCursor`, not
// `lastSeenMessageId`: the poll core advances lastSeenMessageId before it
// delivers, and persisting that would let a kill between the two skip messages
// for good. A channel is committed (and the file saved) right after its delivery
// pass, in the same synchronous run as the doorbell's last stdout write, so the
// SIGTERM the oneshot sends after its drain can only land when the file already
// covers every line written, and no channel polled later in the cycle.
//
// Each transport has its OWN file. The MCP watcher is registered at user scope,
// so it runs in every session, including the no-`--channels` sessions the
// doorbell exists for. There its notifications go to a sink nobody reads, yet
// return normally, so it commits every addressed message as delivered. Sharing
// one file would let it move the doorbell's resume point past messages the
// doorbell never printed: #83's loss again, in the doorbell's own setting.

/**
 * How old a saved cursor may be and still be resumed: scream-hole's cache
 * window, the same 4 h recentMessageUrl uses. An older cursor would ask for
 * history the proxy no longer holds, and replay hours of traffic direct.
 */
export const CURSOR_MAX_AGE_MS = 4 * 60 * 60_000;

/** A saved_at this far in the future (clock skew) is still accepted. */
const CURSOR_FUTURE_TOLERANCE_MS = 60_000;

/** The two delivery transports. Each keeps its own saved cursor. */
export type Transport = "mcp" | "doorbell";

/** On-disk cursor shape. Identity and transport fields let a load reject a file that is not ours. */
export interface CursorFile {
  version: 1;
  saved_at: number;
  api_base: "direct" | "scream-hole";
  guild_id: string;
  dev_team: string;
  dev_name: string;
  transport: Transport;
  channels: Record<string, string>;
}

/** Newest message id per channel whose cycle has finished. What the file holds. */
const committedCursor = new Map<string, string>();

/** Latched while saves fail, so a read-only state dir logs once, not every 15 s. */
let cursorSaveFailing = false;

/** A file-name-safe form of one cursor-name component. */
function cursorNamePart(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * `${XDG_STATE_HOME:-$HOME/.local/state}/discord-watcher/cursor-<guild>-<team>-<name>-<transport>.json`,
 * or null when the identity is unresolved: such a session neither loads nor
 * saves. A relative XDG_STATE_HOME is ignored, as the XDG spec requires. Name
 * parts are sanitized, so two identities CAN share a name ("a.b" and "a_b");
 * the identity fields inside the file are what a load checks.
 *
 * The transport is in the NAME, not only in a field: both transports can run at
 * once, and a field check alone would have them overwrite each other's file
 * every cycle and reject it on every load, so neither would ever resume.
 */
export function cursorPath(
  identity: AgentIdentity,
  transport: Transport,
  guildId: string = GUILD_ID
): string | null {
  if (!identity.devName || !identity.devTeam) return null;
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".local", "state");
  const file =
    `cursor-${cursorNamePart(guildId)}-${cursorNamePart(identity.devTeam)}-` +
    `${cursorNamePart(identity.devName)}-${transport}.json`;
  return join(base, "discord-watcher", file);
}

function apiMode(): "direct" | "scream-hole" {
  return API_BASE === DISCORD_API_BASE ? "direct" : "scream-hole";
}

/**
 * Read the saved cursor for the current identity and guild. Returns the
 * channel → message id map to resume from, or null to baseline every channel as
 * before. A missing file is the normal first run and is silent; a stale,
 * unreadable or wrong-identity file is ignored with ONE warn line.
 *
 * `api_base` is NOT checked: a cursor is a Discord snowflake, and scream-hole
 * serves the same ids as Discord, so a cursor saved in one mode is exact in the
 * other. A change is logged at info level for the record.
 */
export function loadCursor(
  transport: Transport,
  now: number = Date.now()
): Map<string, string> | null {
  const path = cursorPath(cachedIdentity, transport);
  if (!path) {
    log.info("cursor", { action: "skipped", reason: "identity unresolved" });
    return null;
  }
  if (!existsSync(path)) return null;

  const ignore = (reason: string, extra: Record<string, unknown> = {}): null => {
    log.warn("cursor", { action: "ignored", reason, path, ...extra });
    return null;
  };

  let data: Partial<CursorFile>;
  try {
    data = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return ignore("unreadable");
  }
  if (typeof data !== "object" || data === null) return ignore("unreadable");
  if (data.version !== 1) return ignore("unknown version", { version: data.version });
  if (
    data.guild_id !== GUILD_ID ||
    data.dev_team !== cachedIdentity.devTeam ||
    data.dev_name !== cachedIdentity.devName
  ) {
    return ignore("wrong identity");
  }
  if (data.transport !== transport) {
    return ignore("wrong transport", { transport: data.transport });
  }
  const channels = data.channels;
  if (
    typeof channels !== "object" ||
    channels === null ||
    Array.isArray(channels) ||
    !Object.values(channels).every((id) => typeof id === "string" && /^\d+$/.test(id))
  ) {
    return ignore("unreadable");
  }
  const savedAt = data.saved_at;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) {
    return ignore("unreadable");
  }
  const ageMs = now - savedAt;
  if (ageMs > CURSOR_MAX_AGE_MS || ageMs < -CURSOR_FUTURE_TOLERANCE_MS) {
    return ignore("stale", { age_ms: ageMs, max_age_ms: CURSOR_MAX_AGE_MS });
  }
  if (data.api_base !== apiMode()) {
    log.info("cursor", { action: "api_base_changed", from: data.api_base, to: apiMode() });
  }
  return new Map(Object.entries(channels));
}

/**
 * Mark a channel's cursor final for this cycle. Returns true if it moved, so the
 * caller only rewrites the file when something changed mid-cycle.
 */
function commitChannel(channelId: string): boolean {
  const id = lastSeenMessageId.get(channelId);
  if (!id || committedCursor.get(channelId) === id) return false;
  committedCursor.set(channelId, id);
  return true;
}

/**
 * Write the committed cursor for every watched channel: a temp file in the same
 * directory, then a rename, so no reader ever sees half a file. Synchronous on
 * purpose (see the section comment). Never throws: a failed save costs the
 * resume, not the poll loop.
 */
export function saveCursor(transport: Transport, now: number = Date.now()): void {
  const path = cursorPath(cachedIdentity, transport);
  if (!path || !cachedIdentity.devName || !cachedIdentity.devTeam) return;
  const channels: Record<string, string> = {};
  for (const ch of watchedChannels) {
    const id = committedCursor.get(ch.id);
    if (id) channels[ch.id] = id;
  }
  const data: CursorFile = {
    version: 1,
    saved_at: now,
    api_base: apiMode(),
    guild_id: GUILD_ID,
    dev_team: cachedIdentity.devTeam,
    dev_name: cachedIdentity.devName,
    transport,
    channels,
  };
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data) + "\n");
    renameSync(tmp, path);
    if (cursorSaveFailing) {
      cursorSaveFailing = false;
      log.info("cursor", { action: "save_recovered", path });
    }
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    if (!cursorSaveFailing) {
      cursorSaveFailing = true;
      log.error("cursor", { action: "save_failed", path }, String(err));
    }
  }
}

// --- Channel discovery -------------------------------------------------------

/**
 * Deliver-layer channel scope check. A `null` allowlist ⇒ every channel is in
 * scope (backward-compatible). Otherwise a channel is in scope iff its id OR
 * name (case-insensitive) is in the allowlist.
 *
 * Scoping lives at the DELIVER layer, not the poll layer: the watcher must keep
 * polling every channel so `--dangerously-load-development-channels` can inject
 * (without that, nothing reaches any session). This gate only decides which
 * channels' messages are delivered as wake-ups, scoping each agent to its own
 * channels — which is the cross-team leak fix (#31).
 *
 * Case-insensitive on names: Discord lowercases text-channel names in its UI,
 * but the REST API can return mixed case, so an exact-case match would silently
 * over-filter. IDs are numeric strings, so lowercasing them is a harmless no-op.
 */
export function isChannelInScope(
  channel: { id: string; name: string },
  allowlist: string[] | null
): boolean {
  if (!allowlist) return true;
  const set = new Set(allowlist.map((s) => s.toLowerCase()));
  return (
    set.has(channel.id.toLowerCase()) || set.has(channel.name.toLowerCase())
  );
}

async function fetchTextChannels(authHeader: string): Promise<DiscordChannel[]> {
  const result = await apiGet(`/guilds/${GUILD_ID}/channels`, authHeader);
  if (!result.ok) {
    throw new Error(`Failed to fetch channels: HTTP ${result.status}`);
  }
  // Poll EVERY text channel — required so --dangerously-load-development-channels
  // can inject. Cross-team scoping happens at the deliver layer (isChannelInScope
  // at the delivery point), not here.
  return (result.data as DiscordChannel[]).filter((c) => c.type === 0);
}

/** How far behind "now" an empty channel's cursor starts. See baselineChannel. */
const BASELINE_EMPTY_MARGIN_MS = 60_000;

/**
 * Seed a channel's cursor so later polls deliver only what arrives after it.
 * The ONE baseline path — startup (initializeBaselines), channel refresh, the
 * MCP poll's first-poll branch, and the doorbell's un-baselined branch all call
 * this, so they cannot drift apart again (#81).
 *
 * On an OK fetch:
 *   - one or more messages → cursor at the newest, and every returned message
 *     is marked delivered: it is the boundary and must never be replayed.
 *   - NO messages → cursor at a snowflake for "now" minus BASELINE_EMPTY_MARGIN_MS.
 *     Without this the channel stays un-baselined, the baseline fetch re-runs
 *     every cycle, and the first message ever to arrive becomes the baseline and
 *     is swallowed (#81). Through scream-hole any channel quiet for 4h comes back
 *     empty (recentMessageUrl).
 *     The margin covers what "now" cannot promise: a host clock ahead of
 *     Discord's, and scream-hole's ingest lag. A message posted just before the
 *     fetch but not yet visible to it would otherwise sit below the cursor and be
 *     lost. Anything the margin admits is a message the empty fetch never
 *     returned, so delivering it is correct, not a replay; deliveredMessageIds
 *     still guards duplicates.
 *
 * A non-OK fetch leaves the channel un-baselined, so the next cycle retries;
 * a 429 is logged (apiGet has already engaged the kill switch). Throws only if
 * the fetch itself throws — each caller keeps its own per-channel catch.
 */
async function baselineChannel(
  channel: DiscordChannel,
  authHeader: string
): Promise<void> {
  const asOf = Date.now() - BASELINE_EMPTY_MARGIN_MS;
  const result = await apiGet(recentMessageUrl(channel.id), authHeader);
  if (!result.ok) {
    if (result.status === 429 && result.retryAfter) {
      log.warn("api_call", {
        method: "GET",
        endpoint: `/channels/${channel.id}/messages`,
        status: 429,
        service: API_BASE === DISCORD_API_BASE ? "direct" : "scream-hole",
        channel: channel.name,
      });
    }
    return;
  }
  const messages = result.data as DiscordMessage[];
  // A baseline delivers nothing, so its cursor is final at once (#83).
  if (messages.length === 0) {
    lastSeenMessageId.set(channel.id, timestampToSnowflake(asOf));
  } else {
    lastSeenMessageId.set(channel.id, newestId(messages));
    for (const msg of messages) markDelivered(msg.id);
  }
  commitChannel(channel.id);
}

/**
 * Startup, both modes: resume each channel from this transport's saved cursor
 * (#83) when one is valid, and baseline the rest as before. Returns how many
 * channels resumed.
 */
export async function initializeBaselines(
  authHeader: string,
  transport: Transport
): Promise<number> {
  const saved = loadCursor(transport);
  let resumed = 0;
  for (const channel of watchedChannels) {
    const savedId = saved?.get(channel.id);
    if (savedId) {
      lastSeenMessageId.set(channel.id, savedId);
      commitChannel(channel.id);
      resumed++;
      continue;
    }
    try {
      await baselineChannel(channel, authHeader);
    } catch {
      // Channel might not be readable — skip it
    }
  }
  if (saved) {
    log.info("cursor", {
      action: "resumed",
      channels: resumed,
      baselined: watchedChannels.length - resumed,
    });
  }
  return resumed;
}

// --- Polling -----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns a random delay (in milliseconds) to insert between per-channel
 * polls in a single cycle. Used to spread Discord API calls and avoid the
 * tight-burst pattern that can trip global rate limits on guilds with many
 * channels.
 *
 * Range: [INTER_CHANNEL_JITTER_MIN_MS, INTER_CHANNEL_JITTER_MAX_MS).
 */
export function nextChannelJitterMs(): number {
  return (
    INTER_CHANNEL_JITTER_MIN_MS +
    Math.random() * (INTER_CHANNEL_JITTER_MAX_MS - INTER_CHANNEL_JITTER_MIN_MS)
  );
}

async function fetchAllNewMessages(
  channelId: string,
  afterId: string,
  authHeader: string
): Promise<DiscordMessage[]> {
  const allMessages: DiscordMessage[] = [];
  let cursor = afterId;
  // scream-hole answers `after`+`limit` with the NEWEST `limit` matches and drops
  // the older ones, so paging could never reach them (#92). Without `limit` it
  // returns everything cached after the cursor, bounded by its cache window, in
  // one response. Discord caps a page, so direct mode still paginates.
  const viaScreamHole = API_BASE !== DISCORD_API_BASE;

  // Paginate to collect all new messages (prevents silent drops on bursts)
  while (true) {
    const result = await apiGet(
      viaScreamHole
        ? `/channels/${channelId}/messages?after=${cursor}`
        : `/channels/${channelId}/messages?after=${cursor}&limit=${MESSAGES_PER_PAGE}`,
      authHeader
    );

    if (!result.ok) {
      if (result.status === 429 && result.retryAfter) {
        log.warn("api_call", { method: "GET", endpoint: `/channels/${channelId}/messages`, status: 429, retry_after_s: result.retryAfter, service: API_BASE === DISCORD_API_BASE ? "discord" : "scream-hole" });
        await new Promise((r) => setTimeout(r, result.retryAfter! * 1000));
        continue;
      }
      if (result.status === 401) {
        // Auth failure already engaged by apiGet via engageAuthFailed().
        // Return what we've collected so far (typically empty) and let
        // the caller's checkAuthFailed() guard handle the cleanup. Throwing
        // here would cause checkForNewMessages's per-channel catch to log
        // a misleading "Error polling #<channel>" line that looks like a
        // crash, immediately after the "AUTH FAILURE" line we want.
        return byIdAscending(allMessages);
      }
      throw new Error(`Discord API HTTP ${result.status}`);
    }

    const messages = result.data as DiscordMessage[];
    if (messages.length === 0) break;

    allMessages.push(...messages);

    // One unlimited scream-hole response is the whole set; a short Discord page
    // means the channel is drained.
    if (viaScreamHole || messages.length < MESSAGES_PER_PAGE) break;

    // Page on from the newest message of this page, whatever its order
    cursor = newestId(messages);
  }

  return byIdAscending(allMessages);
}

/**
 * Discord error codes that mean "this specific resource does not exist".
 * Module-private: an exported mutable Set could be `.add(0)`-ed by an importer,
 * silently restoring the very bug this closes.
 * Deliberately an allowlist, not a range or a truthiness test — see
 * {@link classifyFetchFailure}. `10008` unknown message, `10003` unknown channel.
 */
const DISCORD_RESOURCE_GONE_CODES = new Set([10008, 10003]);

/**
 * Classify a non-OK fetch as `gone` (the message really was deleted — drop it)
 * or `error` (transient / unknown — keep it, fall back to a local notify).
 *
 * WHY THIS IS NOT `status === 404` (#48). A bare 404 does not say who answered.
 * When the watcher routes through the scream-hole proxy, an *unrouted path*
 * returns the proxy's catch-all 404 — indistinguishable by status from Discord
 * saying "this message was deleted". Treating that as `gone` silently dropped
 * every forwarded message on a proxied host for 43+ hours in production.
 *
 * So we identify the speaker POSITIVELY, never by absence:
 *
 *   - Discord says the resource itself is gone, via one of two specific codes:
 *     `10008` unknown message or `10003` unknown channel → `gone`.
 *
 *     It must be those codes and not merely "a numeric `code`". Verified against
 *     the live API: an unrouted or malformed path returns
 *     `404 {"message":"404: Not Found","code":0}` — a *generic* 404 that says
 *     nothing about the message existing. Accepting any number would classify
 *     that as a deletion and silently drop the message, which is #48's exact
 *     failure shape with Discord as the speaker instead of the proxy (a
 *     malformed message id or a route regression would be enough to trigger it).
 *     `{"code":404,"message":"Not Found"}` — a common gateway envelope — has the
 *     same problem. An allowlist is the only shape that actually identifies
 *     "this specific resource is gone" rather than "some JSON API said 404".
 *   - An intermediary identifies itself (e.g. `{"proxy":"scream-hole"}`) → it is
 *     not the origin, so it cannot testify that the message was deleted →
 *     `error`.
 *   - ANYTHING ELSE — no body, unparseable body, unrecognised shape, a future
 *     proxy we've never seen — is an unidentified speaker → `error`.
 *
 * The third branch is the load-bearing one and is deliberately the DEFAULT:
 * only a positively-identified origin 404 may ever drop a message. Failing
 * toward keeping the message costs at most one spurious local notify; failing
 * the other way loses it silently forever.
 *
 * This is also why the check is not keyed on the proxy's status code: scream-hole
 * may change its catch-all from 404 to 501, and this classifier stays correct
 * either way because it never relied on the number.
 */
export function classifyFetchFailure(
  status: number,
  body: unknown
): "gone" | "error" {
  if (status !== 404) return "error";
  if (typeof body !== "object" || body === null) return "error";
  const b = body as Record<string, unknown>;
  // An intermediary announcing itself is never authoritative about deletion.
  if (typeof b.proxy === "string") return "error";
  // Only Discord's specific resource-gone codes count. NOT "any numeric code" —
  // Discord's own generic 404 carries `code: 0`.
  if (typeof b.code === "number" && DISCORD_RESOURCE_GONE_CODES.has(b.code)) {
    return "gone";
  }
  return "error";
}

/**
 * Fetch a single message by (channel, messageId) — GET
 * /channels/{channelId}/messages/{messageId}.
 *
 * The (channel, msgid) single-fetch primitive #66 adds to the watcher. `disc
 * forward` (#68) is a watcher feature: the forwarder runs inline in the notify
 * path, so when a forward rule matches it must fetch the FULL message content
 * here — the watcher already owns `apiGet` + `authHeader` and has NO IPC link to
 * disc-server to borrow one (the two components coordinate only via files). The
 * peer disc-server exposes the same primitive to agents as `disc_read`'s
 * `message_id` param; this is the in-process counterpart for the forwarder.
 *
 * Returns a discriminated {@link FetchMessageResult}: `found` with the message,
 * `gone` only when the failure is positively identified as Discord saying the
 * resource is gone (see classifyFetchFailure — NOT merely a 404, #48), or
 * `error` on any other failure (403 / 401 / 429 / 5xx, plus a network / timeout
 * throw). The distinction is load-bearing for the forward path (#44): a `gone`
 * message is dropped, but an `error` is transient and the addressed message must
 * NOT be lost — the forwarder falls back to a local notify instead.
 */
export async function fetchMessageById(
  channelId: string,
  messageId: string,
  authHeader: string
): Promise<FetchMessageResult<DiscordMessage>> {
  try {
    const result = await apiGet(
      `/channels/${channelId}/messages/${messageId}`,
      authHeader
    );
    if (result.ok) {
      return { kind: "found", message: result.data as DiscordMessage };
    }
    return { kind: classifyFetchFailure(result.status, result.body) };
  } catch {
    // Network / timeout — the fetch never completed. Transient by definition.
    return { kind: "error" };
  }
}

/**
 * Refresh the watched channel list. Honors both circuit breakers — when the
 * watcher is in 429 cooldown OR has hit a permanent 401 auth failure, this
 * is a no-op so the refresh timer doesn't independently re-burst the API
 * while the main poll loop is paused.
 *
 * Mutates module-level `watchedChannels` and `lastSeenMessageId` on
 * successful refresh. Exported so the circuit-breaker short-circuits can be
 * exercised in unit tests.
 */
export async function refreshChannelList(authHeader: string): Promise<void> {
  if (checkKillSwitch() === "active") return;
  if (checkAuthFailed()) return;

  const fresh = await fetchTextChannels(authHeader);
  for (const ch of fresh) {
    // Re-check both circuit breakers between baseline calls — if a baseline
    // request inside this loop trips a 429 OR a 401, we should stop firing
    // more requests in the same refresh cycle rather than continue bursting
    // through every newly discovered channel.
    if (checkKillSwitch() === "active") break;
    if (checkAuthFailed()) break;

    if (!lastSeenMessageId.has(ch.id)) {
      try {
        await baselineChannel(ch, authHeader);
      } catch {
        // skip unreadable
      }
    }
  }
  watchedChannels = fresh;
  log.info("state_change", { what: "channels", to: "refreshed", channels: fresh.length });
}

// One-time MCP notification flag for auth failure (see mcpSink.authFailed). The
// notification is sent once per process so a Claude session is alerted exactly
// once that the watcher has stopped delivering messages due to a bad token.
// Reset on process restart (module re-import) — paired with clearAuthFailed().
let authFailureNotificationSent = false;

// Live breaker state for the unresolved-identity episode (#28). Unlike the auth
// sentinel this is in-process only: identity self-heals, so the state must not
// survive a restart that may itself have fixed the problem.
let identityBreaker: IdentityBreakerState = { ...INITIAL_IDENTITY_BREAKER };

/** Reset for tests — the module-level breaker is process-global otherwise. */
export function __resetIdentityBreakerForTests(): void {
  identityBreaker = { ...INITIAL_IDENTITY_BREAKER };
}

/**
 * Observe the resolved/unresolved identity state for this poll cycle and make
 * an outage audible: one sink alert per episode, a throttled warn log while it
 * persists, and an info log on recovery. Both transports run this (#82).
 *
 * Delivery semantics are untouched — shouldDeliverMessage still fails closed.
 * This is purely the missing signal.
 */
async function reportIdentity(sink: PollSink): Promise<void> {
  const resolved = Boolean(cachedIdentity.devName && cachedIdentity.devTeam);
  const step = stepIdentityBreaker(
    identityBreaker,
    resolved,
    identityWarnCycles()
  );
  const cycles = identityBreaker.cycles;
  identityBreaker = step.state;

  if (step.recovered) {
    log.info("state_change", {
      what: "identity",
      to: "resolved",
      after_unresolved_cycles: cycles,
      agent: `${cachedIdentity.devName}/${cachedIdentity.devTeam}`,
    });
    return;
  }

  const paths = identityPaths();

  if (step.warn) {
    // Distinct event name from resolveIdentity's per-cycle `identity_unresolved`
    // debug line: a log-based alert grepping the event name must be able to match
    // the BREAKER (outage, warn-level, carries unresolved_cycles) without also
    // matching the routine debug breadcrumb.
    log.warn("identity_outage", {
      project_root: paths.projectRoot,
      tried: [paths.durableFile, paths.legacyTmpFile],
      unresolved_cycles: step.state.cycles,
      delivery: "suspended",
    });
  }

  if (step.notify) {
    try {
      await sink.identityUnresolved(paths);
    } catch (err) {
      // The episode's one alert did NOT reach the session. Un-latch so the next
      // cycle retries, rather than letting a transport hiccup consume the only
      // alert for an outage that may last days.
      identityBreaker = { ...identityBreaker, notified: false };
      log.error(
        "state_change",
        { what: "identity", to: "notification_failed" },
        String(err)
      );
    }
  }
}

/** MCP-mode identity report. Kept as the tested entry point for #28's wiring. */
export async function reportIdentityState(server: Server): Promise<void> {
  await reportIdentity(mcpSink(server));
}

// --- Poll core (#82) ---------------------------------------------------------
//
// ONE poll cycle for both transports. The MCP watcher and the doorbell used to
// carry two copies of this loop, and they drifted: the doorbell never reported
// an unresolved identity (silently deaf, defeating #28) and never transcribed
// voice memos. The two modes now differ only in their PollSink.
//
// Forward/directmsg routing (#68/#69) runs in the core, not a sink, so a forward
// rule behaves the same whichever transport the agent uses. The deliver-router
// is transport-independent, and directmsg > forward > fanout plus the fallback
// to local delivery on a failed forward keep an addressed message from being lost.

/** Where a poll cycle's output goes. The two transports differ only here. */
export interface PollSink {
  /** Which transport this is: each keeps its own saved cursor (#83). */
  readonly transport: Transport;
  /** One local message, transcription prepended. Sync sinks return nothing: no await between lines. */
  deliver(channel: DiscordChannel, msg: DiscordMessage, content: string): void | Promise<void>;
  /** The identity breaker fired (once per episode). A throw re-arms it for next cycle. */
  identityUnresolved(paths: ReturnType<typeof identityPaths>): Promise<void>;
  /** The auth breaker is engaged. Called every cycle that sees it; the sink latches. */
  authFailed(): Promise<void>;
}

/**
 * One poll pass: kill switch and auth breaker, identity refresh and report,
 * forward-rule refresh, then per channel (with jitter) baseline-or-fetch, cursor
 * advance, scope check, dedup, the delivery gate, routing and transcription,
 * and finally the cycle log.
 */
export async function pollCycle(authHeader: string, sink: PollSink): Promise<void> {
  if (checkKillSwitch() === "active") return;

  // A revoked or expired token suspends polling for this process; the sink
  // announces it once, then every later cycle short-circuits silently.
  if (checkAuthFailed()) {
    await sink.authFailed();
    return;
  }

  // Re-resolve identity each cycle: the agent may pick/re-roll its name after
  // the process starts, and the durable identity file can appear post-boot.
  // refreshIdentity() updates the cache AND logs the transition (the null-at-boot
  // self-heal).
  refreshIdentity();

  // Fail LOUD on unresolved identity (#28). Delivery still fails closed below —
  // this only makes the silence observable, so a wiped identity file surfaces as
  // an event instead of a quiet multi-day outage.
  await reportIdentity(sink);

  // Re-read the forward rule each cycle (#68) — installable/removable at runtime
  // without a watcher restart, same live-read lifecycle as the identity file.
  refreshForwardRule();

  const cycleVia = API_BASE === DISCORD_API_BASE ? "direct" : "scream-hole";
  log.debug("poll", { via: cycleVia, api_base: API_BASE });

  const cycleT0 = performance.now();
  let cycleNewMessages = 0;

  let isFirstChannel = true;
  for (const channel of watchedChannels) {
    // Inter-channel jitter — spread outbound API calls across the cycle
    // window so guilds with many channels don't fire 20+ requests in a
    // tight burst. Skipped on the first channel (no preceding work) and
    // applied via top-of-loop placement so it covers ALL code paths in
    // the iteration body, including the early `continue`s below.
    if (!isFirstChannel) {
      await sleep(nextChannelJitterMs());
    }
    isFirstChannel = false;

    const ready: { msg: DiscordMessage; content: string }[] = [];
    // A channel whose pass threw keeps its previous saved entry (#83), until its
    // next good pass. In-process the cursor has already moved and the ids are
    // marked delivered, so that pass commits past them: the hold-back only helps
    // a restart that comes first. Rolling back instead would let one poison
    // message stall its channel forever.
    let channelFailed = false;
    // Messages the upstream returned that this channel had already seen
    let replayed = 0;
    try {
      const lastId = lastSeenMessageId.get(channel.id);

      // First poll for this channel — just set baseline
      if (!lastId) {
        await baselineChannel(channel, authHeader);
        continue;
      }

      // Oldest first, by id (fetchAllNewMessages sorts them). The fetch asked for
      // messages after the cursor, so anything at or below it is an upstream's
      // replay: drop it here, which also keeps the cursor from moving backwards.
      const cursor = BigInt(lastId);
      const fetched = await fetchAllNewMessages(channel.id, lastId, authHeader);
      const messages = fetched.filter((msg) => BigInt(msg.id) > cursor);
      replayed = fetched.length - messages.length;
      if (messages.length === 0) continue;

      // Advance the cursor to the newest message
      lastSeenMessageId.set(channel.id, newestId(messages));

      // Deliver-layer channel scope (#31): the watcher polls every channel (so
      // injection works), but only DELIVERS from allowlisted channels. Baseline
      // is already advanced above, so out-of-scope channels are tracked but
      // never delivered — this is the cross-team leak fix, at the deliver layer.
      if (!isChannelInScope(channel, CHANNEL_ALLOWLIST)) {
        commitChannel(channel.id); // nothing to deliver; saved at cycle end
        continue;
      }

      // Route and transcribe each new message, oldest first: all network work
      // happens here, before anything is delivered.
      for (const msg of messages) {
        // Dedup: skip messages we've already delivered (guards against an
        // upstream returning a message twice)
        if (deliveredMessageIds.has(msg.id)) {
          dedupHits++;
          replayed++;
          continue;
        }

        if (!shouldDeliverMessage(msg, cachedIdentity, { verbose: VERBOSE })) {
          continue;
        }

        markDelivered(msg.id);
        cycleNewMessages++;
        const content = await prepareLocalDelivery(channel, msg, authHeader);
        if (content !== null) ready.push({ msg, content });
      }
    } catch (err) {
      channelFailed = true;
      log.error("poll", { channel: channel.name }, String(err));
    } finally {
      // Runs on every `continue` above too. A replay is the upstream's defect,
      // not ours, but it must not go unseen (#92).
      if (replayed > 0) log.warn("poll", { channel: channel.name, replayed });
    }

    // Deliver back to back, no network call in between: doorbell-oneshot kills
    // the watcher soon after the first line, and every later message is already
    // marked delivered. Runs even if preparing a later message threw.
    try {
      for (const { msg, content } of ready) {
        const pending = sink.deliver(channel, msg, content);
        if (pending) await pending;
      }
    } catch (err) {
      channelFailed = true;
      log.error("poll", { channel: channel.name }, String(err));
    }

    // Persist this channel now, not at cycle end (#83). For the doorbell sink
    // this runs in the same synchronous stretch as the lines above, so a SIGTERM
    // (handled only between event-loop turns) finds the file covering every line
    // written and no channel not yet polled. A consumer must still read stdout to
    // EOF after stopping the watcher, or a line written but not yet read is lost
    // with its cursor committed. Saving before the delivery pass could skip
    // messages; saving only at cycle end, which a oneshot kill never reaches,
    // would replay this batch on every re-arm.
    if (!channelFailed && commitChannel(channel.id)) saveCursor(sink.transport);

    // If a 401 was caught mid-cycle (apiGet engaged the auth-failure
    // circuit breaker), break out of the channel loop immediately rather
    // than continue firing 401s for every remaining channel. Announce on the
    // way out so the session is alerted within this cycle, not the next one.
    if (checkAuthFailed()) {
      await sink.authFailed();
      break;
    }
  }

  // Once per finished cycle, even a quiet one: picks up baselines and
  // out-of-scope advances, and refreshes saved_at so a long quiet spell does not
  // age the cursor past CURSOR_MAX_AGE_MS.
  saveCursor(sink.transport);

  const cycleMs = Math.round(performance.now() - cycleT0);
  log.info("poll", { channels: watchedChannels.length, new_messages: cycleNewMessages, ms: cycleMs, via: cycleVia });
}

/**
 * The notify step for one message that passed the delivery gate: returns the
 * content to deliver locally, or null if the message went to the forward
 * target. Precedence is directmsg > forward > fanout (decideNotifyRoute): a
 * //directmsg to the local agent is never forwarded away — the red-phone that
 * makes forward safe. With no forward rule every message is delivered locally.
 */
async function prepareLocalDelivery(
  channel: DiscordChannel,
  msg: DiscordMessage,
  authHeader: string
): Promise<string | null> {
  if (decideNotifyRoute(msg, channel, cachedForwardRule, cachedIdentity) === "forward") {
    // Never throws: a failed fetch/delivery is logged and swallowed.
    const outcome = await forwardMessage(cachedForwardRule!, channel, msg, authHeader, {
      fetchMessage: fetchMessageById,
      log,
    });
    // Forwarded, gone, or an unknown-state exception → no local delivery. A
    // TRANSIENT fetch error (#44) or a FAILED delivery (#46) provably did not
    // reach the target, so it falls through to local delivery, never lost.
    if (!shouldFallbackToLocalNotify(outcome)) return null;
  }

  const transcription = await transcribeAudioAttachments(msg, authHeader);
  log.info("poll", { channel: channel.name, author: msg.author.username });
  return transcription
    ? transcription + (msg.content.trim() ? "\n" + msg.content : "")
    : msg.content;
}

/** MCP sink: `notifications/claude/channel` pushes into the session. */
export function mcpSink(server: Server): PollSink {
  const notify = (content: string, meta: Record<string, string>) =>
    server.notification({
      method: "notifications/claude/channel" as any,
      params: { content, meta },
    });
  const system = (id: string) => ({
    channel_name: "system",
    channel_id: id,
    author: "discord-watcher",
    message_id: `${id}-${Date.now()}`,
  });
  return {
    transport: "mcp",
    async deliver(channel, msg, content) {
      const preview = content.length > 100 ? content.slice(0, 100) + "…" : content;
      // Sanitize before the content lands in the receiving agent's transcript:
      // a lone surrogate in a pulled username/preview would 400 its next request.
      const safeAuthor = sanitizeSurrogates(msg.author.username);
      const safePreview = sanitizeSurrogates(preview);
      await notify(`New message from ${safeAuthor} in #${channel.name}: ${safePreview}`, {
        channel_name: channel.name,
        channel_id: channel.id,
        author: safeAuthor,
        message_id: msg.id,
      });
    },
    async identityUnresolved(paths) {
      await notify(
        "[discord-watcher] IDENTITY UNRESOLVED: no agent identity found, so " +
          "NO Discord messages will be delivered to this session (delivery " +
          "fails closed). Looked for:\n" +
          `  ${paths.durableFile}\n` +
          `  ${paths.legacyTmpFile}\n` +
          "Run /name to write the identity file. Delivery resumes " +
          "automatically within one poll cycle — no restart needed.",
        system("identity-unresolved")
      );
    },
    async authFailed() {
      if (authFailureNotificationSent) return;
      authFailureNotificationSent = true;
      try {
        await notify(
          "[discord-watcher] AUTH FAILURE: Discord returned 401 Unauthorized. " +
            "The bot token is expired or revoked. Notification polling is " +
            "suspended until the operator updates ~/secrets/discord-bot-token " +
            "(or DISCORD_BOT_TOKEN env var) and restarts the watcher.",
          system("auth-failure")
        );
      } catch (err) {
        log.error("state_change", { what: "auth", to: "notification_failed" }, String(err));
      }
    },
  };
}

/** MCP-mode poll cycle. */
export async function checkForNewMessages(
  server: Server,
  authHeader: string
): Promise<void> {
  await pollCycle(authHeader, mcpSink(server));
}

// --- Main --------------------------------------------------------------------

const INSTRUCTIONS = [
  'Discord messages arrive as <channel source="discord_watcher" channel_name="..." channel_id="..." author="...">.',
  `Messages are pre-filtered: you only receive messages addressed to @agents (the fleet broadcast${ACCEPT_ALL ? "; @all is still accepted during the transition" : ""}), @<Dev-Team>, @<Dev-Name>, or replies to messages you signed. To broadcast to the fleet, write @agents.`,
  "When you see a notification:",
  "1. Call the mcp__disc-server__disc_read tool with channel_id and limit: 10 to fetch recent messages in context.",
  "2. Process the message and respond by calling mcp__disc-server__disc_send if action is needed.",
  '3. Sign every message with: — **<dev-name>** <dev-avatar> (<dev-team>). The watcher filters your own echoes by this signature, and uses it to route replies back to you.',
].join("\n");

async function main(): Promise<void> {
  // Clear any stale auth-failed sentinel from a previous process. This is
  // the recovery handshake: an operator who has updated the bot token and
  // restarted the watcher gets a clean retry. If the new token is also
  // bad, the first apiGet 401 will re-engage the circuit breaker.
  clearAuthFailed();

  // Pre-populate the identity cache from agent-identity.json if it already
  // exists. Each poll already calls refreshIdentity() before delivery, but
  // the first poll is 15 s away — this logs the identity transition and warms
  // the cache earlier. refreshIdentity() handles absent/malformed files
  // gracefully (silent skip, no crash).
  refreshIdentity();

  // Load token early — fail fast before MCP transport setup
  const token = loadToken();
  const authHeader = `Bot ${token}`;

  // Resolve API base URL (scream-hole if configured and healthy, else direct Discord)
  API_BASE = await resolveApiBase(CONFIGURED_SCREAM_HOLE_URL);

  const server = new Server(
    { name: "discord_watcher", version: "1.7.1" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
      },
      instructions: INSTRUCTIONS,
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Discover channels — fail hard if this fails
  try {
    watchedChannels = await fetchTextChannels(authHeader);
    await initializeBaselines(authHeader, "mcp");
  } catch (err) {
    log.error("startup", {}, `Initialization failed: ${err}`);
    process.exit(1);
  }

  log.info("startup", {
    version: "1.7.1",
    config: {
      guild_id: GUILD_ID,
      channels: watchedChannels.length,
      api_base: API_BASE,
      mode: API_BASE === DISCORD_API_BASE ? "direct" : "scream-hole",
      poll_interval_ms: POLL_INTERVAL_MS,
      verbose: VERBOSE,
    },
  });

  // Poll for new messages
  const pollTimer = setInterval(
    () => checkForNewMessages(server, authHeader),
    POLL_INTERVAL_MS
  );

  // Periodically refresh the channel list (honors kill switch via
  // refreshChannelList — see its docstring)
  const refreshTimer = setInterval(() => {
    refreshChannelList(authHeader).catch((err) => {
      log.error("state_change", { what: "channels", to: "refresh_failed" }, String(err));
    });
  }, CHANNEL_REFRESH_MS);

  // Clean up on exit
  process.on("SIGINT", () => {
    clearInterval(pollTimer);
    clearInterval(refreshTimer);
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    clearInterval(pollTimer);
    clearInterval(refreshTimer);
    process.exit(0);
  });
}

// --- `doorbell` stdout transport (channels-free doorbell) --------------------
//
// Alternate delivery sink for sessions where Claude Code's `--channels` flag is
// unavailable (e.g. locked-down client environments). Runs the SAME poll core
// (pollCycle) as the MCP watcher with a different sink: each deliverable message
// is one line on STDOUT, and identity/auth alerts are one-time STDERR lines.
// Designed to be armed via Claude Code's `Monitor`:
//
//   Monitor({ command: "discord-watcher doorbell", persistent: true })
//
// Monitor turns each stdout line into a session notification — including while
// the agent is idle — so "wait for the next message" lives in this background
// process, never in the agent's memory. There is no trigger to re-arm. Polling
// is a cheap API call (no model inference); the model is engaged only when a
// deliverable line is emitted (one turn per addressed message).
//
// CRITICAL (lesson_discord_doorbell_inference_storm, 2026-06-20): the delivery
// filter runs HERE, in-process. Only messages that pass shouldDeliverMessage are
// emitted — emitting unfiltered traffic would wake the model per-message, the
// exact fleet inference storm that rate-limited the shared quota.
//
// A forward rule (#68) applies here exactly as in MCP mode (#82): the poll core
// routes before the sink sees anything. See the "Poll core" comment above.

const DOORBELL_USAGE =
  [
    "usage: discord-watcher doorbell",
    "",
    "Runs a foreground poll loop and prints one line per deliverable Discord",
    "message to stdout. Intended to be armed under Claude Code's Monitor:",
    "",
    '  Monitor({ command: "discord-watcher doorbell", persistent: true })',
    "",
    "Each emitted line has the form:",
    "  [doorbell] #<channel> channel_id=<id> msg_id=<id> from <author>: <preview>",
    "",
    "On such a line, disc_read the channel_id and respond. Runs the same poll",
    "core as --channels: identity gate, channel allowlist, fail-closed delivery,",
    "voice-memo transcription and forward rule. An unresolved identity or a",
    "rejected token is reported once on stderr.",
  ].join("\n") + "\n";

/**
 * Render the single stdout line for a deliverable message. Pure (no I/O) so the
 * line contract is unit-testable. `content` defaults to the message text; the
 * poll core passes it with any voice-memo transcription prepended. Newlines are
 * collapsed to a single space: a multi-line preview would split into multiple
 * Monitor events (or a malformed one) — one physical line == one doorbell.
 */
export function formatDoorbellLine(
  channel: DiscordChannel,
  msg: DiscordMessage,
  content: string = msg.content ?? ""
): string {
  const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();
  const raw = oneLine(content);
  const clipped = raw.length > 100 ? raw.slice(0, 100) + "…" : raw;
  const author = oneLine(sanitizeSurrogates(msg.author.username));
  const preview = sanitizeSurrogates(clipped);
  const chan = oneLine(sanitizeSurrogates(channel.name));
  return `[doorbell] #${chan} channel_id=${channel.id} msg_id=${msg.id} from ${author}: ${preview}`;
}

/** Prefix of the doorbell's one-per-episode unresolved-identity stderr line. */
export const DOORBELL_IDENTITY_LINE_PREFIX = "discord-watcher doorbell: identity unresolved";

// Auth-failure announcement latch. The doorbell has no MCP notification channel,
// so a revoked/expired token is surfaced as a ONE-TIME stderr line instead (the
// MCP path uses mcpSink(...).authFailed). This latch is fresh module
// state per process, so a restart yields exactly one new announcement — separate
// from clearAuthFailed() in runDoorbell, which re-arms the breaker sentinel.
let doorbellAuthAnnounced = false;

function announceDoorbellAuthFailedOnce(): void {
  if (doorbellAuthAnnounced) return;
  doorbellAuthAnnounced = true;
  process.stderr.write(
    "discord-watcher doorbell: auth failed (401) — bot token rejected; " +
      "polling suspended, deaf until the token is fixed and this process restarts\n"
  );
}

/**
 * Doorbell sink: deliveries are stdout lines (the Monitor event stream), and
 * identity/auth alerts are stderr lines, so stdout only ever carries doorbells.
 * The identity line follows the shared breaker: once per unresolved episode,
 * and again after a recovery and a new break.
 */
export const doorbellSink: PollSink = {
  transport: "doorbell",
  // Synchronous on purpose: see the delivery loop in pollCycle.
  deliver(channel, msg, content) {
    process.stdout.write(formatDoorbellLine(channel, msg, content) + "\n");
  },
  async identityUnresolved(paths) {
    process.stderr.write(
      `${DOORBELL_IDENTITY_LINE_PREFIX} — no agent identity found, so NO ` +
        "Discord messages will be delivered (delivery fails closed). Looked for " +
        `${paths.durableFile} and ${paths.legacyTmpFile}. Run /name; delivery ` +
        "resumes within one poll cycle, no restart needed.\n"
    );
  },
  async authFailed() {
    announceDoorbellAuthFailedOnce();
  },
};

/** Doorbell-mode poll cycle. */
export async function doorbellCycle(authHeader: string): Promise<void> {
  await pollCycle(authHeader, doorbellSink);
}

/** Foreground doorbell transport. Does not return until SIGINT/SIGTERM. */
async function runDoorbell(): Promise<void> {
  clearAuthFailed();
  refreshIdentity();

  const token = loadToken();
  const authHeader = `Bot ${token}`;
  API_BASE = await resolveApiBase(CONFIGURED_SCREAM_HOLE_URL);

  let resumed = 0;
  try {
    watchedChannels = await fetchTextChannels(authHeader);
    resumed = await initializeBaselines(authHeader, "doorbell");
  } catch (err) {
    log.error("doorbell", {}, `Initialization failed: ${err}`);
    process.exit(1);
  }

  // Diagnostics go to STDERR — stdout is the event stream Monitor consumes, so
  // only doorbell lines may appear there.
  process.stderr.write(
    `discord-watcher doorbell: watching ${watchedChannels.length} channel(s), ` +
      `${resumed} resumed from the saved cursor, poll ${POLL_INTERVAL_MS}ms\n`
  );

  let stopping = false;
  const onSignal = (): void => {
    stopping = true;
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // Sequential cycles (no overlap) with a fixed inter-cycle sleep for backoff.
  // Refresh the channel list on the same cadence as the MCP watcher
  // (CHANNEL_REFRESH_MS) so channels created mid-session are picked up — a
  // persistent doorbell would otherwise never see them (e.g. per-topic channels
  // created after startup). refreshChannelList honors the kill switch / auth
  // breaker and baselines only newly-appeared channels (no history replay).
  const refreshEveryCycles = Math.max(
    1,
    Math.round(CHANNEL_REFRESH_MS / POLL_INTERVAL_MS)
  );
  let cyclesSinceRefresh = 0;
  while (!stopping) {
    await doorbellCycle(authHeader);
    if (++cyclesSinceRefresh >= refreshEveryCycles) {
      cyclesSinceRefresh = 0;
      await refreshChannelList(authHeader).catch((err) => {
        log.error("doorbell", {}, `channel refresh failed: ${err}`);
      });
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// Only run when executed directly (not when imported by tests)
if (import.meta.main) {
  if (process.argv[2] === "doorbell") {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      process.stdout.write(DOORBELL_USAGE);
      process.exit(0);
    }
    runDoorbell().catch((err) => {
      log.error("doorbell", {}, `Fatal: ${err}`);
      process.exit(1);
    });
  } else {
    main().catch((err) => {
      log.error("startup", {}, `Fatal: ${err}`);
      process.exit(1);
    });
  }
}
