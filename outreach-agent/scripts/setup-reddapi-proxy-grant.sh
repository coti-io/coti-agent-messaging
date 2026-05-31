#!/usr/bin/env bash
# Install a small authenticated HTTP proxy on the grant host for ReddAPI write calls.
# ReddAPI passes this URL in POST bodies; their servers must reach it on the public IP.
#
# Usage (from repo):
#   bash outreach-agent/scripts/setup-reddapi-proxy-grant.sh
#
# Prints REDDAPI_PROXY=... when done. Add that line to repo-root .env locally.

set -euo pipefail

SSH_HOST="${REDDAPI_PROXY_SSH_HOST:-grant}"
PROXY_PORT="${REDDAPI_PROXY_PORT:-3128}"
PROXY_USER="${REDDAPI_PROXY_USER:-reddapi}"

remote_script() {
  cat <<'REMOTE'
set -euo pipefail
PROXY_PORT="${1}"
PROXY_USER="${2}"
PROXY_PASS="${3}"

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq squid apache2-utils

sudo htpasswd -bc /etc/squid/passwd "${PROXY_USER}" "${PROXY_PASS}"

sudo tee /etc/squid/conf.d/reddapi.conf >/dev/null <<SQUID
auth_param basic program /usr/lib/squid/basic_ncsa_auth /etc/squid/passwd
auth_param basic realm ReddAPI
acl authenticated proxy_auth REQUIRED
acl SSL_ports port 443
acl Safe_ports port 443
acl CONNECT method CONNECT
acl reddit dstdomain .reddit.com .redd.it .redditstatic.com .redditmedia.com .redditspeed.com
acl reddapi_check dstdomain .oxylabs.io
http_access deny !Safe_ports
http_access deny CONNECT !SSL_ports
http_access allow CONNECT SSL_ports authenticated reddit
http_access allow CONNECT SSL_ports authenticated reddapi_check
http_access allow authenticated reddit
http_access deny all
http_port ${PROXY_PORT}
via off
forwarded_for delete
SQUID

sudo squid -k parse
sudo systemctl enable --now squid
sudo systemctl restart squid
REMOTE
}

if [[ -z "${REDDAPI_PROXY_PASSWORD:-}" ]]; then
  REDDAPI_PROXY_PASSWORD="$(openssl rand -hex 16)"
fi

PUBLIC_IP="$(ssh "$SSH_HOST" 'curl -sS --max-time 5 https://api.ipify.org')"
echo "Grant public IP: ${PUBLIC_IP}"

ssh "$SSH_HOST" "bash -s" -- "$PROXY_PORT" "$PROXY_USER" "$REDDAPI_PROXY_PASSWORD" <<<"$(remote_script)"

PROXY_URL="http://${PROXY_USER}:${REDDAPI_PROXY_PASSWORD}@${PUBLIC_IP}:${PROXY_PORT}"
echo ""
echo "Squid listening on ${PUBLIC_IP}:${PROXY_PORT} (reddit destinations only)."
echo "Add to repo-root .env:"
echo "REDDAPI_PROXY=${PROXY_URL}"
echo ""
echo "If writes fail with proxy errors, open inbound TCP ${PROXY_PORT} on the instance security group."
