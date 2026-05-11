#!/usr/bin/env bash
set -euo pipefail

SSH_HOST="${MOLTBOOK_OUTREACH_SSH_HOST:-grant}"
SERVICE_NAME="${MOLTBOOK_OUTREACH_SERVICE_NAME:-moltbook-outreach-heartbeat}"
LINES="${MOLTBOOK_OUTREACH_LOG_LINES:-100}"
DEPLOY_PATH="${MOLTBOOK_OUTREACH_DEPLOY_PATH:-/home/ubuntu/outreach-agent}"
REMOTE_PACKAGE_DIR="$DEPLOY_PATH/outreach-agent"
RUNTIME_DIR="$DEPLOY_PATH/.runtime"

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
  inspect     Show status, runtime counters/caps, next run, and recent service logs
  status      Show status, runtime counters/caps, and scheduled runs
  logs        Show the last \$MOLTBOOK_OUTREACH_LOG_LINES service log lines
  follow      Follow the service logs live
  timer-logs  Show the last \$MOLTBOOK_OUTREACH_LOG_LINES timer log lines
  run-now     Trigger one heartbeat run immediately

Overrides:
  MOLTBOOK_OUTREACH_SSH_HOST
  MOLTBOOK_OUTREACH_SERVICE_NAME
  MOLTBOOK_OUTREACH_LOG_LINES
  MOLTBOOK_OUTREACH_DEPLOY_PATH
EOF
}

print_runtime_snapshot() {
  run_remote "REMOTE_PACKAGE_DIR='$REMOTE_PACKAGE_DIR' RUNTIME_DIR='$RUNTIME_DIR' python3 - <<'PY'
import json
import os
from pathlib import Path

runtime_dir = Path(os.environ['RUNTIME_DIR'])
package_dir = Path(os.environ['REMOTE_PACKAGE_DIR'])
state_path = runtime_dir / 'state.json'
report_path = runtime_dir / 'last-heartbeat.json'
env_path = package_dir / '.env'

def load_json(path: Path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    except Exception as exc:
        return {'__error__': str(exc)}

def load_env(path: Path):
    values = {}
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            values[key] = value
    except FileNotFoundError:
        pass
    return values

state = load_json(state_path)
report = load_json(report_path)
env = load_env(env_path)

def show(label: str, value):
    print(f'{label}: {value}')

def count_prefix(items, prefix: str):
    return sum(1 for item in items if isinstance(item, str) and item.startswith(prefix))

def count_exact(items, value: str):
    return sum(1 for item in items if item == value)

def format_usage(used, limit):
    if used is None:
        return 'unknown'
    if limit in (None, '', '(unset)'):
        return f'{used}/unset'
    return f'{used}/{limit}'

print('=== Runtime Snapshot ===')
show('runtime_dir', runtime_dir)
show('state_file_present', state_path.exists())
show('report_file_present', report_path.exists())
show('env_file_present', env_path.exists())
show('last_heartbeat_at', state.get('lastHeartbeatAt'))
show('last_post_at', state.get('lastPostAt'))
show('last_comment_at', state.get('lastCommentAt'))
show('daily_post_date', state.get('dailyPostDate'))
show('daily_post_count', state.get('dailyPostCount'))
show('daily_comment_date', state.get('dailyCommentDate'))
show('daily_comment_count', state.get('dailyCommentCount'))
show('daily_top_level_comment_count', state.get('dailyTopLevelCommentCount'))
show('daily_reply_count', state.get('dailyReplyCount'))
show('pending_writes', len(state.get('pendingWrites', [])))

print('=== Configured Caps ===')
comment_limit_new = env.get('MOLTBOOK_COMMENT_LIMIT_NEW_AGENT_PER_DAY', '20')
comment_limit_established = env.get('MOLTBOOK_COMMENT_LIMIT_ESTABLISHED_PER_DAY', '50')
post_limit_new = env.get('MOLTBOOK_POST_LIMIT_NEW_AGENT_PER_DAY', '(unset)')
post_limit_established = env.get('MOLTBOOK_POST_LIMIT_ESTABLISHED_PER_DAY', '(unset)')

show('comment_limit_new_agent_per_day', comment_limit_new)
show('comment_limit_established_per_day', comment_limit_established)
show('post_limit_new_agent_per_day', post_limit_new)
show('post_limit_established_per_day', post_limit_established)
show('comment_usage_new_agent', format_usage(state.get('dailyCommentCount'), comment_limit_new))
top_level_comment_count = state.get('dailyTopLevelCommentCount', 0)
reply_count = state.get('dailyReplyCount', 0)
show(
    'comment_usage_established_agent',
    format_usage(state.get('dailyCommentCount'), comment_limit_established)
)
show(
    'comment_breakdown_today',
    f'comments={top_level_comment_count}, replies={reply_count}'
)
show('post_usage_new_agent', format_usage(state.get('dailyPostCount'), post_limit_new))
show(
    'post_usage_established_agent',
    format_usage(state.get('dailyPostCount'), post_limit_established)
)

print('=== Last Heartbeat Report ===')
show('status', report.get('status'))
show('started_at', report.get('startedAt'))
show('finished_at', report.get('finishedAt'))
show('summary', report.get('summary'))
planned_actions = report.get('plannedActions', [])
performed = report.get('performed', [])
skipped = report.get('skipped', [])

show('planned_actions', planned_actions)
show('planned_reply_to_activity', count_exact(planned_actions, 'reply_to_activity'))
show('planned_comment_on_post', count_exact(planned_actions, 'comment_on_post'))
show('planned_create_post', count_exact(planned_actions, 'create_post'))
show('planned_upvote_post', count_exact(planned_actions, 'upvote_post'))
show('planned_follow_agent', count_exact(planned_actions, 'follow_agent'))
show('planned_inspect_dms', count_exact(planned_actions, 'inspect_dms'))

show('performed_count', len(performed))
show('performed_upvotes', count_prefix(performed, 'Upvoted '))
show('performed_follows', count_prefix(performed, 'Followed '))
show('performed_posts', count_prefix(performed, 'Posted '))
show('performed_comments', count_prefix(performed, 'Commented on '))
show('performed_replies', count_prefix(performed, 'Replied to '))
show('performed_raw', performed)

show('skipped_count', len(skipped))
show('skipped_comment_daily_cap', count_prefix(skipped, 'daily comment cap reached'))
show('skipped_comment_pacing', count_prefix(skipped, 'comment pacing blocked'))
show('skipped_post_daily_cap', count_prefix(skipped, 'daily post cap reached'))
show('skipped_post_cooldown', count_prefix(skipped, 'post cooldown blocked'))
show('skipped_dm_not_automated', count_prefix(skipped, 'DM inspection is not automated yet'))
show('skipped_raw', skipped)
errors = report.get('errors', [])
show('error_count', len(errors))
if errors:
    show('last_error', errors[-1])
PY"
}

case "$ACTION" in
  inspect)
    run_remote "sudo systemctl status '$TIMER_UNIT' --no-pager; echo; sudo systemctl status '$SERVICE_UNIT' --no-pager || true; echo; sudo systemctl list-timers '$TIMER_UNIT' --all"
    echo
    print_runtime_snapshot
    echo
    run_remote "sudo journalctl -u '$SERVICE_UNIT' -n '$LINES' --no-pager"
    ;;
  status)
    run_remote "sudo systemctl status '$TIMER_UNIT' --no-pager; echo; sudo systemctl status '$SERVICE_UNIT' --no-pager || true; echo; sudo systemctl list-timers '$TIMER_UNIT' --all"
    echo
    print_runtime_snapshot
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
