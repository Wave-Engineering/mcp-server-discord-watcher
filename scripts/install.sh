#!/usr/bin/env bash
set -euo pipefail

# Discord Watcher — Local Development Installer
#
# This installer is for LOCAL DEVELOPMENT of the discord watcher. It registers
# the MCP server pointing to this cloned repo, which is what you want when
# working on the code.
#
# For end-user installation (no clone required), use the remote installer:
#   curl -fsSL https://raw.githubusercontent.com/Wave-Engineering/mcp-server-discord-watcher/main/scripts/install-remote.sh | bash
#
# Usage:
#   ./scripts/install.sh              Install everything
#   ./scripts/install.sh --check      Verify installation
#   ./scripts/install.sh --uninstall  Remove everything

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_DIR="$PROJECT_DIR"

MCP_SERVER_NAME="discord-watcher"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()  { printf '  \033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
fail()  { printf '  \033[1;31m✗\033[0m %s\n' "$*"; }
die()   { fail "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

check_prereqs() {
    local missing=0
    for cmd in bun claude jq; do
        if command -v "$cmd" &>/dev/null; then
            ok "$cmd $(command "$cmd" --version 2>&1 | head -1)"
        else
            fail "$cmd not found"
            missing=1
        fi
    done
    if [[ $missing -ne 0 ]]; then
        die "Install missing prerequisites and try again."
    fi
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

install_deps() {
    info "Installing MCP server dependencies..."
    (cd "$MCP_DIR" && bun install --frozen-lockfile)
    ok "bun install complete"
}

register_mcp() {
    info "Registering MCP server: $MCP_SERVER_NAME"
    claude mcp add --scope user --transport stdio "$MCP_SERVER_NAME" \
        -- bun "$MCP_DIR/index.ts"
    ok "MCP server registered (scope: user)"
}

do_install() {
    echo ""
    echo "Discord Watcher — Installer"
    echo "============================"
    echo ""

    echo "Checking prerequisites..."
    check_prereqs
    echo ""

    install_deps
    echo ""

    register_mcp
    echo ""

    echo "Installation Summary"
    echo "--------------------"
    ok "MCP server: $MCP_SERVER_NAME (bun $MCP_DIR/index.ts)"
    echo ""
    echo "The watcher will activate when Claude Code starts a session."
    echo ""
}

# ---------------------------------------------------------------------------
# Check
# ---------------------------------------------------------------------------

do_check() {
    echo ""
    echo "Discord Watcher — Installation Check"
    echo "====================================="
    echo ""
    local issues=0

    # Prerequisites
    for cmd in bun claude jq; do
        if command -v "$cmd" &>/dev/null; then
            ok "$cmd available"
        else
            fail "$cmd not found"
            issues=$((issues + 1))
        fi
    done

    # MCP registration
    if claude mcp list 2>/dev/null | grep -q "$MCP_SERVER_NAME"; then
        ok "MCP server '$MCP_SERVER_NAME' registered"
    else
        fail "MCP server '$MCP_SERVER_NAME' not registered"
        issues=$((issues + 1))
    fi

    # Node modules
    if [[ -d "$MCP_DIR/node_modules" ]]; then
        ok "MCP server dependencies installed"
    else
        fail "MCP server dependencies not installed (run bun install)"
        issues=$((issues + 1))
    fi

    echo ""
    if [[ $issues -eq 0 ]]; then
        ok "All checks passed"
    else
        fail "$issues issue(s) found — run ./scripts/install.sh to fix"
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

do_uninstall() {
    echo ""
    echo "Discord Watcher — Uninstaller"
    echo "=============================="
    echo ""

    # Remove MCP registration
    info "Removing MCP server registration..."
    if claude mcp remove "$MCP_SERVER_NAME" 2>/dev/null; then
        ok "MCP server '$MCP_SERVER_NAME' removed"
    else
        warn "MCP server '$MCP_SERVER_NAME' was not registered"
    fi

    echo ""
    ok "Uninstall complete"
    echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

case "${1:-}" in
    --check)     do_check ;;
    --uninstall) do_uninstall ;;
    "")          do_install ;;
    *)           die "Unknown flag: $1 (use --check or --uninstall)" ;;
esac
