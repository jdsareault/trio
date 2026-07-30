#!/usr/bin/env bash
# Claude nth — cross-platform setup
# Installs the MCP server and skills for all Claude Code sessions on this machine.
# Works on Linux, macOS, and Windows (Git Bash / MSYS2 / WSL).
#
# Modes:
#   hub    — Full install. /trio (local stdio) + /quartet (SSE for remotes).
#            Registers nth-trio (stdio) + nth-qweb (SSE). Runs quartet_server.py.
#   remote — Remote install. /trio (local stdio) + /quartet (SSE to hub).
#            Registers nth-trio (stdio) + nth-qweb (SSE pointing at hub).
#
# Both modes get /trio for local use. Hub also serves /quartet for remotes.
#
# After setup: restart Claude Code, then /trio and /quartet work.

set -euo pipefail

CLAUDE_DIR="${HOME}/.claude"
TRIO_SKILL_DIR="${CLAUDE_DIR}/skills/trio"
QUARTET_SKILL_DIR="${CLAUDE_DIR}/skills/quartet"
SERVER_DIR="${CLAUDE_DIR}/skills/nth/server"
DB_DIR="${CLAUDE_DIR}/nth"
OLD_DB_DIR="${CLAUDE_DIR}/roam"

echo "=== Claude nth Setup ==="
echo ""

# ---------- 0. Mode selection ----------

MODE=""
HUB_URL=""

if [ "${1:-}" = "hub" ] || [ "${1:-}" = "remote" ]; then
    MODE="$1"
    shift
else
    echo "Select setup mode:"
    echo "  1) hub    — This machine hosts the DB + serves remotes via Tailscale."
    echo "  2) remote — This machine connects to a hub via Tailscale."
    echo ""
    read -rp "Mode [1/2]: " mode_choice
    case "$mode_choice" in
        1|hub)    MODE="hub" ;;
        2|remote) MODE="remote" ;;
        *)
            echo "ERROR: Invalid choice. Run: bash setup.sh hub  OR  bash setup.sh remote"
            exit 1
            ;;
    esac
fi

if [ "$MODE" = "remote" ]; then
    if [ -n "${1:-}" ]; then
        HUB_URL="$1"
        shift
    else
        echo ""
        read -rp "Hub SSE URL (e.g. http://100.x.y.z:8000/sse): " HUB_URL
    fi
    if [ -z "$HUB_URL" ]; then
        echo "ERROR: Remote mode requires a hub URL."
        exit 1
    fi
fi

echo "Mode: $MODE"
echo ""

# ---------- 1. Python ----------

PYTHON_CMD=""
for cmd in python3 python; do
    if command -v "$cmd" &>/dev/null; then
        PYTHON_CMD="$cmd"
        break
    fi
done

if [ -z "$PYTHON_CMD" ]; then
    echo "ERROR: Python not found. Install Python 3.10+ and retry."
    exit 1
fi

PYTHON_VERSION=$("$PYTHON_CMD" --version 2>&1)
echo "Python: $PYTHON_VERSION ($PYTHON_CMD)"

# ---------- 2. MCP SDK ----------

if ! "$PYTHON_CMD" -c "from mcp.server.fastmcp import FastMCP" 2>/dev/null; then
    echo "Installing MCP SDK..."
    "$PYTHON_CMD" -m pip install mcp --quiet
    if ! "$PYTHON_CMD" -c "from mcp.server.fastmcp import FastMCP" 2>/dev/null; then
        echo "ERROR: Failed to install MCP SDK. Run: $PYTHON_CMD -m pip install mcp"
        exit 1
    fi
fi
echo "MCP SDK: OK"

# Hub mode needs uvicorn for SSE transport
if [ "$MODE" = "hub" ]; then
    if ! "$PYTHON_CMD" -c "import uvicorn" 2>/dev/null; then
        echo "Installing uvicorn (SSE transport)..."
        "$PYTHON_CMD" -m pip install uvicorn --quiet
    fi
    echo "uvicorn: OK"
fi

# ---------- 3. Copy files ----------

mkdir -p "$TRIO_SKILL_DIR" "$QUARTET_SKILL_DIR" "$SERVER_DIR" "$DB_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Each skill gets its own directory with a SKILL.md plus companion docs.
# Companion files (REFERENCE, PROTOCOLS) are per-flavor; DESIGN is shared.
if [ -f "$SCRIPT_DIR/SKILL-trio.md" ]; then
    cp "$SCRIPT_DIR/SKILL-trio.md" "$TRIO_SKILL_DIR/SKILL.md"
    [ -f "$SCRIPT_DIR/REFERENCE-trio.md" ] && cp "$SCRIPT_DIR/REFERENCE-trio.md" "$TRIO_SKILL_DIR/REFERENCE.md"
    [ -f "$SCRIPT_DIR/PROTOCOLS-trio.md" ] && cp "$SCRIPT_DIR/PROTOCOLS-trio.md" "$TRIO_SKILL_DIR/PROTOCOLS.md"
    [ -f "$SCRIPT_DIR/DESIGN.md" ] && cp "$SCRIPT_DIR/DESIGN.md" "$TRIO_SKILL_DIR/DESIGN.md"
fi
if [ -f "$SCRIPT_DIR/SKILL-quartet.md" ]; then
    cp "$SCRIPT_DIR/SKILL-quartet.md" "$QUARTET_SKILL_DIR/SKILL.md"
    [ -f "$SCRIPT_DIR/REFERENCE-quartet.md" ] && cp "$SCRIPT_DIR/REFERENCE-quartet.md" "$QUARTET_SKILL_DIR/REFERENCE.md"
    [ -f "$SCRIPT_DIR/PROTOCOLS-quartet.md" ] && cp "$SCRIPT_DIR/PROTOCOLS-quartet.md" "$QUARTET_SKILL_DIR/PROTOCOLS.md"
    [ -f "$SCRIPT_DIR/DESIGN.md" ] && cp "$SCRIPT_DIR/DESIGN.md" "$QUARTET_SKILL_DIR/DESIGN.md"
fi
# Remove old single-skill install
rm -f "${CLAUDE_DIR}/skills/nth/SKILL.md" 2>/dev/null || true
rm -f "${CLAUDE_DIR}/skills/nth/SKILL-trio.md" 2>/dev/null || true
rm -f "${CLAUDE_DIR}/skills/nth/SKILL-quartet.md" 2>/dev/null || true
echo "Skills: /trio -> $TRIO_SKILL_DIR, /quartet -> $QUARTET_SKILL_DIR"

# Copy server files (both modes need them for local /trio)
cp "$SCRIPT_DIR/server/nth_server.py" "$SERVER_DIR/nth_server.py"
cp "$SCRIPT_DIR/server/nth_monitor.py" "$SERVER_DIR/nth_monitor.py"
cp "$SCRIPT_DIR/server/nth_console.py" "$SERVER_DIR/nth_console.py"
cp "$SCRIPT_DIR/server/nth_dashboard.py" "$SERVER_DIR/nth_dashboard.py"
cp "$SCRIPT_DIR/server/nth_web.py" "$SERVER_DIR/nth_web.py"
cp "$SCRIPT_DIR/server/nth_ask_client.js" "$SERVER_DIR/nth_ask_client.js"
cp "$SCRIPT_DIR/server/nth_stt_worker.py" "$SERVER_DIR/nth_stt_worker.py"
cp "$SCRIPT_DIR/server/quartet_server.py" "$SERVER_DIR/quartet_server.py"
cp "$SCRIPT_DIR/server/nth_constants.py" "$SERVER_DIR/nth_constants.py"
cp "$SCRIPT_DIR/server/nth_stall_hook.py" "$SERVER_DIR/nth_stall_hook.py"
cp "$SCRIPT_DIR/server/nth_turn_hook.py" "$SERVER_DIR/nth_turn_hook.py"
cp "$SCRIPT_DIR/server/nth_activity_hook.py" "$SERVER_DIR/nth_activity_hook.py"

# Clean up deprecated files from earlier Haiku-subagent design
rm -f "$SERVER_DIR/nth_sentinel.py" \
      "$SERVER_DIR/nth_wait.py" \
      "$SERVER_DIR/messenger-foreground.py" \
      "$SERVER_DIR/sentinel-foreground.py" 2>/dev/null || true
rm -f "${CLAUDE_DIR}/agents/trio-sentinel.md" 2>/dev/null || true

echo "Server files: $SERVER_DIR"

# ---------- 4. Data migration ----------

if [ -f "$OLD_DB_DIR/roam.db" ] && [ ! -f "$DB_DIR/nth.db" ]; then
    cp "$OLD_DB_DIR/roam.db" "$DB_DIR/nth.db"
    echo "Migrated database: roam.db -> nth.db"
fi

# ---------- 5. Resolve native path ----------

SERVER_SCRIPT="$SERVER_DIR/nth_server.py"
NATIVE_PATH="$SERVER_SCRIPT"

PLATFORM="unknown"
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
        PLATFORM="windows"
        if command -v cygpath &>/dev/null; then
            NATIVE_PATH=$(cygpath -w "$SERVER_SCRIPT")
        else
            NATIVE_PATH=$(echo "$SERVER_SCRIPT" | sed 's|^/\([a-zA-Z]\)/|\1:\\|' | sed 's|/|\\|g')
        fi
        ;;
    Darwin*)
        PLATFORM="macos"
        ;;
    Linux*)
        PLATFORM="linux"
        ;;
esac
echo "Platform: $PLATFORM"

# ---------- 6. Register MCP servers ----------

if command -v claude &>/dev/null; then
    # Clean up old registrations
    claude mcp remove roam-hive-mind -s user 2>/dev/null || true
    claude mcp remove nth-cluster -s user 2>/dev/null || true
    claude mcp remove nth-hive -s user 2>/dev/null || true
    claude mcp remove nth-trio -s user 2>/dev/null || true
    claude mcp remove nth-qweb -s user 2>/dev/null || true

    # Both modes: register nth-trio (local stdio) — /trio always works
    claude mcp add nth-trio -s user -- "$PYTHON_CMD" "$NATIVE_PATH" 2>&1
    echo "MCP server: nth-trio registered (stdio, /trio)"

    # Remote mode: also register nth-qweb (SSE to hub) — /quartet connects to hub
    if [ "$MODE" = "remote" ]; then
        claude mcp add --transport sse -s user nth-qweb "$HUB_URL" 2>&1
        echo "MCP server: nth-qweb registered (SSE -> $HUB_URL, /quartet)"
    fi
else
    echo ""
    echo "WARNING: 'claude' CLI not found in PATH."
    echo "Register manually:"
    echo "  claude mcp add nth-trio -s user -- $PYTHON_CMD \"$NATIVE_PATH\""
    if [ "$MODE" = "remote" ]; then
        echo "  claude mcp add --transport sse -s user nth-qweb \"$HUB_URL\""
    fi
fi

# ---------- 7. Allowlist tools ----------

SETTINGS_JSON="${CLAUDE_DIR}/settings.json"
case "$PLATFORM" in
    windows)
        if command -v cygpath &>/dev/null; then
            SETTINGS_JSON=$(cygpath -w "$SETTINGS_JSON")
        else
            SETTINGS_JSON=$(echo "$SETTINGS_JSON" | sed 's|^/\([a-zA-Z]\)/|\1:\\|' | sed 's|/|\\|g')
        fi
        ;;
esac

# Tool base names (19 tools)
TOOL_BASES=(connect send poll ack claim complete cancel release lock unlock set_status rename status roster history end list cull cleanup retract)

# Build allowlist arrays
TRIO_TOOLS=()
QUARTET_TOOLS=()
for base in "${TOOL_BASES[@]}"; do
    TRIO_TOOLS+=("mcp__nth-trio__trio_${base}")
    QUARTET_TOOLS+=("mcp__nth-qweb__quartet_${base}")
done

# Combine based on mode
if [ "$MODE" = "hub" ]; then
    # Hub: allowlist trio tools only (quartet served, not consumed locally)
    ALL_TOOLS=("${TRIO_TOOLS[@]}")
else
    # Remote: allowlist both trio (local) and quartet (to hub)
    ALL_TOOLS=("${TRIO_TOOLS[@]}" "${QUARTET_TOOLS[@]}")
fi

# Patterns to clean up
OLD_PATTERNS="roam-hive-mind nth-cluster nth-hive"

"$PYTHON_CMD" -c "
import json, os

# Triple-quoted so an apostrophe in the path (e.g. /Users/O'Brien) can't abort
# the install with an unterminated string literal.
settings_path = r'''$SETTINGS_JSON'''
tools = $(printf '%s\n' "${ALL_TOOLS[@]}" | "$PYTHON_CMD" -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin]))")
old_patterns = '$OLD_PATTERNS'.split()

if os.path.exists(settings_path):
    with open(settings_path) as f:
        settings = json.load(f)
else:
    settings = {}

perms = settings.setdefault('permissions', {})
allow = perms.setdefault('allow', [])

# Remove old entries
removed = [t for t in allow if any(p in t for p in old_patterns)]
allow[:] = [t for t in allow if not any(p in t for p in old_patterns)]

added = 0
for tool in tools:
    if tool not in allow:
        allow.append(tool)
        added += 1

with open(settings_path, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

print(f'Permissions: {added} tool(s) allowlisted, {len(removed)} old entries removed')
"

# ---------- 7b. Register the stall-watchdog StopFailure hook ----------
# Three hooks:
#   nth_stall_hook    (StopFailure)              -> records a stall for the watchdog.
#   nth_turn_hook     (Stop + StopFailure)       -> stamps last_turn_end so the
#                                                   dashboard shows working vs. idle.
#   nth_activity_hook (PreToolUse + PostToolUse + UserPromptSubmit) -> stamps
#                                                   last_seen on every tool/prompt
#                                                   so 'working' spans the whole
#                                                   turn; also records the tool-use
#                                                   chip summary and sets/clears the
#                                                   'blocked' flag (PostToolUse
#                                                   clears it when a prompt is
#                                                   answered).
# Idempotent per (event, script) — re-running setup.sh never duplicates.
native_path() {  # native_path <posix-path>
    if [ "$PLATFORM" = "windows" ]; then
        if command -v cygpath &>/dev/null; then cygpath -w "$1"
        else echo "$1" | sed 's|^/\([a-zA-Z]\)/|\1:\\|' | sed 's|/|\\|g'; fi
    else
        echo "$1"
    fi
}
STALL_NATIVE=$(native_path "$SERVER_DIR/nth_stall_hook.py")
TURN_NATIVE=$(native_path "$SERVER_DIR/nth_turn_hook.py")
ACTIVITY_NATIVE=$(native_path "$SERVER_DIR/nth_activity_hook.py")

"$PYTHON_CMD" -c "
import json, os, tempfile
# Triple-quoted raw strings so an apostrophe in the path (e.g. /Users/O'Brien)
# doesn't produce an unterminated string literal and abort the install.
settings_path = r'''$SETTINGS_JSON'''
py = r'''$PYTHON_CMD'''
stall = r'''$STALL_NATIVE'''
turn  = r'''$TURN_NATIVE'''
activity = r'''$ACTIVITY_NATIVE'''
stall_cmd = f'{py} \"{stall}\"'
turn_cmd  = f'{py} \"{turn}\"'
activity_cmd = f'{py} \"{activity}\"'

# Match every StopFailure error type (not just the transient ones): the watchdog
# classifies them itself — nudging transient stalls and surfacing the rest to a
# human. A narrow matcher would make that surface path dead code.
matcher = ('overloaded|rate_limit|server_error|unknown|authentication_failed'
           '|oauth_org_not_allowed|billing_error|invalid_request|model_not_found'
           '|max_output_tokens')

settings = {}
if os.path.exists(settings_path):
    try:
        with open(settings_path) as f:
            settings = json.load(f)
    except (ValueError, OSError) as e:
        # Don't abort the whole install on a malformed/unreadable settings.json —
        # skip the hooks and tell the user to add them by hand (see CHANGELOG).
        print(f'trio hooks: SKIPPED (could not read {settings_path}: {e})')
        raise SystemExit(0)
if not isinstance(settings, dict):
    settings = {}

hooks = settings.setdefault('hooks', {})
if not isinstance(hooks, dict):
    print('trio hooks: SKIPPED (settings.hooks is not an object)')
    raise SystemExit(0)

def register(event, marker, cmd, matcher=None):
    arr = hooks.setdefault(event, [])
    if not isinstance(arr, list):
        print(f'trio hooks: SKIPPED ({event} is not a list)')
        return False
    if any(marker in json.dumps(e) for e in arr):
        return False  # already present
    entry = {'hooks': [{'type': 'command', 'command': cmd}]}
    if matcher:
        entry['matcher'] = matcher
    arr.append(entry)
    return True

changed = False
# The stall hook is scoped by error type (the watchdog classifies them). The
# turn hook must fire on EVERY turn end — including a novel StopFailure error not
# in the matcher — or a session that acted mid-turn could show a false 'working'
# forever, so it's registered matcher-less on StopFailure.
changed |= register('StopFailure', 'nth_stall_hook.py', stall_cmd, matcher)
changed |= register('Stop',        'nth_turn_hook.py',  turn_cmd)
changed |= register('StopFailure', 'nth_turn_hook.py',  turn_cmd)
# The activity hook stamps sessions.last_seen on every tool call and prompt so
# the dashboard shows 'working' for the whole active turn (not just from the
# agent's first trio call). It also records a short tool summary (the tool-use /
# sub-agent chips) and flips the 'blocked' flag for interactive host prompts.
# Matcher-less on all three events — every tool/prompt is activity, regardless
# of kind. PostToolUse is what CLEARS 'blocked' when the prompt is answered.
changed |= register('PreToolUse',       'nth_activity_hook.py', activity_cmd)
changed |= register('PostToolUse',      'nth_activity_hook.py', activity_cmd)
changed |= register('UserPromptSubmit', 'nth_activity_hook.py', activity_cmd)

if not changed:
    print('trio hooks: already registered')
else:
    # Atomic write: a crash/disk-full mid-write must never truncate the user's
    # settings.json and lose unrelated settings.
    d = os.path.dirname(settings_path) or '.'
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.settings-', suffix='.json')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(settings, f, indent=2)
            f.write('\n')
        os.replace(tmp, settings_path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    print('trio hooks: registered (stall-watchdog + working indicator + activity)')
"

# ---------- 8. Verify ----------

echo ""
echo "=== Setup Complete ($MODE mode) ==="
echo ""
echo "  /trio:    nth-trio (local stdio, always works)"
if [ "$MODE" = "hub" ]; then
    echo "  /quartet: Start quartet_server.py to serve remotes"
    echo ""
    echo "  Server:   $NATIVE_PATH"
    echo "  Database: $DB_DIR/nth.db (created on first use)"
    echo ""
    echo "  To serve remote /quartet sessions:"
    echo "    python $SERVER_DIR/quartet_server.py"
    echo "  (SSE on 0.0.0.0:8000 — accessible via Tailscale)"
else
    echo "  /quartet: nth-qweb (SSE -> $HUB_URL)"
fi
echo ""
echo "  Config: ~/.claude.json (via claude mcp add)"
echo "  Perms:  $SETTINGS_JSON"
echo ""
echo "Next steps:"
echo "  1. Restart Claude Code (exit and re-launch)"
echo "  2. Run /mcp to verify trio + quartet tools appear"
echo "  3. Try: /trio hello world"
echo ""
echo "Verify with: claude mcp list"
echo ""
echo "Watch channel traffic live from a terminal (no Claude session needed):"
echo "  python3 $SERVER_DIR/nth_console.py              # follow all channels"
echo "  python3 $SERVER_DIR/nth_console.py -c MYCHAN    # one channel"
echo "  python3 $SERVER_DIR/nth_console.py --snapshot   # print + exit"
echo ""
echo "Dashboard view for 3-8 agent group chats (needs 'pip install rich'):"
echo "  python3 $SERVER_DIR/nth_dashboard.py MYCHAN     # per-agent engagement signals"
echo "  (Keys inside: s cycle sort · p pause · i type-a-message · q quit)"
echo ""
echo "Web dashboard for browser access over Tailscale (stdlib only):"
echo "  python3 $SERVER_DIR/nth_web.py MYCHAN           # loopback only (http://127.0.0.1:8765/)"
echo "  python3 $SERVER_DIR/nth_web.py MYCHAN --tailnet # reachable from tailnet peers"
echo ""
echo "  (Windows: substitute 'py' for 'python3')"
