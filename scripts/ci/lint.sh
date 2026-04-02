#!/usr/bin/env bash
# Lint: TypeScript strict check + shellcheck on shell scripts.
set -euo pipefail

echo "--- TypeScript lint ---"
bun run lint

echo "--- shellcheck ---"
shopt -s nullglob
scripts=( scripts/ci/*.sh scripts/install.sh scripts/install-remote.sh )
shopt -u nullglob

if [[ ${#scripts[@]} -eq 0 ]]; then
    echo "No shell scripts found to check"
else
    shellcheck "${scripts[@]}"
    echo "shellcheck: ${#scripts[@]} file(s) OK"
fi
