# Project Instructions for Claude Code

## Overview

Discord channel watcher MCP server for Claude Code. Watches all text channels
on the Oak and Wave Discord server and pushes wake-up notifications into the
Claude Code session when new messages arrive.

## Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict mode)
- **Protocol:** MCP (Model Context Protocol) over stdio transport
- **Tests:** `bun test`
- **CI:** GitHub Actions

## Development

```bash
bun install
bun test
```

### Local Installation (dev mode)

```bash
./scripts/install.sh           # Install + register MCP
./scripts/install.sh --check   # Verify installation
./scripts/install.sh --uninstall  # Remove everything
```

## Code Standards

- Run `bun run lint` before committing (TypeScript strict check)
- Run `shellcheck` on all shell scripts
- No more than 5 lines of procedural logic in CI YAML `run:` blocks

## Testing

Tests live in `tests/`. Only mock true external boundaries (network, filesystem).
Run the full suite with `bun test`.
