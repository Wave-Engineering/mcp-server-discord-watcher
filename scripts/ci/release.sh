#!/usr/bin/env bash
set -euo pipefail

# Create a GitHub Release and attach all artifacts.
# Usage: release.sh <tag>
# Called by the release workflow after binaries are built.

TAG="${1:?Usage: release.sh <tag>}"

echo "=== Creating release ${TAG} ==="

# Collect binaries from the download-artifact step.
mkdir -p release-assets
find artifacts -type f -name 'discord-watcher-*' -exec cp {} release-assets/ \;
find release-assets -type f -name 'discord-watcher-*' -exec chmod +x {} \;

# Copy install scripts into release assets.
cp scripts/install-remote.sh release-assets/

# Create the release with auto-generated notes.
gh release create "$TAG" release-assets/* \
    --title "$TAG" \
    --generate-notes

echo "=== Release ${TAG} created ==="
