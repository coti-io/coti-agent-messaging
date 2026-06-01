#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$SCRIPT_DIR"
PROJECT_ROOT="$(cd "$PACKAGE_DIR/.." && pwd)"

DEPLOY_PATH="${MOLTBOOK_OUTREACH_DEPLOY_PATH:-${DEPLOY_PATH:-/home/ubuntu/outreach-agent}}"
SSH_HOST="grant"
LOCAL_REDDIT_STORAGE_STATE="${MOLTBOOK_OUTREACH_DEPLOY_REDDIT_STORAGE_STATE:-$PROJECT_ROOT/outreach-agent/.browser/reddit-storage-state.json}"
DEFAULT_AGENT_ENV_FILE="$PROJECT_ROOT/moltbook-outreach-agent/.env"
if [[ -n "${MOLTBOOK_OUTREACH_DEPLOY_ENV_FILE:-}" ]]; then
  LOCAL_ENV_FILE="$MOLTBOOK_OUTREACH_DEPLOY_ENV_FILE"
elif [[ -f "$DEFAULT_AGENT_ENV_FILE" ]]; then
  LOCAL_ENV_FILE="$DEFAULT_AGENT_ENV_FILE"
else
  LOCAL_ENV_FILE="$PROJECT_ROOT/.env"
fi
RSYNC_DELETE="${MOLTBOOK_OUTREACH_DEPLOY_DELETE:-1}"

REMOTE_PACKAGE_DIR="$DEPLOY_PATH/outreach-agent"
REMOTE_REDDIT_STORAGE_STATE="$REMOTE_PACKAGE_DIR/.browser/reddit-storage-state.json"
RUNTIME_DIR="$DEPLOY_PATH/.runtime"
SERVICE_NAME="moltbook-outreach-heartbeat"
EXECUTOR_SERVICE_NAME="${SERVICE_NAME}-executor"
SERVICE_UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
TIMER_UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.timer"
EXECUTOR_SERVICE_UNIT_PATH="/etc/systemd/system/${EXECUTOR_SERVICE_NAME}.service"
EXECUTOR_TIMER_UNIT_PATH="/etc/systemd/system/${EXECUTOR_SERVICE_NAME}.timer"

if [[ ! -f "$LOCAL_ENV_FILE" ]]; then
  echo "Missing local outreach env file: '$LOCAL_ENV_FILE'" >&2
  echo "Set MOLTBOOK_OUTREACH_DEPLOY_ENV_FILE, create moltbook-outreach-agent/.env, or create .env at the repo root." >&2
  exit 1
fi

RSYNC_OPTS=(-az --compress --human-readable)
if [[ "$RSYNC_DELETE" == "1" ]]; then
  RSYNC_OPTS+=(--delete)
fi

ssh "$SSH_HOST" "mkdir -p '$DEPLOY_PATH' '$RUNTIME_DIR'"
ssh "$SSH_HOST" "sudo -n systemctl stop '${SERVICE_NAME}.timer' '${SERVICE_NAME}.service' '${EXECUTOR_SERVICE_NAME}.timer' '${EXECUTOR_SERVICE_NAME}.service' >/dev/null 2>&1 || true"

rsync "${RSYNC_OPTS[@]}" \
  --exclude ".env" \
  --exclude ".data/" \
  --exclude ".runtime/" \
  --exclude ".bridge/" \
  --exclude "node_modules/" \
  --exclude "dist/" \
  --exclude "dist-test/" \
  --exclude "*.log" \
  -e "ssh" \
  "$PROJECT_ROOT/README.md" \
  "$PROJECT_ROOT/docs" \
  "$PROJECT_ROOT/contracts" \
  "$PROJECT_ROOT/outreach-agent" \
  "$SSH_HOST:$DEPLOY_PATH/"

rsync "${RSYNC_OPTS[@]}" \
  -e "ssh" \
  "$LOCAL_ENV_FILE" \
  "$SSH_HOST:$REMOTE_PACKAGE_DIR/.env"

if [[ -f "$LOCAL_REDDIT_STORAGE_STATE" ]]; then
  ssh "$SSH_HOST" "mkdir -p '$(dirname "$REMOTE_REDDIT_STORAGE_STATE")'"
  rsync "${RSYNC_OPTS[@]}" \
    -e "ssh" \
    "$LOCAL_REDDIT_STORAGE_STATE" \
    "$SSH_HOST:$REMOTE_REDDIT_STORAGE_STATE"
else
  echo "Skipping Reddit storage-state sync; file not found: $LOCAL_REDDIT_STORAGE_STATE"
fi

ssh "$SSH_HOST" \
  "DEPLOY_PATH='$DEPLOY_PATH' REMOTE_PACKAGE_DIR='$REMOTE_PACKAGE_DIR' RUNTIME_DIR='$RUNTIME_DIR' SERVICE_NAME='$SERVICE_NAME' EXECUTOR_SERVICE_NAME='$EXECUTOR_SERVICE_NAME' SERVICE_UNIT_PATH='$SERVICE_UNIT_PATH' TIMER_UNIT_PATH='$TIMER_UNIT_PATH' EXECUTOR_SERVICE_UNIT_PATH='$EXECUTOR_SERVICE_UNIT_PATH' EXECUTOR_TIMER_UNIT_PATH='$EXECUTOR_TIMER_UNIT_PATH' bash -se" <<'EOF'
set -euo pipefail

APT_UPDATED=0

ensure_passwordless_sudo() {
  if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1; then
    echo "Passwordless sudo is required on the remote host." >&2
    exit 127
  fi
}

apt_install() {
  ensure_passwordless_sudo

  if [[ "$APT_UPDATED" != "1" ]]; then
    export DEBIAN_FRONTEND=noninteractive
    sudo -n apt-get update
    APT_UPDATED=1
  fi

  sudo -n apt-get install -y "$@"
}

node_major_is_supported() {
  command -v node >/dev/null 2>&1 &&
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'
}

ensure_runtime_prereqs() {
  local missing=0

  if ! command -v git >/dev/null 2>&1; then
    missing=1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    missing=1
  fi
  if ! command -v flock >/dev/null 2>&1; then
    missing=1
  fi
  if ! node_major_is_supported; then
    missing=1
  fi

  if [[ "$missing" == "1" ]]; then
    apt_install git util-linux nodejs npm
  fi

  if ! node_major_is_supported; then
    echo "Remote Node.js version must be >= 18 after installation. Upgrade the server Node.js runtime and redeploy." >&2
    exit 1
  fi
}

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

install_unit_from_template() {
  local template_path="$1"
  local output_path="$2"
  local unit_service_name="${3:-$SERVICE_NAME}"
  local description="${4:-Moltbook outreach heartbeat}"
  local venue="${5:-moltbook}"
  local command="${6:-heartbeat}"
  local run_label="${7:-heartbeat}"
  local remote_user="$USER"
  local escaped_user
  local escaped_package_dir
  local escaped_runtime_dir
  local escaped_env_file
  local escaped_lock_file
  local escaped_service_name
  local escaped_description
  local escaped_venue
  local escaped_command
  local escaped_run_label
  local escaped_state_path
  local escaped_heartbeat_report_path

  escaped_user="$(escape_sed_replacement "$remote_user")"
  escaped_package_dir="$(escape_sed_replacement "$REMOTE_PACKAGE_DIR")"
  escaped_runtime_dir="$(escape_sed_replacement "$RUNTIME_DIR")"
  escaped_env_file="$(escape_sed_replacement "$REMOTE_PACKAGE_DIR/.env")"
  escaped_lock_file="$(escape_sed_replacement "$RUNTIME_DIR/heartbeat.lock")"
  escaped_service_name="$(escape_sed_replacement "$unit_service_name")"
  escaped_description="$(escape_sed_replacement "$description")"
  escaped_venue="$(escape_sed_replacement "$venue")"
  escaped_command="$(escape_sed_replacement "$command")"
  escaped_run_label="$(escape_sed_replacement "$run_label")"
  escaped_state_path="$(escape_sed_replacement "$RUNTIME_DIR/state.json")"
  escaped_heartbeat_report_path="$(escape_sed_replacement "$RUNTIME_DIR/last-heartbeat.json")"

  sed \
    -e "s|__DESCRIPTION__|$escaped_description|g" \
    -e "s|__REMOTE_USER__|$escaped_user|g" \
    -e "s|__PACKAGE_DIR__|$escaped_package_dir|g" \
    -e "s|__RUNTIME_DIR__|$escaped_runtime_dir|g" \
    -e "s|__ENV_FILE__|$escaped_env_file|g" \
    -e "s|__LOCK_FILE__|$escaped_lock_file|g" \
    -e "s|__SERVICE_NAME__|$escaped_service_name|g" \
    -e "s|__VENUE__|$escaped_venue|g" \
    -e "s|__STATE_PATH__|$escaped_state_path|g" \
    -e "s|__HEARTBEAT_REPORT_PATH__|$escaped_heartbeat_report_path|g" \
    -e "s|__COMMAND__|$escaped_command|g" \
    -e "s|__RUN_LABEL__|$escaped_run_label|g" \
    -e "s|__AGENT_ID__|moltbook-outreach|g" \
    "$template_path" | sudo -n tee "$output_path" >/dev/null
}

ensure_runtime_prereqs

mkdir -p "$RUNTIME_DIR"

migrate_runtime_artifacts() {
  local runtime_prompt_rotation="$RUNTIME_DIR/prompt-rotation.json"
  local runtime_llm_debug_dir="$RUNTIME_DIR/llm-debug"
  local legacy_prompt_rotation="$REMOTE_PACKAGE_DIR/.data/prompt-rotation.json"
  local legacy_llm_debug_dir="$REMOTE_PACKAGE_DIR/.data/llm-debug"
  local migrated_suffix

  migrated_suffix="$(date +%Y%m%d%H%M%S)"

  if [[ -f "$legacy_prompt_rotation" && ! -f "$runtime_prompt_rotation" ]]; then
    mv "$legacy_prompt_rotation" "$runtime_prompt_rotation"
  elif [[ -f "$legacy_prompt_rotation" ]]; then
    mv "$legacy_prompt_rotation" "${legacy_prompt_rotation}.migrated-${migrated_suffix}"
  fi

  if [[ -d "$legacy_llm_debug_dir" ]]; then
    mkdir -p "$runtime_llm_debug_dir"
    if compgen -G "$legacy_llm_debug_dir/*.json" >/dev/null 2>&1; then
      cp -n "$legacy_llm_debug_dir"/*.json "$runtime_llm_debug_dir"/ 2>/dev/null || true
    fi
    mv "$legacy_llm_debug_dir" "${legacy_llm_debug_dir}.migrated-${migrated_suffix}"
  fi
}

cd "$REMOTE_PACKAGE_DIR"
rm -f package-lock.json
rm -rf node_modules/@coti-io/coti-sdk-private-messaging
npm install --no-fund --no-audit
npm run build
migrate_runtime_artifacts

install_unit_from_template \
  "$REMOTE_PACKAGE_DIR/deploy/systemd/moltbook-outreach-heartbeat.service" \
  "$SERVICE_UNIT_PATH" \
  "$SERVICE_NAME" \
  "Moltbook outreach heartbeat" \
  "moltbook" \
  "heartbeat" \
  "heartbeat"
install_unit_from_template \
  "$REMOTE_PACKAGE_DIR/deploy/systemd/moltbook-outreach-heartbeat.timer" \
  "$TIMER_UNIT_PATH" \
  "$SERVICE_NAME"
install_unit_from_template \
  "$REMOTE_PACKAGE_DIR/deploy/systemd/moltbook-outreach-executor.service" \
  "$EXECUTOR_SERVICE_UNIT_PATH" \
  "$EXECUTOR_SERVICE_NAME" \
  "Moltbook outreach executor" \
  "moltbook" \
  "executor" \
  "executor"
install_unit_from_template \
  "$REMOTE_PACKAGE_DIR/deploy/systemd/moltbook-outreach-executor.timer" \
  "$EXECUTOR_TIMER_UNIT_PATH" \
  "$EXECUTOR_SERVICE_NAME"

sudo -n systemctl daemon-reload
sudo -n systemctl enable --now "${SERVICE_NAME}.timer"
sudo -n systemctl restart "${SERVICE_NAME}.timer"
sudo -n systemctl enable --now "${EXECUTOR_SERVICE_NAME}.timer"
sudo -n systemctl restart "${EXECUTOR_SERVICE_NAME}.timer"
EOF

echo
echo "Moltbook outreach agent deployed."
echo "Remote path: $DEPLOY_PATH"
echo "Check timer:"
echo "ssh $SSH_HOST 'sudo systemctl status ${SERVICE_NAME}.timer --no-pager'"
echo "ssh $SSH_HOST 'sudo systemctl status ${EXECUTOR_SERVICE_NAME}.timer --no-pager'"
echo "Run one heartbeat now:"
echo "ssh $SSH_HOST 'sudo systemctl start ${SERVICE_NAME}.service'"
echo "Run executor now:"
echo "ssh $SSH_HOST 'sudo systemctl start ${EXECUTOR_SERVICE_NAME}.service'"
echo "Recent logs:"
echo "ssh $SSH_HOST 'sudo journalctl -u ${SERVICE_NAME}.service -n 100 --no-pager'"
