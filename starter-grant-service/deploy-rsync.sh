#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$SCRIPT_DIR"

DEPLOY_PATH="${STARTER_GRANT_DEPLOY_PATH:-${DEPLOY_PATH:-/home/ubuntu/starter-grant-service}}"
SSH_HOST="grant"
SSH_PUBLIC_HOST="$(ssh -G "$SSH_HOST" 2>/dev/null | awk '/^hostname / { print $2; exit }')"
LOCAL_ENV_FILE="${STARTER_GRANT_DEPLOY_ENV_FILE:-$PACKAGE_DIR/.env}"
RSYNC_DELETE="${STARTER_GRANT_DEPLOY_DELETE:-1}"
PUBLIC_URL="${STARTER_GRANT_PUBLIC_URL:-}"
PUBLIC_HOST="${STARTER_GRANT_PUBLIC_HOST:-${SSH_PUBLIC_HOST:-$SSH_HOST}}"
PUBLIC_SCHEME="${STARTER_GRANT_PUBLIC_SCHEME:-http}"
PUBLIC_PORT="${STARTER_GRANT_PUBLIC_PORT:-}"

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

RSYNC_OPTS=(-az --compress --human-readable)
if [[ "$RSYNC_DELETE" == "1" ]]; then
  RSYNC_OPTS+=(--delete)
fi

ssh "$SSH_HOST" "mkdir -p '$DEPLOY_PATH'"

rsync "${RSYNC_OPTS[@]}" \
  --exclude ".env" \
  --exclude ".data/" \
  --exclude "node_modules/" \
  --exclude "dist/" \
  --exclude "dist-test/" \
  --exclude "*.log" \
  -e "ssh" \
  "$PACKAGE_DIR/" \
  "$SSH_HOST:$DEPLOY_PATH/"

if [[ -f "$LOCAL_ENV_FILE" ]]; then
  rsync "${RSYNC_OPTS[@]}" \
    -e "ssh" \
    "$LOCAL_ENV_FILE" \
    "$SSH_HOST:$DEPLOY_PATH/.env"
else
  echo "Skipping env sync because '$LOCAL_ENV_FILE' was not found." >&2
fi

ssh "$SSH_HOST" "DEPLOY_PATH='$DEPLOY_PATH' bash -se" <<'EOF'
ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    return
  fi

  if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1; then
    echo "Docker is missing and passwordless sudo is unavailable on the remote host." >&2
    exit 127
  fi

  export DEBIAN_FRONTEND=noninteractive
  sudo -n apt-get update
  sudo -n apt-get install -y docker.io
}

ensure_compose() {
  if docker compose version >/dev/null 2>&1; then
    return
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    return
  fi

  export DEBIAN_FRONTEND=noninteractive
  sudo -n apt-get update
  sudo -n apt-get install -y docker-compose-v2 ||
    sudo -n apt-get install -y docker-compose-plugin ||
    sudo -n apt-get install -y docker-compose
}

ensure_docker_user_access() {
  if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1; then
    echo "Passwordless sudo is required to grant Docker access to the remote user." >&2
    exit 127
  fi

  if ! getent group docker >/dev/null 2>&1; then
    sudo -n groupadd docker
  fi

  sudo -n usermod -aG docker "$USER"
  sudo -n systemctl enable --now docker >/dev/null 2>&1 || true
}

run_compose() {
  if docker compose version >/dev/null 2>&1; then
    sudo -n systemctl enable --now docker >/dev/null 2>&1 || true
    sudo -n docker compose up -d --build --remove-orphans
  elif command -v docker-compose >/dev/null 2>&1; then
    sudo -n systemctl enable --now docker >/dev/null 2>&1 || true
    sudo -n docker-compose up -d --build --remove-orphans
  else
    echo "Docker Compose is not installed or not accessible on the remote host." >&2
    exit 127
  fi
}

ensure_docker
ensure_compose
ensure_docker_user_access

mkdir -p "$DEPLOY_PATH/.data"
cd "$DEPLOY_PATH"
run_compose
EOF

echo
echo "Starter grant service deployed."
echo "Use this in SDK/MCP env:"
echo "STARTER_GRANT_SERVICE_URL=$PUBLIC_URL"
