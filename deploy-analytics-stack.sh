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
data["dashboard"].setdefault("host", "0.0.0.0")
data["dashboard"].setdefault("port", 8788)
data["dashboard"].setdefault("serviceName", "moltbook-analytics-dashboard")
data["dashboard"].setdefault("envFile", "../.env")

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
REMOTE_INSTALL_STAMP_PATH="$DEPLOY_PATH/.runtime-deps-stamp"
DASHBOARD_ENV_FILE="$(value dashboard.envFile)"

RSYNC_OPTS=(-az --compress --human-readable --delete)

echo "Building local deploy artifacts..."
npm run build -w @coti-agent-messaging/moltbook-outreach-agent
npm run build -w @coti-agent-messaging/analytics-dashboard

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
  --exclude "*.log" \
  -e "ssh" \
  "$SCRIPT_DIR/" \
  "$SSH_HOST:$REMOTE_REPO_DIR/"

MANIFEST_JSON="$MANIFEST_JSON" MANIFEST_DIR="$(dirname "$MANIFEST_PATH")" python3 - <<'PY' | while IFS=$'\t' read -r agent_id metadata_json env_file remote_runtime_dir remote_env_file; do
import json
import os
from pathlib import Path

data = json.loads(os.environ["MANIFEST_JSON"])
manifest_dir = Path(os.environ["MANIFEST_DIR"]).resolve()
deploy_path = data["deployPath"]
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
    runtime_dir = agent.get("runtimeDir", f"{deploy_path}/agents/{agent['agentId']}/.runtime")
    remote_env_file = agent.get("remoteEnvFile", f"{deploy_path}/agents/{agent['agentId']}/.env")
    print(
        f"{agent['agentId']}\t{json.dumps(metadata)}\t{env_file}\t{runtime_dir}\t{remote_env_file}"
    )
PY
  if [[ ! -f "$env_file" ]]; then
    echo "Missing env file for $agent_id: $env_file" >&2
    exit 1
  fi
  remote_agent_dir="$AGENTS_ROOT/$agent_id"
  remote_agent_runtime_link="$remote_agent_dir/.runtime"
  remote_env_dir="$(dirname "$remote_env_file")"
  ssh "$SSH_HOST" "mkdir -p '$remote_agent_dir' '$remote_runtime_dir' '$remote_env_dir'"
  printf '%s\n' "$metadata_json" | ssh "$SSH_HOST" "cat > '$remote_agent_dir/agent.json'"
  rsync -az -e "ssh" "$env_file" "$SSH_HOST:$remote_env_file"
  if [[ "$remote_runtime_dir" != "$remote_agent_runtime_link" ]]; then
    ssh "$SSH_HOST" "if [ -e '$remote_agent_runtime_link' ] && [ ! -L '$remote_agent_runtime_link' ]; then echo 'Refusing to replace existing non-symlink path: $remote_agent_runtime_link' >&2; exit 1; fi; ln -sfn '$remote_runtime_dir' '$remote_agent_runtime_link'"
  fi
done

DASHBOARD_ENV_SOURCE="$DASHBOARD_ENV_FILE" MANIFEST_DIR="$(dirname "$MANIFEST_PATH")" python3 - <<'PY' > /tmp/moltbook-dashboard.env
import os
from pathlib import Path

manifest_dir = Path(os.environ["MANIFEST_DIR"]).resolve()
env_file = Path(os.environ["DASHBOARD_ENV_SOURCE"])
if not env_file.is_absolute():
    env_file = manifest_dir / env_file

allowed_keys = {
    "CONTRACT_ADDRESS",
    "CONTRACT_DEPLOY_BLOCK",
    "COTI_NETWORK",
    "COTI_RPC_URL",
    "COTI_TESTNET_RPC_URL",
    "COTI_MAINNET_RPC_URL",
    "COTI_BLOCKSCOUT_API_URL",
    "MOLTBOOK_ANALYTICS_COTI_CACHE_TTL_MS",
}

if not env_file.exists():
    raise SystemExit(f"Missing dashboard env file: {env_file}")

for raw_line in env_file.read_text().splitlines():
    stripped = raw_line.strip()
    if not stripped or stripped.startswith("#") or "=" not in raw_line:
        continue
    key, value = raw_line.split("=", 1)
    key = key.strip()
    if key in allowed_keys:
        print(f"{key}={value}")
PY
rsync -az -e "ssh" /tmp/moltbook-dashboard.env "$SSH_HOST:$DASHBOARD_DIR/.env"
rm -f /tmp/moltbook-dashboard.env

ssh "$SSH_HOST" \
  "DEPLOY_PATH='$DEPLOY_PATH' REMOTE_REPO_DIR='$REMOTE_REPO_DIR' AGENTS_ROOT='$AGENTS_ROOT' DASHBOARD_DIR='$DASHBOARD_DIR' DASHBOARD_SERVICE_NAME='$DASHBOARD_SERVICE_NAME' DASHBOARD_HOST='$DASHBOARD_HOST' DASHBOARD_PORT='$DASHBOARD_PORT' REMOTE_INSTALL_STAMP_PATH='$REMOTE_INSTALL_STAMP_PATH' MANIFEST_JSON='$MANIFEST_JSON' bash -se" <<'EOF'
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

dependency_stamp() {
  python3 - <<'PY'
import hashlib
from pathlib import Path

paths = [
    Path("package-lock.json"),
    Path("package.json"),
    Path("analytics-dashboard/package.json"),
    Path("moltbook-outreach-agent/package.json"),
]

digest = hashlib.sha256()
for path in paths:
    digest.update(path.name.encode("utf-8"))
    digest.update(b"\0")
    digest.update(path.read_bytes())
    digest.update(b"\0")

print(digest.hexdigest())
PY
}

cd "$REMOTE_REPO_DIR"

current_stamp="$(dependency_stamp)"
previous_stamp=""
if [[ -f "$REMOTE_INSTALL_STAMP_PATH" ]]; then
  previous_stamp="$(tr -d '[:space:]' < "$REMOTE_INSTALL_STAMP_PATH")"
fi

if [[ ! -d analytics-dashboard/node_modules || ! -d moltbook-outreach-agent/node_modules || "$current_stamp" != "$previous_stamp" ]]; then
  echo "Installing focused runtime dependencies on remote host..."
  rm -rf analytics-dashboard/node_modules moltbook-outreach-agent/node_modules
  (
    cd analytics-dashboard
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_PROGRESS=false \
    npm install --workspaces=false --omit=dev --no-package-lock
  )
  (
    cd moltbook-outreach-agent
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_PROGRESS=false \
    npm install --workspaces=false --omit=dev --no-package-lock
  )
  printf '%s\n' "$current_stamp" > "$REMOTE_INSTALL_STAMP_PATH"
else
  echo "Remote dependency manifests unchanged; skipping npm install."
fi

remote_user="$USER"

python3 - <<'PY' | while IFS=$'\t' read -r agent_id service_name runtime_dir remote_env_file; do
import json
import os
deploy_path = json.loads(os.environ["MANIFEST_JSON"])["deployPath"]
for agent in json.loads(os.environ["MANIFEST_JSON"]).get("agents", []):
    runtime_dir = agent.get("runtimeDir", f"{deploy_path}/agents/{agent['agentId']}/.runtime")
    remote_env_file = agent.get("remoteEnvFile", f"{deploy_path}/agents/{agent['agentId']}/.env")
    print(f"{agent['agentId']}\t{agent['serviceName']}\t{runtime_dir}\t{remote_env_file}")
PY
  install_template \
    "$REMOTE_REPO_DIR/moltbook-outreach-agent/deploy/systemd/moltbook-outreach-heartbeat.service" \
    "/tmp/${service_name}.service" \
    "__REMOTE_USER__" "$remote_user" \
    "__PACKAGE_DIR__" "$REMOTE_REPO_DIR/moltbook-outreach-agent" \
    "__RUNTIME_DIR__" "$runtime_dir" \
    "__ENV_FILE__" "$remote_env_file" \
    "__LOCK_FILE__" "$runtime_dir/heartbeat.lock" \
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
if [[ "$DASHBOARD_HOST" == "0.0.0.0" ]]; then
  echo "Dashboard: listening on all interfaces at port $DASHBOARD_PORT"
  echo "Open: http://<server-ip>:$DASHBOARD_PORT"
else
  echo "Dashboard: http://$DASHBOARD_HOST:$DASHBOARD_PORT"
fi
