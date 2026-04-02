#!/usr/bin/env bash
set -euo pipefail

# Build a standalone binary for a given bun target.
# Usage: build.sh <bun-target>
# Example: build.sh bun-linux-x64

TARGET="${1:?Usage: build.sh <bun-target>}"
SUFFIX="${TARGET#bun-}"

mkdir -p dist
bun build --compile --target="$TARGET" index.ts --outfile "dist/discord-watcher-${SUFFIX}"
echo "Built dist/discord-watcher-${SUFFIX}"
