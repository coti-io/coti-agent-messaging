#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$PACKAGE_ROOT/.." && pwd)"

SSH_HOST="${MOLTBOOK_OUTREACH_DEPLOY_SSH_HOST:-grant}"
CLASSIC_DEPLOY_PATH="${MOLTBOOK_OUTREACH_DEPLOY_PATH:-${DEPLOY_PATH:-/home/ubuntu/outreach-agent}}"
CLASSIC_REMOTE_STORAGE_STATE="${MOLTBOOK_OUTREACH_REMOTE_REDDIT_STORAGE_STATE_PATH:-$CLASSIC_DEPLOY_PATH/outreach-agent/.browser/reddit-storage-state.json}"
ANALYTICS_REMOTE_STORAGE_STATE="${MOLTBOOK_ANALYTICS_REMOTE_REDDIT_STORAGE_STATE_PATH:-/home/ubuntu/coti-agent-messaging/repo/outreach-agent/.browser/reddit-storage-state.json}"
LOCAL_REDDIT_STORAGE_STATE="${OUTREACH_REDDIT_BROWSER_STORAGE_STATE_PATH:-${MOLTBOOK_OUTREACH_DEPLOY_REDDIT_STORAGE_STATE:-$PACKAGE_ROOT/.browser/reddit-storage-state.json}}"

sync_storage_state() {
  local remote_path="$1"
  ssh "$SSH_HOST" "mkdir -p '$(dirname "$remote_path")'"
  rsync -az -e "ssh" "$LOCAL_REDDIT_STORAGE_STATE" "$SSH_HOST:$remote_path"
  echo "Synced Reddit storage state to $SSH_HOST:$remote_path"
}

if [[ ! -f "$PROJECT_ROOT/package.json" ]]; then
  echo "Expected monorepo root at $PROJECT_ROOT" >&2
  exit 1
fi

cd "$PROJECT_ROOT"
if [[ ! -f "$PACKAGE_ROOT/dist/src/index.js" ]]; then
  npm run build -w @coti-agent-messaging/outreach-agent
fi
node "$PACKAGE_ROOT/dist/src/index.js" reddit-browser-login "$@"

if [[ ! -f "$LOCAL_REDDIT_STORAGE_STATE" ]]; then
  echo "Reddit storage state not found after login: $LOCAL_REDDIT_STORAGE_STATE" >&2
  exit 1
fi

sync_storage_state "$CLASSIC_REMOTE_STORAGE_STATE"
if [[ "$ANALYTICS_REMOTE_STORAGE_STATE" != "$CLASSIC_REMOTE_STORAGE_STATE" ]]; then
  sync_storage_state "$ANALYTICS_REMOTE_STORAGE_STATE"
fi
