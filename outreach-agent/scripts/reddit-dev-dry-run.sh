#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WORKER_WAIT_SEC="${REDDIT_DEV_WORKER_WAIT_SEC:-4}"
BRIDGE_DIR="${OUTREACH_REDDIT_BROWSER_BRIDGE_DIR:-$ROOT/.bridge/reddit-browser}"
STATUS_PATH="$BRIDGE_DIR/status.json"

echo "Building outreach-agent..."
npm run build >/dev/null

echo "Stopping any existing Reddit browser worker..."
npm run reddit:browser-worker:stop >/dev/null 2>&1 || true

echo "Starting headed Reddit browser worker (background)..."
npm run reddit:browser-worker &
WORKER_PID=$!
cleanup() {
  kill "$WORKER_PID" >/dev/null 2>&1 || true
  npm run reddit:browser-worker:stop >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! kill -0 "$WORKER_PID" 2>/dev/null; then
  echo "Reddit browser worker failed to start (PID $WORKER_PID exited immediately)." >&2
  exit 1
fi

echo "Waiting up to ${WORKER_WAIT_SEC}s for worker status at $STATUS_PATH..."
deadline=$((SECONDS + WORKER_WAIT_SEC))
while [ "$SECONDS" -lt "$deadline" ]; do
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "Reddit browser worker exited before becoming ready." >&2
    exit 1
  fi
  if [ -f "$STATUS_PATH" ]; then
    break
  fi
  sleep 1
done

if [ ! -f "$STATUS_PATH" ]; then
  echo "Reddit browser worker did not write status.json within ${WORKER_WAIT_SEC}s." >&2
  echo "Check worker logs or increase REDDIT_DEV_WORKER_WAIT_SEC." >&2
  exit 1
fi

echo "Running Reddit session dry-run..."
npm run reddit:session:dry-run
