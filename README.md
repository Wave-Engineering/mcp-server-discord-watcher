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
addressed to the agent (via `@all`, `@<dev-team>`, or `@<dev-name>`), it sends
an MCP notification to the Claude Code session.

### Message Filtering

- **Self-echo filtering** -- Messages containing the agent's own signature
  (`-- **<dev-name>**`) are skipped to prevent echo loops.
- **Targeted routing** -- Only messages addressed to `@all`, `@<dev-team>`, or
  `@<dev-name>` are delivered. Set `DISCORD_WATCHER_VERBOSE=1` to bypass
  filtering and receive all messages.
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
| `DISCORD_IDENTITY_WARN_CYCLES` | Poll cycles between repeat `identity_outage` warn logs while agent identity is unresolved. Default `100`. Invalid values (`0`, negative, non-integer) fall back to the default rather than disabling the warning. |
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
- **`@all` is channel-scoped under deliver-scoping.** Because out-of-scope
  channels are never delivered, `@all` reaches only agents whose allowlist
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
