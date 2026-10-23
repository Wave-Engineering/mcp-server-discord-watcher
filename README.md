# Discord Watcher

A Discord channel watcher MCP server for Claude Code. Watches all text channels
on a Discord server and pushes wake-up notifications into the Claude Code
session when new messages arrive.

This is a "doorbell, not a mailroom" — it notifies the agent that something new
appeared, then the agent uses the `disc_read` and `disc_send` MCP tools (from
the `disc-server` MCP server) to interact.

## Prerequisites

- [Claude Code](https://claude.ai/code) CLI (`claude`)
- `jq` (JSON processor)
- `curl` or `wget`
- A Discord bot token saved at `~/secrets/discord-bot-token`

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/Wave-Engineering/mcp-server-discord-watcher/main/scripts/install-remote.sh | bash
```

This downloads a pre-compiled binary for your platform, registers the MCP
server, and configures Discord connectivity. No clone or runtime required.

Verify the installation:

```bash
curl -fsSL https://raw.githubusercontent.com/Wave-Engineering/mcp-server-discord-watcher/main/scripts/install-remote.sh | bash -s -- --check
```

Install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/Wave-Engineering/mcp-server-discord-watcher/main/scripts/install-remote.sh | bash -s -- --version v1.0.0
```

### Development Installation

If you're working on the watcher itself, clone the repo and use the local
installer (requires [Bun](https://bun.sh)):

```bash
git clone https://github.com/Wave-Engineering/mcp-server-discord-watcher.git
cd mcp-server-discord-watcher
./scripts/install.sh
```

## How It Works

The watcher connects to Discord's REST API and polls all text channels on the
configured guild at 15-second intervals. When a new message arrives that is
addressed to the agent (via `@agents`, `@<dev-team>`, or `@<dev-name>`), it sends
an MCP notification to the Claude Code session.

### Message Filtering

- **Self-echo filtering** -- Messages containing the agent's own signature
  (`-- **<dev-name>**`) are skipped to prevent echo loops.
- **Targeted routing** -- Only messages addressed to `@agents`, `@<dev-team>`, or
  `@<dev-name>` are delivered. Set `DISCORD_WATCHER_VERBOSE=1` to bypass
  filtering and receive all messages.
- **`@agents` is the fleet broadcast; `@all` is being retired** -- On Mattermost,
  `@all` pages every human in a channel, so the fleet broadcasts with `@agents` on
  every backend. During the transition the watcher still hears `@all`; set
  `DISCORD_WATCHER_ACCEPT_ALL=0` to stop hearing it. Send `@agents`.
- **Channel scoping (deliver-layer)** -- The watcher always polls every text
  channel in the guild (required so channel injection works), but only
  *delivers* wake-ups from channels in its **allowlist**. Set the allowlist via
  `watcher_channels` in `discord.json`, or `DISCORD_WATCHER_CHANNELS`, to scope
  an agent to its own channels by id or name. Out-of-scope channels are polled
  but never delivered, so their traffic can't wake the agent even when it
  mentions the agent's `@<dev-team>` / `@<dev-name>`. Required when multiple
  teams share one guild -- see [Multi-team scoping](#multi-team-scoping).
- **Voice memo transcription** -- Audio attachments are automatically transcribed
  via Whisper STT and delivered as `[voice memo from <author>: "<text>"]`.

### Kill Switch

If the bot receives a 429 (rate limit) response, it engages a kill switch at
`~/.claude/discord-bot.kill` with an expiry timestamp. Polling pauses until the
expiry passes, then auto-lifts.

### Channels-free doorbell (`doorbell` subcommand)

In sessions where Claude Code's `--channels` flag is unavailable (e.g. locked-down
client environments), the MCP notification sink is not wired up, so no doorbell
reaches the agent. The `doorbell` subcommand is the alternate transport:

```
discord-watcher doorbell
```

It runs the **same** poll core as the MCP watcher — one `pollCycle` with a
different sink — so the fail-closed delivery gate (`shouldDeliverMessage`,
identity resolution, channel allowlist), voice-memo transcription and forward
routing are identical in both modes. The only difference is where the output
goes: each deliverable message is **one line on stdout** instead of an MCP
notification:

```
[doorbell] #<channel> channel_id=<id> msg_id=<id> from <author>: <preview>
```

Arm it with Claude Code's `Monitor` primitive, which turns each stdout line into
a session notification — including while the agent is idle:

```
Monitor({ command: "discord-watcher doorbell", persistent: true })
```

Properties:

- **Self-rearming.** `persistent: true` keeps the background process alive; "wait
  for the next message" lives in the process, not the agent's memory. There is no
  trigger to reset after reading.
- **No busy-wait.** Polling is a cheap REST call (no model inference); the model
  is engaged only when a deliverable line is emitted — one turn per addressed
  message. The delivery filter runs **in-process**: only messages that pass
  `shouldDeliverMessage` are ever emitted, so unaddressed traffic never wakes the
  model.
- **Mid-session cutover.** Start (or stop, via `Monitor` `TaskStop`) at any time,
  even if `--channels` was previously in use.
- **Resumes, never replays history.** On startup each channel resumes from the
  [saved cursor](#saved-poll-cursor) when there is a fresh one, so a re-armed
  doorbell delivers what arrived while it was down. Without one, the cursor is
  seeded to the latest message per channel and pre-existing history is never
  delivered. Both behave exactly as in the MCP watcher.
- **Never silently deaf.** Problems go to **stderr**, never stdout (stdout carries
  only doorbell lines). An unresolved identity prints one
  `discord-watcher doorbell: identity unresolved …` line naming the files it
  looked for — once per outage, after the same startup grace as the MCP
  notification, and again if identity resolves and later breaks. A rejected bot
  token prints one `auth failed (401)` line.
- **Voice memos.** An audio attachment is transcribed and the line's preview
  starts with `[voice memo from <author>: "<text>"]`, as in MCP mode.

**Forward rules apply in both modes.** A forward rule
(`discord-watcher forward <target>`) routes the same way whichever transport the
agent uses, with the same precedence: a `//directmsg` addressed to the local
agent is always delivered locally, a matching message is forwarded to the target
instead of printing a line, and an excluded, looping or unmatched message prints
a line as usual. If the forward fails in a way that means the target never got
it (a transient fetch error or a failed delivery), the message falls back to a
local doorbell line, so it is never lost. Before #82 doorbell mode ignored the
rule, so the same rule did different things depending on whether the session
had `--channels`.

**Known boundary:** each transport keeps its own cursor (see below), so a
`--channels`→`doorbell` cutover is not bridged. A message that arrives after the
MCP watcher's last poll and before the doorbell's first start is not delivered
by the doorbell. Restarts and re-arms within one transport are bridged.

### Saved poll cursor

Both modes save their poll position, so a restarted MCP watcher or a re-armed
doorbell (for example under `doorbell-oneshot.sh`, which starts a fresh
`doorbell` for every batch) delivers the messages that arrived while it was
down, instead of skipping them.

- **Where.** `${XDG_STATE_HOME:-$HOME/.local/state}/discord-watcher/cursor-<guild>-<dev_team>-<dev_name>-<mcp|doorbell>.json`,
  one file per guild, agent identity and transport. It holds
  `{ "version": 1, "saved_at", "api_base", "guild_id", "dev_team", "dev_name", "transport", "channels": { "<channel_id>": "<message_id>" } }`.
  An agent whose identity is unresolved neither loads nor saves a cursor.
- **Why one file per transport.** The MCP watcher is installed at user scope, so
  it also runs in sessions without `--channels`, the very sessions the doorbell
  is for. There its notifications reach nobody but still succeed, so it moves
  its cursor past every addressed message. If the doorbell shared that file, a
  re-arm would resume from the MCP watcher's position and skip what the doorbell
  never printed.
- **When it is saved.** Right after each channel's messages are delivered, and
  once at the end of every poll cycle. The write goes to a temp file in the same
  directory and is renamed into place, so it is never read half-written. A
  channel's entry only moves past messages that were delivered, filtered out or
  forwarded.
- **Max age: 4 hours** (`CURSOR_MAX_AGE_MS`, scream-hole's cache window). At
  startup a younger cursor is resumed. An older, unreadable, wrong-identity or
  wrong-transport one is ignored with one `cursor` log line, and every channel is
  baselined as before.
  A channel the cursor does not list is baselined too. Quiet cycles still rewrite
  the file, so a long quiet spell does not age it out.
- **Direct vs scream-hole.** A cursor is a Discord message id, and scream-hole
  serves the same ids, so a cursor saved in one mode is resumed in the other.
- **Duplicate window.** The set of already-delivered ids is not saved, so a
  restart can re-deliver what was delivered between the last save and the stop.
  In MCP mode that gap is the notification round trip.
- **Doorbell guarantee.** A channel's lines and its save run with nothing in
  between, so a SIGTERM always finds every line *written* to stdout saved, and
  nothing not yet written. Written is not read: a consumer must read stdout to
  EOF after stopping the watcher, or a line still in the pipe is lost with its
  cursor already saved. (cc-workflow#1284 makes `doorbell-oneshot.sh` do so.)
- **Failed delivery.** If a channel's pass fails (a thrown transcription or
  forward, or an MCP notification that throws), its saved entry stays where it
  was, so a restart *before that channel's next message* re-delivers the
  messages. The running process has already moved past them, though, so the
  channel's next good pass saves past them for good.

**Known limit:** two live sessions with the same Dev-Name in one checkout share
one cursor file (cc-workflow triage #16, identity collision). The last writer
wins, so one of them can resume past a message only the other delivered.

## Configuration

### Discord Config

The watcher reads `~/.claude/discord.json` for guild and token configuration:

```json
{
  "guild_id": "1486516321385578576",
  "token_path": "~/secrets/discord-bot-token",
  "watcher_channels": ["oaw", "roll-call", "precheck", "wave-status"],
  "channels": {
    "roll-call": { "name": "roll-call", "id": "1487382005036617851" }
  }
}
```

Fallback chain: config file -> environment variables -> hardcoded defaults.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | (read from token file) | Bot token (overrides file) |
| `DISCORD_GUILD_ID` | `1486516321385578576` | Guild to watch |
| `DISCORD_TOKEN_PATH` | `~/secrets/discord-bot-token` | Path to token file |
| `DISCORD_WATCHER_VERBOSE` | `0` | Set to `1` to bypass message filtering |
| `DISCORD_WATCHER_CHANNELS` | (unset → deliver from all) | Comma-separated channel ids/names to scope *delivery* to (all channels are still polled) |
| `DISCORD_WATCHER_ACCEPT_ALL` | (unset → on) | Set to `0` to stop hearing the retired `@all` broadcast (#84); `@agents` is always heard. Read at startup; restart the watcher to change it. |
| `DISCORD_IDENTITY_WARN_CYCLES` | Poll cycles between repeat `identity_outage` warn logs while agent identity is unresolved. Default `100`. Invalid values (`0`, negative, non-integer) fall back to the default rather than disabling the warning. |
| `XDG_STATE_HOME` | `~/.local/state` | Base directory for the [saved poll cursor](#saved-poll-cursor) (must be absolute) |
| `STT_ENDPOINT` | `http://archer:8300/v1/audio/transcriptions` | Whisper STT endpoint |
| `STT_MODEL` | `deepdml/faster-whisper-large-v3-turbo-ct2` | STT model name |

### Multi-team scoping

When more than one team shares a single Discord guild, the **channel allowlist
is required** to prevent cross-team wake-ups. Without it, a message in any
channel that mentions a team's `@<dev-team>` / `@<dev-name>` wakes that team's
agents -- including messages in another team's channels. Scope each team's
watcher to its own channels (plus any shared channels) via `watcher_channels`
or `DISCORD_WATCHER_CHANNELS`. The watcher still polls every channel (so channel
injection keeps working); the allowlist only gates which channels' messages are
*delivered* as wake-ups.

Two operational notes:

- **Inert until configured *and restarted*.** Setting the allowlist does not
  affect an already-running watcher -- the scope is read at startup. Rollout is:
  set the per-team channel scope, then restart each team's watcher. Verify
  end-to-end (a real `@<dev-team>` post in an in-scope channel wakes the team; a
  post in an out-of-scope channel does not) -- config-exists is not
  config-works.
- **`@agents` (and `@all`) is channel-scoped under deliver-scoping.** Because out-of-scope
  channels are never delivered, a broadcast reaches only agents whose allowlist
  includes the channel the message was posted in. A true cross-team broadcast
  must be posted in a channel present in *every* team's allowlist (a shared
  broadcast channel).

## Uninstall

If installed via the remote installer:

```bash
curl -fsSL https://raw.githubusercontent.com/Wave-Engineering/mcp-server-discord-watcher/main/scripts/install-remote.sh | bash -s -- --uninstall
```

If installed from a local clone:

```bash
./scripts/install.sh --uninstall
```

## License

MIT -- see [LICENSE](LICENSE).
