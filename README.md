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
| `STT_ENDPOINT` | `http://archer:8300/v1/audio/transcriptions` | Whisper STT endpoint |
| `STT_MODEL` | `deepdml/faster-whisper-large-v3-turbo-ct2` | STT model name |

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
