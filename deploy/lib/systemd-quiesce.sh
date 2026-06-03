#!/usr/bin/env bash
# Shared helpers: mask outreach timers and stop oneshot services before rsync/build.

outreach_timer_units_from_manifest() {
  MANIFEST_JSON="$MANIFEST_JSON" python3 - <<'PY'
import json
import os

for agent in json.loads(os.environ["MANIFEST_JSON"]).get("agents", []):
    print(agent["serviceName"])
    print(agent["executorServiceName"])
PY
}

# Args: ssh_host unit_base_name ...
remote_quiesce_outreach_units() {
  local ssh_host="$1"
  shift
  if (($# == 0)); then
    return 0
  fi

  local units_env=""
  local unit
  for unit in "$@"; do
    units_env+="${unit} "
  done

  echo "Quiescing outreach systemd units on ${ssh_host}..."
  ssh "$ssh_host" "sudo -n env OUTREACH_SYSTEMD_UNITS=$(printf '%q' "$units_env") bash -se" <<'EOF'
set -euo pipefail
read -r -a units <<< "${OUTREACH_SYSTEMD_UNITS}"

for unit in "${units[@]}"; do
  sudo -n systemctl stop "${unit}.timer" >/dev/null 2>&1 || true
  sudo -n systemctl mask "${unit}.timer" >/dev/null 2>&1 || true
  sudo -n systemctl stop --now "${unit}.service" >/dev/null 2>&1 || true
done

for unit in "${units[@]}"; do
  for _ in $(seq 1 60); do
    state="$(systemctl is-active "${unit}.service" 2>/dev/null || echo inactive)"
    case "$state" in
      active|activating|deactivating) sleep 1 ;;
      *) break ;;
    esac
  done
  if systemctl is-active --quiet "${unit}.service" 2>/dev/null; then
    echo "Timed out waiting for ${unit}.service to stop (state=${state})." >&2
    exit 1
  fi
done
EOF
}

# Args: ssh_host unit_base_name ...
remote_resume_outreach_timers() {
  local ssh_host="$1"
  shift
  if (($# == 0)); then
    return 0
  fi

  local units_env=""
  local unit
  for unit in "$@"; do
    units_env+="${unit} "
  done

  echo "Resuming outreach systemd timers on ${ssh_host}..."
  ssh "$ssh_host" "sudo -n env OUTREACH_SYSTEMD_UNITS=$(printf '%q' "$units_env") bash -se" <<'EOF'
set -euo pipefail
read -r -a units <<< "${OUTREACH_SYSTEMD_UNITS}"

for unit in "${units[@]}"; do
  sudo -n systemctl unmask "${unit}.timer" >/dev/null 2>&1 || true
  sudo -n systemctl enable --now "${unit}.timer"
  sudo -n systemctl restart "${unit}.timer"
done
EOF
}
