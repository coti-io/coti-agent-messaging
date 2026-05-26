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
ANALYTICS_PATH="${STARTER_GRANT_PUBLIC_ANALYTICS_PATH:-/analytics}"
ANALYTICS_PORT="${STARTER_GRANT_PUBLIC_ANALYTICS_PORT:-8788}"
ANALYTICS_AUTH_USER="${STARTER_GRANT_PUBLIC_ANALYTICS_AUTH_USER:-}"
ANALYTICS_AUTH_PASSWORD="${STARTER_GRANT_PUBLIC_ANALYTICS_AUTH_PASSWORD:-}"
ANALYTICS_AUTH_REALM="${STARTER_GRANT_PUBLIC_ANALYTICS_AUTH_REALM:-Restricted Analytics}"
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

if [[ ! "$ANALYTICS_PATH" =~ ^/ ]]; then
  ANALYTICS_PATH="/$ANALYTICS_PATH"
fi
ANALYTICS_PATH="${ANALYTICS_PATH%/}"
if [[ -z "$ANALYTICS_PATH" ]]; then
  echo "STARTER_GRANT_PUBLIC_ANALYTICS_PATH cannot be empty." >&2
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
      STARTER_GRANT_PUBLIC_ANALYTICS_PATH)
        if [[ -n "${value:-}" && "$ANALYTICS_PATH" == "/analytics" ]]; then
          ANALYTICS_PATH="${value%/}"
          [[ "$ANALYTICS_PATH" =~ ^/ ]] || ANALYTICS_PATH="/$ANALYTICS_PATH"
        fi
        ;;
      STARTER_GRANT_PUBLIC_ANALYTICS_PORT)
        if [[ -n "${value:-}" && "$ANALYTICS_PORT" == "8788" ]]; then
          ANALYTICS_PORT="$value"
        fi
        ;;
      STARTER_GRANT_PUBLIC_ANALYTICS_AUTH_USER)
        if [[ -n "${value:-}" && -z "$ANALYTICS_AUTH_USER" ]]; then
          ANALYTICS_AUTH_USER="$value"
        fi
        ;;
      STARTER_GRANT_PUBLIC_ANALYTICS_AUTH_PASSWORD)
        if [[ -n "${value:-}" && -z "$ANALYTICS_AUTH_PASSWORD" ]]; then
          ANALYTICS_AUTH_PASSWORD="$value"
        fi
        ;;
      STARTER_GRANT_PUBLIC_ANALYTICS_AUTH_REALM)
        if [[ -n "${value:-}" && "$ANALYTICS_AUTH_REALM" == "Restricted Analytics" ]]; then
          ANALYTICS_AUTH_REALM="$value"
        fi
        ;;
    esac
  done < "$LOCAL_ENV_FILE"
fi

ssh "$SSH_HOST" \
  "PUBLIC_HOST='$PUBLIC_HOST' PUBLIC_PREFIX='$PUBLIC_PREFIX' TRACKING_PATH='$TRACKING_PATH' ANALYTICS_PATH='$ANALYTICS_PATH' ANALYTICS_PORT='$ANALYTICS_PORT' ANALYTICS_AUTH_USER='$ANALYTICS_AUTH_USER' ANALYTICS_AUTH_PASSWORD='$ANALYTICS_AUTH_PASSWORD' ANALYTICS_AUTH_REALM='$ANALYTICS_AUTH_REALM' SERVICE_PORT='$SERVICE_PORT' DEPLOY_PATH='$DEPLOY_PATH' ENABLE_TLS='$ENABLE_TLS' CERTBOT_EMAIL='$CERTBOT_EMAIL' REPO_URL='$REPO_URL' bash -se" <<'EOF'
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
  sudo -n apt-get install -y nginx certbot python3-certbot-nginx apache2-utils
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

    location = ${TRACKING_PATH}/sdk {
        return 302 ${TRACKING_PATH}/sdk/\$is_args\$args;
    }

    location = ${TRACKING_PATH}/sdk/ {
        default_type text/html;
        alias /var/www/${PUBLIC_HOST}${TRACKING_PATH}/sdk/index.html;
    }

    $(write_analytics_location)

    location / {
        return 404;
    }
}
NGINX
}

analytics_enabled() {
  [[ -n "$ANALYTICS_AUTH_USER" && -n "$ANALYTICS_AUTH_PASSWORD" ]]
}

validate_analytics_auth() {
  if [[ -z "$ANALYTICS_AUTH_USER" && -z "$ANALYTICS_AUTH_PASSWORD" ]]; then
    return
  fi
  if [[ -z "$ANALYTICS_AUTH_USER" || -z "$ANALYTICS_AUTH_PASSWORD" ]]; then
    echo "Both STARTER_GRANT_PUBLIC_ANALYTICS_AUTH_USER and STARTER_GRANT_PUBLIC_ANALYTICS_AUTH_PASSWORD are required." >&2
    exit 1
  fi
}

analytics_auth_file() {
  printf '/etc/nginx/.htpasswd-%s-analytics' "$PUBLIC_HOST"
}

write_analytics_location() {
  if ! analytics_enabled; then
    return
  fi

  cat <<NGINX
    location = ${ANALYTICS_PATH} {
        return 301 ${ANALYTICS_PATH}/;
    }

    location ${ANALYTICS_PATH}/ {
        auth_basic "${ANALYTICS_AUTH_REALM}";
        auth_basic_user_file $(analytics_auth_file);
        rewrite ^${ANALYTICS_PATH}(/.*)$ \$1 break;
        proxy_pass http://127.0.0.1:${ANALYTICS_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Prefix ${ANALYTICS_PATH};
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store" always;
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
      .quickstart {
        margin-top: 24px;
        padding: 18px;
        border: 1px solid #263152;
        border-radius: 12px;
        background: #0d1430;
      }
      .quickstart p {
        margin: 0 0 12px;
        color: #dbe7ff;
        font-weight: 600;
      }
      .quickstart pre {
        margin: 0 0 12px;
        padding: 14px;
        overflow-x: auto;
        border-radius: 10px;
        background: #060b18;
        border: 1px solid #263152;
      }
      .quickstart code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        font-size: 13px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .copy-row {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      .copy-row button {
        border: 0;
        border-radius: 10px;
        padding: 10px 14px;
        font-weight: 600;
        cursor: pointer;
        background: #69a4ff;
        color: #08101f;
      }
      .copy-row button.copied {
        background: #3dd68c;
      }
      .meta {
        margin-top: 22px;
        padding-top: 20px;
        border-top: 1px solid #263152;
        font-size: 14px;
        color: #8fa2c7;
      }
      .dev-tools {
        margin-top: 14px;
        font-size: 13px;
      }
      .dev-tools a {
        color: #9eb6e8;
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
        <div class="quickstart">
          <p>Send your first private message in one command:</p>
          <pre><code id="quickstart-cmd"></code></pre>
          <div class="copy-row">
            <button id="copy-cmd" type="button">Copy command</button>
            <span id="copy-status"></span>
          </div>
        </div>
        <div class="actions">
          <a class="button primary" id="view-sdk-link" href="${REPO_URL}">View SDK</a>
        </div>
        <div class="meta">
          Tracking ref: <code id="ref-value">none</code>
          <div id="click-status"></div>
          <div class="dev-tools">
            Ops: <a href="${PUBLIC_PREFIX}/health">Grant health</a>
          </div>
        </div>
      </section>
    </main>
    <script>
      const params = new URLSearchParams(window.location.search);
      const ref = params.get("ref");
      const clickStatus = document.getElementById("click-status");
      const defaultRecipient = "0x000000000000000000000000000000000000c0a1";
      const baseCommand =
        "npx -p @coti-io/coti-sdk-private-messaging coti-private-messaging-send --init --to " +
        defaultRecipient +
        ' --text "hello from coti"';
      const quickstartCommand = ref ? baseCommand + " --ref " + ref : baseCommand;
      document.getElementById("quickstart-cmd").textContent = quickstartCommand;

      const viewSdkLink = document.getElementById("view-sdk-link");
      if (ref) {
        viewSdkLink.href = "${TRACKING_PATH}/sdk?ref=" + encodeURIComponent(ref);
      }

      const copyButton = document.getElementById("copy-cmd");
      const copyStatus = document.getElementById("copy-status");
      copyButton.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(quickstartCommand);
          copyButton.classList.add("copied");
          copyButton.textContent = "Copied";
          copyStatus.textContent = "Run this in your terminal.";
        } catch {
          copyStatus.textContent = "Copy failed. Select the command manually.";
        }
      });

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

write_sdk_redirect_page() {
  local target_dir="/var/www/${PUBLIC_HOST}${TRACKING_PATH}/sdk"
  sudo -n mkdir -p "$target_dir"
  sudo -n tee "$target_dir/index.html" >/dev/null <<HTML
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=${REPO_URL}" />
    <title>Redirecting to COTI SDK</title>
  </head>
  <body>
    <p>Redirecting to the SDK repository...</p>
    <script>
      const params = new URLSearchParams(window.location.search);
      const ref = params.get("ref");
      if (ref) {
        fetch("${PUBLIC_PREFIX}/attribution/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          body: JSON.stringify({
            ref,
            type: "click",
            venue: "sdk_view",
            metadata: { path: window.location.pathname }
          })
        }).finally(() => {
          window.location.replace("${REPO_URL}");
        });
      } else {
        window.location.replace("${REPO_URL}");
      }
    </script>
  </body>
</html>
HTML
}

write_analytics_auth_file() {
  if ! analytics_enabled; then
    return
  fi

  local auth_file
  auth_file="$(analytics_auth_file)"
  sudo -n htpasswd -bc "$auth_file" "$ANALYTICS_AUTH_USER" "$ANALYTICS_AUTH_PASSWORD" >/dev/null
  sudo -n chown root:www-data "$auth_file"
  sudo -n chmod 640 "$auth_file"
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
validate_analytics_auth
install_packages
upsert_env_var "$DEPLOY_PATH/.env" "STARTER_GRANT_SERVICE_TRUST_PROXY" "true"
upsert_env_var "$DEPLOY_PATH/.env" "STARTER_GRANT_SERVICE_BIND_HOST" "127.0.0.1"
write_tracking_page
write_sdk_redirect_page
write_analytics_auth_file
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
  if analytics_enabled; then
    echo "Analytics URL: https://${PUBLIC_HOST}${ANALYTICS_PATH}"
  else
    echo "Analytics URL: not configured (set STARTER_GRANT_PUBLIC_ANALYTICS_AUTH_USER/PASSWORD)"
  fi
else
  echo "Health URL: http://${PUBLIC_HOST}${PUBLIC_PREFIX}/health"
  echo "Grant base URL: http://${PUBLIC_HOST}${PUBLIC_PREFIX}"
  echo "Tracking base URL: http://${PUBLIC_HOST}${TRACKING_PATH}"
  if analytics_enabled; then
    echo "Analytics URL: http://${PUBLIC_HOST}${ANALYTICS_PATH}"
  else
    echo "Analytics URL: not configured (set STARTER_GRANT_PUBLIC_ANALYTICS_AUTH_USER/PASSWORD)"
  fi
fi
EOF
