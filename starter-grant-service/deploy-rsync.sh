#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$SCRIPT_DIR"

DEPLOY_HOST="${STARTER_GRANT_DEPLOY_HOST:-${DEPLOY_HOST:-}}"
DEPLOY_USER="${STARTER_GRANT_DEPLOY_USER:-${DEPLOY_USER:-}}"
DEPLOY_PATH="${STARTER_GRANT_DEPLOY_PATH:-${DEPLOY_PATH:-}}"
DEPLOY_PORT="${STARTER_GRANT_DEPLOY_PORT:-${DEPLOY_PORT:-22}}"
LOCAL_ENV_FILE="${STARTER_GRANT_DEPLOY_ENV_FILE:-$PACKAGE_DIR/.env}"
RSYNC_DELETE="${STARTER_GRANT_DEPLOY_DELETE:-1}"
PUBLIC_URL="${STARTER_GRANT_PUBLIC_URL:-}"
PUBLIC_HOST="${STARTER_GRANT_PUBLIC_HOST:-$DEPLOY_HOST}"
PUBLIC_SCHEME="${STARTER_GRANT_PUBLIC_SCHEME:-http}"
PUBLIC_PORT="${STARTER_GRANT_PUBLIC_PORT:-}"

if [[ -z "$DEPLOY_HOST" || -z "$DEPLOY_PATH" ]]; then
  echo "Missing deploy target. Set STARTER_GRANT_DEPLOY_HOST and STARTER_GRANT_DEPLOY_PATH." >&2
  exit 1
fi

SERVICE_PORT="8787"
if [[ -f "$LOCAL_ENV_FILE" ]]; then
  while IFS='=' read -r key value; do
    if [[ "$key" == "STARTER_GRANT_SERVICE_PORT" && -n "${value:-}" ]]; then
      SERVICE_PORT="${value%$'\r'}"
      break
    fi
  done < "$LOCAL_ENV_FILE"
fi

if [[ -z "$PUBLIC_PORT" ]]; then
  PUBLIC_PORT="$SERVICE_PORT"
fi

if [[ -z "$PUBLIC_URL" ]]; then
  if [[ "$PUBLIC_SCHEME" == "https" && "$PUBLIC_PORT" == "443" ]] || [[ "$PUBLIC_SCHEME" == "http" && "$PUBLIC_PORT" == "80" ]]; then
    PUBLIC_URL="${PUBLIC_SCHEME}://${PUBLIC_HOST}"
  else
    PUBLIC_URL="${PUBLIC_SCHEME}://${PUBLIC_HOST}:${PUBLIC_PORT}"
  fi
fi

REMOTE_TARGET="$DEPLOY_HOST"
if [[ -n "$DEPLOY_USER" ]]; then
  REMOTE_TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"
fi

SSH_OPTS=(-p "$DEPLOY_PORT")
RSYNC_OPTS=(-az --compress --human-readable)
if [[ "$RSYNC_DELETE" == "1" ]]; then
  RSYNC_OPTS+=(--delete)
fi

rsync "${RSYNC_OPTS[@]}" \
  --exclude ".env" \
  --exclude ".data/" \
  --exclude "node_modules/" \
  --exclude "dist/" \
  --exclude "dist-test/" \
  --exclude "*.log" \
  -e "ssh ${SSH_OPTS[*]}" \
  "$PACKAGE_DIR/" \
  "$REMOTE_TARGET:$DEPLOY_PATH/"

if [[ -f "$LOCAL_ENV_FILE" ]]; then
  rsync "${RSYNC_OPTS[@]}" \
    -e "ssh ${SSH_OPTS[*]}" \
    "$LOCAL_ENV_FILE" \
    "$REMOTE_TARGET:$DEPLOY_PATH/.env"
else
  echo "Skipping env sync because '$LOCAL_ENV_FILE' was not found." >&2
fi

ssh "${SSH_OPTS[@]}" "$REMOTE_TARGET" \
  "mkdir -p '$DEPLOY_PATH/.data' && cd '$DEPLOY_PATH' && docker compose up -d --build --remove-orphans"

echo
echo "Starter grant service deployed."
echo "SDK URL:"
echo "STARTER_GRANT_SERVICE_URL=$PUBLIC_URL"
