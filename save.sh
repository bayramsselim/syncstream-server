#!/usr/bin/env bash
# save.sh — one-shot checkpoint: commit + tag + push + local zip backup.
#
# Usage:
#   ./save.sh "message describing this checkpoint"
#   ./save.sh                                 # uses default timestamp message
#
# Creates:
#   - a git commit (only if there are changes)
#   - a git tag named save-YYYYMMDD-HHMMSS
#   - pushes both to origin
#   - a backup zip at backups/save-YYYYMMDD-HHMMSS.zip

set -euo pipefail
cd "$(dirname "$0")"

STAMP="$(date +%Y%m%d-%H%M%S)"
TAG="save-$STAMP"
MSG="${1:-checkpoint $STAMP}"

# 1. Commit any pending changes (only if there are any)
if [[ -n "$(git status --porcelain)" ]]; then
  echo "→ committing changes..."
  git add -A
  git commit -m "$MSG"
else
  echo "→ no pending changes, tagging current HEAD..."
fi

# 2. Tag
git tag -a "$TAG" -m "$MSG"

# 3. Push commit (if any) and tag to origin
echo "→ pushing to origin..."
git push origin HEAD
git push origin "$TAG"

# 4. Local zip backup
mkdir -p backups
ZIP="backups/$TAG.zip"
zip -rq "$ZIP" extension/ server/ server.js package.json .gitignore \
  -x "*.DS_Store" "*/node_modules/*" "*/.git/*"
echo "→ local backup: $ZIP ($(du -h "$ZIP" | cut -f1))"

echo "✓ saved as $TAG"
echo ""
echo "to roll back later:"
echo "  git reset --hard $TAG    # destructive, drops newer commits"
echo "  git checkout $TAG        # detached, just look around"
echo "  git checkout -b try $TAG # branch off this state"
