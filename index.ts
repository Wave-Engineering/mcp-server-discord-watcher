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
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@wave-engineering/mcp-logger";

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
}

/**
 * Load Discord config using the fallback chain:
 * 1. ~/.claude/discord.json
 * 2. Environment variables
 * 3. Hardcoded defaults
 */
export function loadConfig(): { guildId: string; tokenPath: string; screamHoleUrl: string | null } {
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

  return { guildId, tokenPath, screamHoleUrl };
}

const log = createLogger("watcher");

const { guildId: GUILD_ID, tokenPath: CONFIGURED_TOKEN_PATH, screamHoleUrl: CONFIGURED_SCREAM_HOLE_URL } = loadConfig();

export const DISCORD_API_BASE = "https://discord.com/api/v10";
let API_BASE = DISCORD_API_BASE;
const POLL_INTERVAL_MS = 15_000;
const CHANNEL_REFRESH_MS = 5 * 60_000;
const MESSAGES_PER_PAGE = 50;
const VERBOSE = process.env.DISCORD_WATCHER_VERBOSE === "1";

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

export function resolveIdentity(): AgentIdentity {
  try {
    // Match the agent's identity resolution: git rev-parse, fallback to cwd
    let projectRoot: string;
    try {
      projectRoot = execSync("git rev-parse --show-toplevel", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      projectRoot = process.cwd();
    }
    const dirHash = createHash("md5").update(projectRoot).digest("hex");
    const agentFile = `/tmp/claude-agent-${dirHash}.json`;
    const data = JSON.parse(readFileSync(agentFile, "utf-8"));
    return {
      devName: data.dev_name || null,
      devTeam: data.dev_team || null,
    };
  } catch {
    return { devName: null, devTeam: null };
  }
}

// --- Discord API helpers -----------------------------------------------------

async function apiGet(
  endpoint: string,
  authHeader: string
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; retryAfter?: number }> {
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
    log.error("api_call", { method: "GET", endpoint: pathOnly, status: 401, ms, service });
    engageAuthFailed();
    return { ok: false, status: 401 };
  }
  if (!res.ok) {
    log.warn("api_call", { method: "GET", endpoint: pathOnly, status: res.status, ms, service });
    return { ok: false, status: res.status };
  }
  log.info("api_call", { method: "GET", endpoint: pathOnly, status: res.status, ms, service });
  return { ok: true, data: await res.json() };
}

interface DiscordChannel {
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
 *   5. Addressed via @all, @<dev-team>, @<dev-name>, or reply to a message
 *      we signed → deliver
 *   6. Otherwise → drop
 */
export function shouldDeliverMessage(
  msg: DiscordMessage,
  identity: AgentIdentity,
  options: { verbose?: boolean } = {}
): boolean {
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

  // 3. Fail closed when identity is unresolved (precedes VERBOSE so the
  // security boundary is preserved even in verbose mode)
  if (!identity.devName && !identity.devTeam) {
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
  const isAddressedToAll = tokens.includes("@all");
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

// Deduplication: track recently delivered message IDs so upstream cache bugs
// (e.g. scream-hole returning already-seen messages) can't cause re-delivery.
// Bounded to prevent unbounded memory growth — oldest entries evicted via FIFO.
const DELIVERED_SET_MAX = 500;
const deliveredMessageIds = new Set<string>();
const deliveredOrder: string[] = [];

function markDelivered(messageId: string): void {
  if (deliveredMessageIds.has(messageId)) return;
  deliveredMessageIds.add(messageId);
  deliveredOrder.push(messageId);
  while (deliveredOrder.length > DELIVERED_SET_MAX) {
    deliveredMessageIds.delete(deliveredOrder.shift()!);
  }
}

// --- Channel discovery -------------------------------------------------------

async function fetchTextChannels(authHeader: string): Promise<DiscordChannel[]> {
  const result = await apiGet(`/guilds/${GUILD_ID}/channels`, authHeader);
  if (!result.ok) {
    throw new Error(`Failed to fetch channels: HTTP ${result.status}`);
  }
  return (result.data as DiscordChannel[]).filter((c) => c.type === 0);
}

async function initializeBaselines(authHeader: string): Promise<void> {
  for (const channel of watchedChannels) {
    try {
      const result = await apiGet(
        recentMessageUrl(channel.id),
        authHeader
      );
      if (result.ok) {
        const messages = result.data as DiscordMessage[];
        if (messages.length > 0) {
          lastSeenMessageId.set(channel.id, messages[0].id);
          // Mark baseline messages as delivered so they're never re-delivered
          for (const msg of messages) {
            markDelivered(msg.id);
          }
        }
      }
    } catch {
      // Channel might not be readable — skip it
    }
  }
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

  // Paginate to collect all new messages (prevents silent drops on bursts)
  while (true) {
    const result = await apiGet(
      `/channels/${channelId}/messages?after=${cursor}&limit=${MESSAGES_PER_PAGE}`,
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
        return allMessages;
      }
      throw new Error(`Discord API HTTP ${result.status}`);
    }

    const messages = result.data as DiscordMessage[];
    if (messages.length === 0) break;

    allMessages.push(...messages);

    // If we got fewer than the limit, we've consumed everything
    if (messages.length < MESSAGES_PER_PAGE) break;

    // Advance cursor to the newest message (messages are newest-first)
    cursor = messages[0].id;
  }

  return allMessages;
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
        const result = await apiGet(recentMessageUrl(ch.id), authHeader);
        if (result.ok) {
          const msgs = result.data as DiscordMessage[];
          if (msgs.length > 0) {
            lastSeenMessageId.set(ch.id, msgs[0].id);
            for (const msg of msgs) {
              markDelivered(msg.id);
            }
          }
        }
      } catch {
        // skip unreadable
      }
    }
  }
  watchedChannels = fresh;
  log.info("state_change", { what: "channels", to: "refreshed", channels: fresh.length });
}

// One-time MCP notification flag for auth failure. The notification is sent
// once per process so a Claude session is alerted exactly once that the
// watcher has stopped delivering messages due to a bad token. Reset on
// process restart (module re-import) — paired with clearAuthFailed() in main().
let authFailureNotificationSent = false;

/**
 * Emit a one-time MCP notification informing the Claude session that the
 * watcher has hit an auth failure and polling is suspended. Idempotent —
 * subsequent calls in the same process are no-ops.
 */
async function emitAuthFailedNotificationIfNeeded(server: Server): Promise<void> {
  if (authFailureNotificationSent) return;
  authFailureNotificationSent = true;
  try {
    await server.notification({
      method: "notifications/claude/channel" as any,
      params: {
        content:
          "[discord-watcher] AUTH FAILURE: Discord returned 401 Unauthorized. " +
          "The bot token is expired or revoked. Notification polling is " +
          "suspended until the operator updates ~/secrets/discord-bot-token " +
          "(or DISCORD_BOT_TOKEN env var) and restarts the watcher.",
        meta: {
          channel_name: "system",
          channel_id: "auth-failure",
          author: "discord-watcher",
          message_id: `auth-failure-${Date.now()}`,
        },
      },
    });
  } catch (err) {
    log.error("state_change", { what: "auth", to: "notification_failed" }, String(err));
  }
}

async function checkForNewMessages(
  server: Server,
  authHeader: string
): Promise<void> {
  // Check kill switch before polling
  if (checkKillSwitch() === "active") return;

  // Check auth-failure circuit breaker. If the bot token has been revoked
  // or expired, polling is permanently suspended for this process. Emit a
  // one-time MCP notification so the Claude session knows why notifications
  // have stopped, then short-circuit every subsequent cycle silently.
  if (checkAuthFailed()) {
    await emitAuthFailedNotificationIfNeeded(server);
    return;
  }

  // Refresh identity each cycle (agent may pick name after server starts)
  cachedIdentity = resolveIdentity();

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

    try {
      const lastId = lastSeenMessageId.get(channel.id);

      // First poll for this channel — just set baseline
      if (!lastId) {
        const result = await apiGet(
          recentMessageUrl(channel.id),
          authHeader
        );
        if (result.ok) {
          const msgs = result.data as DiscordMessage[];
          if (msgs.length > 0) {
            lastSeenMessageId.set(channel.id, msgs[0].id);
          }
        } else if (result.status === 429 && result.retryAfter) {
          log.warn("api_call", { method: "GET", endpoint: `/channels/${channel.id}/messages`, status: 429, service: cycleVia, channel: channel.name });
        }
        continue;
      }

      const messages = await fetchAllNewMessages(channel.id, lastId, authHeader);
      if (messages.length === 0) continue;

      // Update baseline to the newest message (messages are newest-first)
      lastSeenMessageId.set(channel.id, messages[0].id);

      // Push a wake-up notification for each new message (oldest first)
      for (const msg of messages.reverse()) {
        // Dedup: skip messages we've already delivered (guards against
        // upstream cache bugs returning stale messages)
        if (deliveredMessageIds.has(msg.id)) {
          continue;
        }

        if (!shouldDeliverMessage(msg, cachedIdentity, { verbose: VERBOSE })) {
          continue;
        }

        markDelivered(msg.id);
        cycleNewMessages++;

        // Transcribe audio attachments if present
        const audioTranscription = await transcribeAudioAttachments(msg, authHeader);
        const fullContent = audioTranscription
          ? audioTranscription + (msg.content.trim() ? "\n" + msg.content : "")
          : msg.content;

        const preview =
          fullContent.length > 100
            ? fullContent.slice(0, 100) + "…"
            : fullContent;

        log.debug("poll", { channel: channel.name, author: msg.author.username });

        await server.notification({
          method: "notifications/claude/channel" as any,
          params: {
            content: `New message from ${msg.author.username} in #${channel.name}: ${preview}`,
            meta: {
              channel_name: channel.name,
              channel_id: channel.id,
              author: msg.author.username,
              message_id: msg.id,
            },
          },
        });
      }
    } catch (err) {
      log.error("poll", { channel: channel.name }, String(err));
    }

    // If a 401 was caught mid-cycle (apiGet engaged the auth-failure
    // circuit breaker), break out of the channel loop immediately rather
    // than continue firing 401s for every remaining channel. Emit the
    // one-time MCP notification on the way out so the Claude session is
    // alerted within this cycle, not the next one.
    if (checkAuthFailed()) {
      await emitAuthFailedNotificationIfNeeded(server);
      break;
    }
  }

  const cycleMs = Math.round(performance.now() - cycleT0);
  log.info("poll", { channels: watchedChannels.length, new_messages: cycleNewMessages, ms: cycleMs, via: cycleVia });
}

// --- Main --------------------------------------------------------------------

const INSTRUCTIONS = [
  'Discord messages arrive as <channel source="discord_watcher" channel_name="..." channel_id="..." author="...">.',
  "Messages are pre-filtered: you only receive messages addressed to @all, @<Dev-Team>, @<Dev-Name>, or replies to messages you signed.",
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

  // Load token early — fail fast before MCP transport setup
  const token = loadToken();
  const authHeader = `Bot ${token}`;

  // Resolve API base URL (scream-hole if configured and healthy, else direct Discord)
  API_BASE = await resolveApiBase(CONFIGURED_SCREAM_HOLE_URL);

  const server = new Server(
    { name: "discord_watcher", version: "0.1.0" },
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
    await initializeBaselines(authHeader);
  } catch (err) {
    log.error("startup", {}, `Initialization failed: ${err}`);
    process.exit(1);
  }

  log.info("startup", {
    version: "0.1.0",
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

// Only run when executed directly (not when imported by tests)
if (import.meta.main) {
  main().catch((err) => {
    log.error("startup", {}, `Fatal: ${err}`);
    process.exit(1);
  });
}
