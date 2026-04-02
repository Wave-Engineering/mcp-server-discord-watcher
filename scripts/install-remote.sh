#!/usr/bin/env bash
set -euo pipefail

# Discord Watcher — Remote Installer
#
# Install mcp-server-discord-watcher from GitHub Releases without cloning.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Wave-Engineering/mcp-server-discord-watcher/main/scripts/install-remote.sh | bash
#   curl ... | bash -s -- --uninstall
#   curl ... | bash -s -- --check
#   curl ... | bash -s -- --version v1.0.0

REPO="Wave-Engineering/mcp-server-discord-watcher"
BASE_URL="https://github.com/${REPO}/releases"

INSTALL_DIR="${DISCORD_WATCHER_INSTALL_DIR:-$HOME/.local/bin}"

MCP_SERVER_NAME="discord-watcher"
VERSION=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()  { printf '  \033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
fail()  { printf '  \033[1;31m✗\033[0m %s\n' "$*"; }
die()   { fail "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

detect_platform() {
    local os arch

    case "$(uname -s)" in
        Linux)  os="linux" ;;
        Darwin) os="darwin" ;;
        *)      die "Unsupported OS: $(uname -s)" ;;
    esac

    case "$(uname -m)" in
        x86_64)         arch="x64" ;;
        aarch64|arm64)  arch="arm64" ;;
        *)              die "Unsupported architecture: $(uname -m)" ;;
    esac

    PLATFORM_OS="$os"
    PLATFORM_ARCH="$arch"
    BINARY_NAME="discord-watcher-${os}-${arch}"
}

# ---------------------------------------------------------------------------
# Download helper (curl or wget)
# ---------------------------------------------------------------------------

fetch() {
    local url="$1" dest="$2"
    local tmp="${dest}.tmp.$$"
    if command -v curl &>/dev/null; then
        curl -fsSL "$url" -o "$tmp"
    elif command -v wget &>/dev/null; then
        wget -q "$url" -O "$tmp"
    else
        die "Neither curl nor wget found"
    fi
    mv -f "$tmp" "$dest"
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

check_prereqs() {
    local missing=0
    for cmd in claude jq; do
        if command -v "$cmd" &>/dev/null; then
            ok "$cmd available"
        else
            fail "$cmd not found"
            missing=1
        fi
    done
    if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
        fail "Neither curl nor wget found"
        missing=1
    else
        ok "$(command -v curl &>/dev/null && echo curl || echo wget) available"
    fi
    if [[ $missing -ne 0 ]]; then
        die "Install missing prerequisites and try again."
    fi
}

# ---------------------------------------------------------------------------
# Resolve download URL
# ---------------------------------------------------------------------------

resolve_url() {
    local file="$1"
    if [[ -n "$VERSION" ]]; then
        echo "${BASE_URL}/download/${VERSION}/${file}"
    else
        echo "${BASE_URL}/latest/download/${file}"
    fi
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

do_install() {
    echo ""
    echo "Discord Watcher — Remote Installer"
    echo "===================================="
    echo ""

    echo "Checking prerequisites..."
    check_prereqs
    echo ""

    detect_platform
    info "Platform: ${PLATFORM_OS}-${PLATFORM_ARCH}"
    echo ""

    # Download binary
    info "Downloading ${BINARY_NAME}..."
    mkdir -p "$INSTALL_DIR"
    fetch "$(resolve_url "$BINARY_NAME")" "${INSTALL_DIR}/discord-watcher"
    chmod +x "${INSTALL_DIR}/discord-watcher"
    ok "Binary installed to ${INSTALL_DIR}/discord-watcher"
    echo ""

    # Register MCP server
    info "Registering MCP server: $MCP_SERVER_NAME"
    claude mcp add --scope user --transport stdio "$MCP_SERVER_NAME" \
        -- "${INSTALL_DIR}/discord-watcher"
    ok "MCP server registered"
    echo ""

    # Verify install dir is on PATH
    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
        warn "${INSTALL_DIR} is not on your PATH"
        info "Add it: export PATH=\"${INSTALL_DIR}:\$PATH\""
    fi

    echo ""
    echo "Installation Summary"
    echo "--------------------"
    ok "Binary: ${INSTALL_DIR}/discord-watcher"
    ok "MCP server: $MCP_SERVER_NAME"
    echo ""
    echo "The watcher will activate when Claude Code starts a session."
    echo ""
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

do_uninstall() {
    echo ""
    echo "Discord Watcher — Remote Uninstaller"
    echo "======================================"
    echo ""

    # Remove binary
    if [[ -f "${INSTALL_DIR}/discord-watcher" ]]; then
        rm "${INSTALL_DIR}/discord-watcher"
        ok "Removed binary"
    else
        warn "Binary not found at ${INSTALL_DIR}/discord-watcher"
    fi

    # Remove MCP registration
    info "Removing MCP server registration..."
    if claude mcp remove "$MCP_SERVER_NAME" 2>/dev/null; then
        ok "MCP server removed"
    else
        warn "MCP server was not registered"
    fi

    echo ""
    ok "Uninstall complete"
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
    for cmd in claude jq; do
        if command -v "$cmd" &>/dev/null; then
            ok "$cmd available"
        else
            fail "$cmd not found"
            issues=$((issues + 1))
        fi
    done

    # Binary
    if [[ -x "${INSTALL_DIR}/discord-watcher" ]]; then
        ok "Binary at ${INSTALL_DIR}/discord-watcher"
    else
        fail "Binary not found at ${INSTALL_DIR}/discord-watcher"
        issues=$((issues + 1))
    fi

    # MCP registration
    if claude mcp list 2>/dev/null | grep -q "$MCP_SERVER_NAME"; then
        ok "MCP server registered"
    else
        fail "MCP server not registered"
        issues=$((issues + 1))
    fi

    echo ""
    if [[ $issues -eq 0 ]]; then
        ok "All checks passed"
    else
        fail "$issues issue(s) found"
        info "Run the installer to fix: curl -fsSL ...install-remote.sh | bash"
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
    case "$1" in
        --uninstall) ACTION="uninstall"; shift ;;
        --check)     ACTION="check"; shift ;;
        --version)   VERSION="${2:?--version requires a tag}"; shift 2 ;;
        *)           die "Unknown flag: $1 (use --uninstall, --check, or --version <tag>)" ;;
    esac
done

case "${ACTION:-install}" in
    install)   do_install ;;
    uninstall) do_uninstall ;;
    check)     do_check ;;
esac
