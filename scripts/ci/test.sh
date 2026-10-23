#!/usr/bin/env bash
# Run bun unit tests for the MCP server.
set -euo pipefail

echo "--- Installing dependencies ---"
# Real HOME on purpose: bun's package cache lives there.
bun install --frozen-lockfile

echo "--- Running tests ---"
# The suite creates and deletes ~/.claude/discord-bot.kill and
# ~/.claude/discord-bot.auth-failed, fleet-wide sentinels that every live watcher
# on the box reads each cycle, so the tests run against a throwaway HOME.
# LOG_FILE is dropped too: an agent session exports it as an ABSOLUTE path to the
# real ~/.claude/logs/mcp.jsonl, which a HOME override alone does not redirect.
# XDG_STATE_HOME is dropped for the same reason: the saved poll cursor lives
# under it, beside the live watchers' cursors.
# tests/home-guard.ts (bunfig.toml preload) enforces all three for a bare `bun test`.
TEST_HOME="$(mktemp -d)"
trap 'rm -rf "$TEST_HOME"' EXIT
env -u LOG_FILE -u XDG_STATE_HOME HOME="$TEST_HOME" bun test
