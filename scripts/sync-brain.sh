#!/usr/bin/env bash
# Appends recent git commits and a file-architecture summary to the vault inbox.
# Usage: scripts/sync-brain.sh [N_COMMITS=15]
set -euo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
INBOX="$ROOT/docs/brain/00_Inbox/Inbox Log.md"
N="${1:-15}"
mkdir -p "$(dirname "$INBOX")"
if [ ! -f "$INBOX" ]; then
  printf -- '---\ntags: [inbox, sync]\ndate: %s\nstatus: active\n---\n\n# Inbox Log\n\nBack to [[000_Index]].\n' "$(date +%F)" > "$INBOX"
fi
{
  printf '\n## Sync %s (branch `%s`)\n\n### Recent commits\n' "$(date '+%F %H:%M')" "$(git -C "$ROOT" branch --show-current)"
  git -C "$ROOT" log -n "$N" --pretty='- `%h` %s (%ad)' --date=short
  printf '\n### Architecture\n'
  for d in apps packages/modules; do
    [ -d "$ROOT/$d" ] && printf -- '- `%s/`: %s\n' "$d" "$(ls "$ROOT/$d" | tr '\n' ' ')"
  done
  printf -- '- tracked files: %s (.ts %s, .tsx %s, .sql %s, .md %s)\n' \
    "$(git -C "$ROOT" ls-files | wc -l | tr -d ' ')" \
    "$(git -C "$ROOT" ls-files '*.ts' | wc -l | tr -d ' ')" "$(git -C "$ROOT" ls-files '*.tsx' | wc -l | tr -d ' ')" \
    "$(git -C "$ROOT" ls-files '*.sql' | wc -l | tr -d ' ')" "$(git -C "$ROOT" ls-files '*.md' | wc -l | tr -d ' ')"
} >> "$INBOX"
echo "Appended to $INBOX"
