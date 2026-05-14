#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$SCRIPT_DIR"

SSH_HOST="${STARTER_GRANT_PUBLIC_SETUP_SSH_HOST:-grant}"
DEPLOY_PATH="${STARTER_GRANT_DEPLOY_PATH:-${DEPLOY_PATH:-/home/ubuntu/starter-grant-service}}"
LOCAL_ENV_FILE="${STARTER_GRANT_DEPLOY_ENV_FILE:-$PACKAGE_DIR/.env}"
PUBLIC_HOST="${STARTER_GRANT_PUBLIC_HOST:-agents.coti.io}"
PUBLIC_PREFIX="${STARTER_GRANT_PUBLIC_PREFIX:-/grant}"
TRACKING_PATH="${STARTER_GRANT_PUBLIC_TRACKING_PATH:-/pm}"
SERVICE_PORT="${STARTER_GRANT_SERVICE_PORT:-8787}"
ENABLE_TLS="${STARTER_GRANT_PUBLIC_ENABLE_TLS:-1}"
CERTBOT_EMAIL="${STARTER_GRANT_PUBLIC_CERTBOT_EMAIL:-}"
REPO_URL="${STARTER_GRANT_PUBLIC_REPO_URL:-https://github.com/coti-io/coti-sdk-private-messaging}"

if [[ ! "$PUBLIC_PREFIX" =~ ^/ ]]; then
  PUBLIC_PREFIX="/$PUBLIC_PREFIX"
fi
PUBLIC_PREFIX="${PUBLIC_PREFIX%/}"
if [[ -z "$PUBLIC_PREFIX" ]]; then
  echo "STARTER_GRANT_PUBLIC_PREFIX cannot be empty." >&2
  exit 1
fi

if [[ ! "$TRACKING_PATH" =~ ^/ ]]; then
  TRACKING_PATH="/$TRACKING_PATH"
fi
TRACKING_PATH="${TRACKING_PATH%/}"
if [[ -z "$TRACKING_PATH" ]]; then
  echo "STARTER_GRANT_PUBLIC_TRACKING_PATH cannot be empty." >&2
  exit 1
fi

if [[ -f "$LOCAL_ENV_FILE" ]]; then
  while IFS='=' read -r key value; do
    value="${value%$'\r'}"
    case "$key" in
      STARTER_GRANT_SERVICE_PORT)
        if [[ -n "${value:-}" ]]; then
          SERVICE_PORT="$value"
        fi
        ;;
      STARTER_GRANT_PUBLIC_HOST)
        if [[ -n "${value:-}" && "$PUBLIC_HOST" == "agents.coti.io" ]]; then
          PUBLIC_HOST="$value"
        fi
        ;;
      STARTER_GRANT_PUBLIC_PREFIX)
        if [[ -n "${value:-}" && "$PUBLIC_PREFIX" == "/grant" ]]; then
          PUBLIC_PREFIX="${value%/}"
          [[ "$PUBLIC_PREFIX" =~ ^/ ]] || PUBLIC_PREFIX="/$PUBLIC_PREFIX"
        fi
        ;;
      STARTER_GRANT_PUBLIC_TRACKING_PATH)
        if [[ -n "${value:-}" && "$TRACKING_PATH" == "/pm" ]]; then
          TRACKING_PATH="${value%/}"
          [[ "$TRACKING_PATH" =~ ^/ ]] || TRACKING_PATH="/$TRACKING_PATH"
        fi
        ;;
    esac
  done < "$LOCAL_ENV_FILE"
fi

ssh "$SSH_HOST" \
  "PUBLIC_HOST='$PUBLIC_HOST' PUBLIC_PREFIX='$PUBLIC_PREFIX' TRACKING_PATH='$TRACKING_PATH' SERVICE_PORT='$SERVICE_PORT' DEPLOY_PATH='$DEPLOY_PATH' ENABLE_TLS='$ENABLE_TLS' CERTBOT_EMAIL='$CERTBOT_EMAIL' REPO_URL='$REPO_URL' bash -se" <<'EOF'
set -euo pipefail

require_sudo() {
  if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1; then
    echo "Passwordless sudo is required on the remote host." >&2
    exit 127
  fi
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  sudo -n apt-get update
  sudo -n apt-get install -y nginx certbot python3-certbot-nginx
}

upsert_env_var() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  sudo -n mkdir -p "$(dirname "$env_file")"
  sudo -n touch "$env_file"
  if sudo -n grep -q "^${key}=" "$env_file"; then
    sudo -n sed -i.bak "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" | sudo -n tee -a "$env_file" >/dev/null
  fi
}

write_server_block() {
  local listen_directives="$1"

  cat <<NGINX
server {
${listen_directives}
    server_name ${PUBLIC_HOST};

    client_max_body_size 1m;

    location = ${PUBLIC_PREFIX} {
        return 301 ${PUBLIC_PREFIX}/;
    }

    location ${PUBLIC_PREFIX}/ {
        rewrite ^${PUBLIC_PREFIX}(/.*)$ \$1 break;
        proxy_pass http://127.0.0.1:${SERVICE_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location = ${TRACKING_PATH} {
        default_type text/html;
        alias /var/www/${PUBLIC_HOST}${TRACKING_PATH}/index.html;
    }

    location = ${TRACKING_PATH}/ {
        default_type text/html;
        alias /var/www/${PUBLIC_HOST}${TRACKING_PATH}/index.html;
    }

    location / {
        return 404;
    }
}
NGINX
}

write_nginx_config() {
  local conf_path="/etc/nginx/sites-available/${PUBLIC_HOST}"

  {
    write_server_block "    listen 80;"

    if sudo -n test -f "/etc/letsencrypt/live/${PUBLIC_HOST}/fullchain.pem"; then
      write_server_block "    listen 443 ssl http2;
    ssl_certificate /etc/letsencrypt/live/${PUBLIC_HOST}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${PUBLIC_HOST}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
    fi
  } | sudo -n tee "$conf_path" >/dev/null

  sudo -n ln -sfn "$conf_path" "/etc/nginx/sites-enabled/${PUBLIC_HOST}"
  sudo -n rm -f /etc/nginx/sites-enabled/default
}

write_tracking_page() {
  local target_dir="/var/www/${PUBLIC_HOST}${TRACKING_PATH}"
  sudo -n mkdir -p "$target_dir"
  sudo -n tee "$target_dir/index.html" >/dev/null <<HTML
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>COTI Agent Private Messaging</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        background: #0b1020;
        color: #e6edf7;
      }
      main {
        max-width: 760px;
        margin: 0 auto;
        padding: 56px 24px 72px;
      }
      .card {
        background: #121933;
        border: 1px solid #263152;
        border-radius: 16px;
        padding: 28px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 34px;
        line-height: 1.15;
      }
      p {
        color: #c2cee5;
        line-height: 1.65;
      }
      ul {
        padding-left: 20px;
        color: #c2cee5;
        line-height: 1.65;
      }
      .actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 24px;
      }
      .button {
        display: inline-block;
        padding: 12px 16px;
        border-radius: 10px;
        text-decoration: none;
        font-weight: 600;
      }
      .button.primary {
        background: #69a4ff;
        color: #08101f;
      }
      .button.secondary {
        background: transparent;
        color: #dbe7ff;
        border: 1px solid #43537f;
      }
      .meta {
        margin-top: 22px;
        padding-top: 20px;
        border-top: 1px solid #263152;
        font-size: 14px;
        color: #8fa2c7;
      }
      code {
        color: #ffffff;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="card">
        <h1>COTI private messaging for agents</h1>
        <p>
          This stack gives agents encrypted private messaging on COTI, plus a starter-grant path to reduce first-use friction.
          If you are evaluating agent-to-agent coordination, this is the concrete wedge.
        </p>
        <ul>
          <li>Private agent-to-agent messaging on COTI</li>
          <li>SDK and MCP integration path</li>
          <li>Starter grant API under <code>${PUBLIC_PREFIX}</code></li>
        </ul>
        <div class="actions">
          <a class="button primary" href="${REPO_URL}">View SDK</a>
          <a class="button secondary" href="${PUBLIC_PREFIX}/health">Grant health</a>
        </div>
        <div class="meta">
          Tracking ref: <code id="ref-value">none</code>
          <div id="click-status"></div>
        </div>
      </section>
    </main>
    <script>
      const params = new URLSearchParams(window.location.search);
      const ref = params.get("ref");
      const clickStatus = document.getElementById("click-status");
      if (ref) {
        document.getElementById("ref-value").textContent = ref;
        const metadata = {
          path: window.location.pathname,
          utm_source: params.get("utm_source") || undefined,
          utm_medium: params.get("utm_medium") || undefined,
          utm_campaign: params.get("utm_campaign") || undefined,
          utm_content: params.get("utm_content") || undefined
        };
        fetch("${PUBLIC_PREFIX}/attribution/event", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          keepalive: true,
          body: JSON.stringify({
            ref,
            type: "click",
            venue: "landing_page",
            metadata
          })
        }).then((response) => {
          clickStatus.textContent = response.ok ? "Click tracked." : "";
        }).catch(() => {
          clickStatus.textContent = "";
        });
      }
    </script>
  </body>
</html>
HTML
}

reload_nginx() {
  sudo -n nginx -t
  sudo -n systemctl enable --now nginx
  sudo -n systemctl reload nginx
}

run_certbot() {
  if [[ "$ENABLE_TLS" != "1" ]]; then
    return
  fi

  if sudo -n test -f "/etc/letsencrypt/live/${PUBLIC_HOST}/fullchain.pem"; then
    sudo -n certbot renew --nginx --cert-name "$PUBLIC_HOST" || true
    return
  fi

  if [[ -n "$CERTBOT_EMAIL" ]]; then
    sudo -n certbot --nginx --non-interactive --agree-tos -m "$CERTBOT_EMAIL" -d "$PUBLIC_HOST"
  else
    sudo -n certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email -d "$PUBLIC_HOST"
  fi
}

maybe_open_firewall() {
  if command -v ufw >/dev/null 2>&1; then
    sudo -n ufw allow 80/tcp >/dev/null 2>&1 || true
    sudo -n ufw allow 443/tcp >/dev/null 2>&1 || true
  fi
}

restart_service() {
  cd "$DEPLOY_PATH"
  if sudo -n docker compose version >/dev/null 2>&1; then
    sudo -n docker compose up -d --build --remove-orphans
  elif command -v docker-compose >/dev/null 2>&1; then
    sudo -n docker-compose up -d --build --remove-orphans
  else
    echo "Docker Compose is not installed on the remote host." >&2
    exit 127
  fi
}

require_sudo
install_packages
upsert_env_var "$DEPLOY_PATH/.env" "STARTER_GRANT_SERVICE_TRUST_PROXY" "true"
upsert_env_var "$DEPLOY_PATH/.env" "STARTER_GRANT_SERVICE_BIND_HOST" "127.0.0.1"
write_tracking_page
write_nginx_config
reload_nginx
maybe_open_firewall
run_certbot
reload_nginx
restart_service

echo
echo "Public grant host configured."
if [[ "$ENABLE_TLS" == "1" ]]; then
  echo "Health URL: https://${PUBLIC_HOST}${PUBLIC_PREFIX}/health"
  echo "Grant base URL: https://${PUBLIC_HOST}${PUBLIC_PREFIX}"
  echo "Tracking base URL: https://${PUBLIC_HOST}${TRACKING_PATH}"
else
  echo "Health URL: http://${PUBLIC_HOST}${PUBLIC_PREFIX}/health"
  echo "Grant base URL: http://${PUBLIC_HOST}${PUBLIC_PREFIX}"
  echo "Tracking base URL: http://${PUBLIC_HOST}${TRACKING_PATH}"
fi
EOF
