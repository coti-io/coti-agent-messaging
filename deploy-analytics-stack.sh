#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_PATH="${MOLTBOOK_ANALYTICS_DEPLOY_MANIFEST:-$SCRIPT_DIR/deploy/agents.json}"

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "Missing deploy manifest: $MANIFEST_PATH" >&2
  echo "Copy deploy/agents.example.json to deploy/agents.json and fill in envFile paths." >&2
  exit 1
fi

MANIFEST_JSON="$(MANIFEST_PATH="$MANIFEST_PATH" python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["MANIFEST_PATH"])
data = json.loads(path.read_text())
data.setdefault("deployPath", "/home/ubuntu/coti-agent-messaging")
data.setdefault("sshHost", "grant")
data.setdefault("dashboard", {})
data["dashboard"].setdefault("host", "127.0.0.1")
data["dashboard"].setdefault("port", 8788)
data["dashboard"].setdefault("serviceName", "moltbook-analytics-dashboard")

for agent in data.get("agents", []):
    if not agent.get("agentId"):
        raise SystemExit("Every agent needs agentId")
    if not agent.get("envFile"):
        raise SystemExit(f"Agent {agent['agentId']} needs envFile")
    agent.setdefault("displayName", agent["agentId"])
    agent.setdefault("serviceName", f"moltbook-outreach-{agent['agentId']}")

print(json.dumps(data))
PY
)"

value() {
  MANIFEST_JSON="$MANIFEST_JSON" python3 - "$1" <<'PY'
import json
import os
import sys

data = json.loads(os.environ["MANIFEST_JSON"])
current = data
for part in sys.argv[1].split("."):
    current = current[part]
print(current)
PY
}

SSH_HOST="$(value sshHost)"
DEPLOY_PATH="$(value deployPath)"
REMOTE_REPO_DIR="$DEPLOY_PATH/repo"
AGENTS_ROOT="$DEPLOY_PATH/agents"
DASHBOARD_DIR="$DEPLOY_PATH/dashboard"
DASHBOARD_SERVICE_NAME="$(value dashboard.serviceName)"
DASHBOARD_HOST="$(value dashboard.host)"
DASHBOARD_PORT="$(value dashboard.port)"

RSYNC_OPTS=(-az --compress --human-readable --delete)

ssh "$SSH_HOST" "mkdir -p '$DEPLOY_PATH' '$REMOTE_REPO_DIR' '$AGENTS_ROOT' '$DASHBOARD_DIR'"

ssh "$SSH_HOST" "sudo -n systemctl stop '${DASHBOARD_SERVICE_NAME}.service' >/dev/null 2>&1 || true"

MANIFEST_JSON="$MANIFEST_JSON" python3 - <<'PY' | while read -r service_name; do
import json
import os
for agent in json.loads(os.environ["MANIFEST_JSON"]).get("agents", []):
    print(agent["serviceName"])
PY
  ssh "$SSH_HOST" "sudo -n systemctl stop '${service_name}.timer' '${service_name}.service' >/dev/null 2>&1 || true"
done

rsync "${RSYNC_OPTS[@]}" \
  --exclude ".env" \
  --exclude ".data/" \
  --exclude ".runtime/" \
  --exclude ".bridge/" \
  --exclude "node_modules/" \
  --exclude "dist/" \
  --exclude "*.log" \
  -e "ssh" \
  "$SCRIPT_DIR/" \
  "$SSH_HOST:$REMOTE_REPO_DIR/"

MANIFEST_JSON="$MANIFEST_JSON" MANIFEST_DIR="$(dirname "$MANIFEST_PATH")" python3 - <<'PY' | while IFS=$'\t' read -r agent_id metadata_json env_file; do
import json
import os
from pathlib import Path

data = json.loads(os.environ["MANIFEST_JSON"])
manifest_dir = Path(os.environ["MANIFEST_DIR"]).resolve()
for agent in data.get("agents", []):
    env_file = Path(agent["envFile"])
    if not env_file.is_absolute():
        env_file = manifest_dir / env_file
    metadata = {
        "agentId": agent["agentId"],
        "displayName": agent.get("displayName", agent["agentId"]),
        "description": agent.get("description"),
        "serviceName": agent["serviceName"],
        "walletAddress": agent.get("walletAddress")
    }
    print(f"{agent['agentId']}\t{json.dumps(metadata)}\t{env_file}")
PY
  if [[ ! -f "$env_file" ]]; then
    echo "Missing env file for $agent_id: $env_file" >&2
    exit 1
  fi
  remote_agent_dir="$AGENTS_ROOT/$agent_id"
  ssh "$SSH_HOST" "mkdir -p '$remote_agent_dir/.runtime'"
  printf '%s\n' "$metadata_json" | ssh "$SSH_HOST" "cat > '$remote_agent_dir/agent.json'"
  rsync -az -e "ssh" "$env_file" "$SSH_HOST:$remote_agent_dir/.env"
done

ssh "$SSH_HOST" "touch '$DASHBOARD_DIR/.env'"

ssh "$SSH_HOST" \
  "DEPLOY_PATH='$DEPLOY_PATH' REMOTE_REPO_DIR='$REMOTE_REPO_DIR' AGENTS_ROOT='$AGENTS_ROOT' DASHBOARD_DIR='$DASHBOARD_DIR' DASHBOARD_SERVICE_NAME='$DASHBOARD_SERVICE_NAME' DASHBOARD_HOST='$DASHBOARD_HOST' DASHBOARD_PORT='$DASHBOARD_PORT' MANIFEST_JSON='$MANIFEST_JSON' bash -se" <<'EOF'
set -euo pipefail

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

install_template() {
  local template_path="$1"
  local output_path="$2"
  shift 2
  local sed_args=()
  while (($#)); do
    sed_args+=("-e" "s|$1|$(escape_sed_replacement "$2")|g")
    shift 2
  done
  sed "${sed_args[@]}" "$template_path" | sudo -n tee "$output_path" >/dev/null
}

cd "$REMOTE_REPO_DIR"
npm install --no-fund --no-audit
npm run build

remote_user="$USER"

python3 - <<'PY' | while IFS=$'\t' read -r agent_id service_name; do
import json
import os
for agent in json.loads(os.environ["MANIFEST_JSON"]).get("agents", []):
    print(f"{agent['agentId']}\t{agent['serviceName']}")
PY
  agent_dir="$AGENTS_ROOT/$agent_id"
  install_template \
    "$REMOTE_REPO_DIR/moltbook-outreach-agent/deploy/systemd/moltbook-outreach-heartbeat.service" \
    "/tmp/${service_name}.service" \
    "__REMOTE_USER__" "$remote_user" \
    "__PACKAGE_DIR__" "$REMOTE_REPO_DIR/moltbook-outreach-agent" \
    "__RUNTIME_DIR__" "$agent_dir/.runtime" \
    "__ENV_FILE__" "$agent_dir/.env" \
    "__LOCK_FILE__" "$agent_dir/.runtime/heartbeat.lock" \
    "__SERVICE_NAME__" "$service_name" \
    "__AGENT_ID__" "$agent_id"
  sudo -n mv "/tmp/${service_name}.service" "/etc/systemd/system/${service_name}.service"

  install_template \
    "$REMOTE_REPO_DIR/moltbook-outreach-agent/deploy/systemd/moltbook-outreach-heartbeat.timer" \
    "/tmp/${service_name}.timer" \
    "__SERVICE_NAME__" "$service_name"
  sudo -n mv "/tmp/${service_name}.timer" "/etc/systemd/system/${service_name}.timer"
done

install_template \
  "$REMOTE_REPO_DIR/deploy/systemd/moltbook-analytics-dashboard.service" \
  "/tmp/${DASHBOARD_SERVICE_NAME}.service" \
  "__REMOTE_USER__" "$remote_user" \
  "__REPO_DIR__" "$REMOTE_REPO_DIR" \
  "__AGENTS_ROOT__" "$AGENTS_ROOT" \
  "__DASHBOARD_HOST__" "$DASHBOARD_HOST" \
  "__DASHBOARD_PORT__" "$DASHBOARD_PORT" \
  "__DASHBOARD_ENV_FILE__" "$DASHBOARD_DIR/.env"
sudo -n mv "/tmp/${DASHBOARD_SERVICE_NAME}.service" "/etc/systemd/system/${DASHBOARD_SERVICE_NAME}.service"

sudo -n systemctl daemon-reload

python3 - <<'PY' | while read -r service_name; do
import json
import os
for agent in json.loads(os.environ["MANIFEST_JSON"]).get("agents", []):
    print(agent["serviceName"])
PY
  sudo -n systemctl enable --now "${service_name}.timer"
  sudo -n systemctl restart "${service_name}.timer"
done

sudo -n systemctl enable --now "${DASHBOARD_SERVICE_NAME}.service"
sudo -n systemctl restart "${DASHBOARD_SERVICE_NAME}.service"
EOF

echo
echo "Moltbook analytics stack deployed."
echo "Remote path: $DEPLOY_PATH"
echo "Dashboard: http://$DASHBOARD_HOST:$DASHBOARD_PORT"
