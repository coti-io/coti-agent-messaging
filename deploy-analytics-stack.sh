#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib/systemd-quiesce.sh
source "$SCRIPT_DIR/deploy/lib/systemd-quiesce.sh"
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
data["dashboard"].setdefault("envFile", "../.env")

for agent in data.get("agents", []):
    if not agent.get("agentId"):
        raise SystemExit("Every agent needs agentId")
    if not agent.get("envFile"):
        raise SystemExit(f"Agent {agent['agentId']} needs envFile")
    agent.setdefault("displayName", agent["agentId"])
    agent.setdefault("runtimeKind", "moltbook")
    agent.setdefault("serviceName", f"moltbook-outreach-{agent['agentId']}")
    agent.setdefault("executorServiceName", f"{agent['serviceName']}-executor")

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
LOCAL_REDDIT_STORAGE_STATE="${MOLTBOOK_ANALYTICS_DEPLOY_REDDIT_STORAGE_STATE:-$SCRIPT_DIR/outreach-agent/.browser/reddit-storage-state.json}"
REMOTE_REDDIT_STORAGE_STATE="$REMOTE_REPO_DIR/outreach-agent/.browser/reddit-storage-state.json"

RSYNC_OPTS=(-az --compress --human-readable --delete)

echo "Building local deploy artifacts..."
npm run build -w @coti-agent-messaging/outreach-agent
npm run build -w @coti-agent-messaging/analytics-dashboard

ssh "$SSH_HOST" "mkdir -p '$DEPLOY_PATH' '$REMOTE_REPO_DIR' '$AGENTS_ROOT' '$DASHBOARD_DIR'"

ssh "$SSH_HOST" "sudo -n systemctl stop '${DASHBOARD_SERVICE_NAME}.service' >/dev/null 2>&1 || true"

OUTREACH_UNITS=()
while IFS= read -r service_name; do
  OUTREACH_UNITS+=("$service_name")
done < <(outreach_timer_units_from_manifest)

outreach_quiesced=0
deploy_cleanup_outreach_units() {
  if [[ "$outreach_quiesced" == 1 ]]; then
    remote_resume_outreach_timers "$SSH_HOST" "${OUTREACH_UNITS[@]}" || true
  fi
}
trap deploy_cleanup_outreach_units EXIT

remote_quiesce_outreach_units "$SSH_HOST" "${OUTREACH_UNITS[@]}"
outreach_quiesced=1

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

if [[ -f "$LOCAL_REDDIT_STORAGE_STATE" ]]; then
  ssh "$SSH_HOST" "mkdir -p '$(dirname "$REMOTE_REDDIT_STORAGE_STATE")'"
  rsync -az -e "ssh" "$LOCAL_REDDIT_STORAGE_STATE" "$SSH_HOST:$REMOTE_REDDIT_STORAGE_STATE"
else
  echo "Skipping Reddit storage-state sync; file not found: $LOCAL_REDDIT_STORAGE_STATE"
fi

agent_provision_plan="$(mktemp)"
cleanup_deploy_artifacts() {
  rm -f "$agent_provision_plan"
  if [[ "${outreach_quiesced:-0}" == 1 ]]; then
    remote_resume_outreach_timers "$SSH_HOST" "${OUTREACH_UNITS[@]}" || true
  fi
}
trap cleanup_deploy_artifacts EXIT
MANIFEST_JSON="$MANIFEST_JSON" MANIFEST_DIR="$(dirname "$MANIFEST_PATH")" python3 - <<'PY' >"$agent_provision_plan"
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
        "profileUrl": agent.get("profileUrl"),
        "walletAddress": agent.get("walletAddress"),
    }
    metadata = dict(
        (key, value) for key, value in metadata.items() if value is not None
    )
    runtime_dir = agent.get("runtimeDir", f"{deploy_path}/agents/{agent['agentId']}/.runtime")
    remote_env_file = agent.get("remoteEnvFile", f"{deploy_path}/agents/{agent['agentId']}/.env")
    metadata_json = json.dumps(metadata, separators=(",", ":"))
    print(
        f"{agent['agentId']}\t{metadata_json}\t{env_file}\t{runtime_dir}\t{remote_env_file}\t{agent.get('runtimeKind', 'moltbook')}",
        flush=True,
    )
PY

agent_provision_failures=0
while IFS=$'\t' read -r agent_id metadata_json env_file remote_runtime_dir remote_env_file runtime_kind; do
  [[ -n "$agent_id" ]] || continue
  if [[ ! -f "$env_file" ]]; then
    echo "Missing env file for $agent_id: $env_file" >&2
    agent_provision_failures=1
    continue
  fi
  remote_agent_dir="$AGENTS_ROOT/$agent_id"
  remote_agent_runtime_link="$remote_agent_dir/.runtime"
  remote_env_dir="$(dirname "$remote_env_file")"
  ssh "$SSH_HOST" "mkdir -p '$remote_agent_dir' '$remote_runtime_dir' '$remote_env_dir'"
  printf '%s\n' "$metadata_json" | ssh "$SSH_HOST" "cat > '$remote_agent_dir/agent.json'"
  rsync -az -e "ssh" "$env_file" "$SSH_HOST:$remote_env_file"
  if [[ "$remote_runtime_dir" != "$remote_agent_runtime_link" ]]; then
    if ! ssh "$SSH_HOST" "if [ -e '$remote_agent_runtime_link' ] && [ ! -L '$remote_agent_runtime_link' ]; then echo 'Refusing to replace existing non-symlink path: $remote_agent_runtime_link' >&2; exit 1; fi; ln -sfn '$remote_runtime_dir' '$remote_agent_runtime_link'"; then
      echo "Failed to link runtime dir for $agent_id: $remote_agent_runtime_link -> $remote_runtime_dir" >&2
      agent_provision_failures=1
    fi
  fi
done <"$agent_provision_plan"

if [[ "$agent_provision_failures" -ne 0 ]]; then
  echo "One or more agent provisioning steps failed." >&2
  exit 1
fi

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
    "OUTREACH_ATTRIBUTION_DB_PATH",
    "OUTREACH_TRACKING_BASE_URL",
    "OUTREACH_CTA_BASE_URL",
    "STARTER_GRANT_SERVICE_URL",
    "STARTER_GRANT_SERVICE_AUTH_TOKEN",
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
    Path("outreach-agent/package.json"),
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

if [[ ! -d analytics-dashboard/node_modules || ! -d outreach-agent/node_modules || "$current_stamp" != "$previous_stamp" ]]; then
  echo "Installing focused runtime dependencies on remote host..."
  rm -rf analytics-dashboard/node_modules outreach-agent/node_modules
  (
    cd analytics-dashboard
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_PROGRESS=false \
    npm install --workspaces=false --omit=dev --no-package-lock
  )
  (
    cd outreach-agent
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

python3 - <<'PY' | while IFS=$'\t' read -r agent_id service_name executor_service_name runtime_dir remote_env_file runtime_kind; do
import json
import os
deploy_path = json.loads(os.environ["MANIFEST_JSON"])["deployPath"]
for agent in json.loads(os.environ["MANIFEST_JSON"]).get("agents", []):
    runtime_dir = agent.get("runtimeDir", f"{deploy_path}/agents/{agent['agentId']}/.runtime")
    remote_env_file = agent.get("remoteEnvFile", f"{deploy_path}/agents/{agent['agentId']}/.env")
    print(f"{agent['agentId']}\t{agent['serviceName']}\t{agent['executorServiceName']}\t{runtime_dir}\t{remote_env_file}\t{agent.get('runtimeKind', 'moltbook')}")
PY
  state_path="$runtime_dir/state.json"
  heartbeat_report_path="$runtime_dir/last-heartbeat.json"
  heartbeat_description="Moltbook outreach heartbeat"
  heartbeat_command="heartbeat"
  heartbeat_run_label="heartbeat"
  executor_description="Moltbook outreach executor"
  executor_command="executor"
  executor_run_label="executor"
  venue="moltbook"
  if [[ "$runtime_kind" == "reddit" ]]; then
    heartbeat_description="Reddit outreach heartbeat"
    heartbeat_command="reddit-heartbeat --live --once --max-actions 1"
    heartbeat_run_label="reddit heartbeat"
    executor_description="Reddit outreach executor"
    executor_command="reddit-executor --live"
    executor_run_label="reddit executor"
    venue="reddit"
  fi
  install_template \
    "$REMOTE_REPO_DIR/outreach-agent/deploy/systemd/moltbook-outreach-heartbeat.service" \
    "/tmp/${service_name}.service" \
    "__DESCRIPTION__" "$heartbeat_description" \
    "__REMOTE_USER__" "$remote_user" \
    "__PACKAGE_DIR__" "$REMOTE_REPO_DIR/outreach-agent" \
    "__RUNTIME_DIR__" "$runtime_dir" \
    "__ENV_FILE__" "$remote_env_file" \
    "__LOCK_FILE__" "$runtime_dir/heartbeat.lock" \
    "__SERVICE_NAME__" "$service_name" \
    "__VENUE__" "$venue" \
    "__STATE_PATH__" "$state_path" \
    "__HEARTBEAT_REPORT_PATH__" "$heartbeat_report_path" \
    "__COMMAND__" "$heartbeat_command" \
    "__RUN_LABEL__" "$heartbeat_run_label" \
    "__AGENT_ID__" "$agent_id"
  sudo -n mv "/tmp/${service_name}.service" "/etc/systemd/system/${service_name}.service"

  install_template \
    "$REMOTE_REPO_DIR/outreach-agent/deploy/systemd/moltbook-outreach-heartbeat.timer" \
    "/tmp/${service_name}.timer" \
    "__SERVICE_NAME__" "$service_name"
  sudo -n mv "/tmp/${service_name}.timer" "/etc/systemd/system/${service_name}.timer"

  install_template \
    "$REMOTE_REPO_DIR/outreach-agent/deploy/systemd/moltbook-outreach-executor.service" \
    "/tmp/${executor_service_name}.service" \
    "__DESCRIPTION__" "$executor_description" \
    "__REMOTE_USER__" "$remote_user" \
    "__PACKAGE_DIR__" "$REMOTE_REPO_DIR/outreach-agent" \
    "__RUNTIME_DIR__" "$runtime_dir" \
    "__ENV_FILE__" "$remote_env_file" \
    "__LOCK_FILE__" "$runtime_dir/heartbeat.lock" \
    "__SERVICE_NAME__" "$executor_service_name" \
    "__VENUE__" "$venue" \
    "__STATE_PATH__" "$state_path" \
    "__HEARTBEAT_REPORT_PATH__" "$heartbeat_report_path" \
    "__COMMAND__" "$executor_command" \
    "__RUN_LABEL__" "$executor_run_label" \
    "__AGENT_ID__" "$agent_id"
  sudo -n mv "/tmp/${executor_service_name}.service" "/etc/systemd/system/${executor_service_name}.service"

  install_template \
    "$REMOTE_REPO_DIR/outreach-agent/deploy/systemd/moltbook-outreach-executor.timer" \
    "/tmp/${executor_service_name}.timer" \
    "__SERVICE_NAME__" "$executor_service_name"
  sudo -n mv "/tmp/${executor_service_name}.timer" "/etc/systemd/system/${executor_service_name}.timer"
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

sudo -n systemctl enable --now "${DASHBOARD_SERVICE_NAME}.service"
sudo -n systemctl restart "${DASHBOARD_SERVICE_NAME}.service"
EOF

remote_resume_outreach_timers "$SSH_HOST" "${OUTREACH_UNITS[@]}"
outreach_quiesced=0

echo
echo "Outreach analytics stack deployed."
echo "Remote path: $DEPLOY_PATH"
if [[ "$DASHBOARD_HOST" == "127.0.0.1" ]]; then
  echo "Dashboard: bound locally on 127.0.0.1:$DASHBOARD_PORT"
  echo "Open it through nginx or an SSH tunnel."
else
  echo "Dashboard: http://$DASHBOARD_HOST:$DASHBOARD_PORT"
fi
