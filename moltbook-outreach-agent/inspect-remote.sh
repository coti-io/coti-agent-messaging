#!/usr/bin/env bash
set -euo pipefail

SSH_HOST="${MOLTBOOK_OUTREACH_SSH_HOST:-grant}"
SERVICE_NAME="${MOLTBOOK_OUTREACH_SERVICE_NAME:-moltbook-outreach-heartbeat}"
LINES="${MOLTBOOK_OUTREACH_LOG_LINES:-100}"

SERVICE_UNIT="${SERVICE_NAME}.service"
TIMER_UNIT="${SERVICE_NAME}.timer"
ACTION="${1:-inspect}"

run_remote() {
  ssh "$SSH_HOST" "$@"
}

print_usage() {
  cat <<EOF
Usage: bash ./inspect-remote.sh [inspect|status|logs|follow|timer-logs|run-now]

Actions:
  inspect     Show timer status, service status, next run, and recent service logs
  status      Show timer status, service status, and scheduled runs
  logs        Show the last \$MOLTBOOK_OUTREACH_LOG_LINES service log lines
  follow      Follow the service logs live
  timer-logs  Show the last \$MOLTBOOK_OUTREACH_LOG_LINES timer log lines
  run-now     Trigger one heartbeat run immediately

Overrides:
  MOLTBOOK_OUTREACH_SSH_HOST
  MOLTBOOK_OUTREACH_SERVICE_NAME
  MOLTBOOK_OUTREACH_LOG_LINES
EOF
}

case "$ACTION" in
  inspect)
    run_remote "sudo systemctl status '$TIMER_UNIT' --no-pager; echo; sudo systemctl status '$SERVICE_UNIT' --no-pager || true; echo; sudo systemctl list-timers '$TIMER_UNIT' --all; echo; sudo journalctl -u '$SERVICE_UNIT' -n '$LINES' --no-pager"
    ;;
  status)
    run_remote "sudo systemctl status '$TIMER_UNIT' --no-pager; echo; sudo systemctl status '$SERVICE_UNIT' --no-pager || true; echo; sudo systemctl list-timers '$TIMER_UNIT' --all"
    ;;
  logs)
    run_remote "sudo journalctl -u '$SERVICE_UNIT' -n '$LINES' --no-pager"
    ;;
  follow)
    run_remote "sudo journalctl -u '$SERVICE_UNIT' -f"
    ;;
  timer-logs)
    run_remote "sudo journalctl -u '$TIMER_UNIT' -n '$LINES' --no-pager"
    ;;
  run-now)
    run_remote "sudo systemctl start '$SERVICE_UNIT' && sudo systemctl status '$SERVICE_UNIT' --no-pager"
    ;;
  -h|--help|help)
    print_usage
    ;;
  *)
    echo "Unknown action: $ACTION" >&2
    print_usage >&2
    exit 1
    ;;
esac
