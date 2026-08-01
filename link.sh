#!/usr/bin/env bash
# link.sh — DEV deploy via symlinks (alternative to setup.sh's copy deploy).
#
# Points the installed ~/.claude/skills/* files at THIS repo working tree, so the
# running server + skills always reflect the checked-out code. No copies, no drift:
# editing a file here IS editing what runs. Restart Claude Code to reload code.
#
# Idempotent — safe to re-run (e.g. after adding a new server module).
# NOTE: running setup.sh (copy deploy) will overwrite these symlinks with copies;
# re-run link.sh afterward to restore the dev links.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"
SERVER_DIR="${CLAUDE_DIR}/skills/nth/server"
TRIO_SKILL_DIR="${CLAUDE_DIR}/skills/trio"
QUARTET_SKILL_DIR="${CLAUDE_DIR}/skills/quartet"

mkdir -p "$SERVER_DIR" "$TRIO_SKILL_DIR" "$QUARTET_SKILL_DIR"

link() {  # link <repo-target> <install-link-path>
  local target="$1" linkpath="$2"
  if [ ! -e "$target" ]; then echo "  skip (missing): $target"; return; fi
  ln -snf "$target" "$linkpath"
  echo "  $linkpath -> $target"
}

echo "Linking server modules -> $SERVER_DIR"
for f in "$REPO_DIR"/server/*.py "$REPO_DIR"/server/*.js; do
  [ -e "$f" ] || continue
  link "$f" "$SERVER_DIR/$(basename "$f")"
done
# nth_web.py reads this tree at import time; link it as one unit so a dev
# install sees modular CSS and JS changes without a copy-deploy cycle.
if [ -e "$SERVER_DIR/web" ] && [ ! -L "$SERVER_DIR/web" ]; then
  rm -rf "$SERVER_DIR/web"
fi
link "$REPO_DIR/server/web" "$SERVER_DIR/web"

echo "Linking /trio skill docs -> $TRIO_SKILL_DIR"
link "$REPO_DIR/SKILL-trio.md"     "$TRIO_SKILL_DIR/SKILL.md"
link "$REPO_DIR/REFERENCE-trio.md" "$TRIO_SKILL_DIR/REFERENCE.md"
link "$REPO_DIR/PROTOCOLS-trio.md" "$TRIO_SKILL_DIR/PROTOCOLS.md"
link "$REPO_DIR/DESIGN.md"         "$TRIO_SKILL_DIR/DESIGN.md"

echo "Linking /quartet skill docs -> $QUARTET_SKILL_DIR"
link "$REPO_DIR/SKILL-quartet.md"     "$QUARTET_SKILL_DIR/SKILL.md"
link "$REPO_DIR/REFERENCE-quartet.md" "$QUARTET_SKILL_DIR/REFERENCE.md"
link "$REPO_DIR/PROTOCOLS-quartet.md" "$QUARTET_SKILL_DIR/PROTOCOLS.md"
link "$REPO_DIR/DESIGN.md"            "$QUARTET_SKILL_DIR/DESIGN.md"

echo
echo "Done. Running server + skills now point at: $REPO_DIR"
echo "Restart Claude Code so nth-trio and /trio reload from these files."
