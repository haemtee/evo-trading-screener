#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-evo-trading-screener}"
RUN_USER="${RUN_USER:-ubuntu}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"

# Locate Bun binary
if [[ -z "${BUN_BIN:-}" ]]; then
  if [[ -x "/home/${RUN_USER}/.bun/bin/bun" ]]; then
    BUN_BIN="/home/${RUN_USER}/.bun/bin/bun"
  elif command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
  else
    echo "Error: bun not found. Install it first: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
  fi
fi

if [[ ! -f "${APP_DIR}/.env" ]]; then
  echo "Error: ${APP_DIR}/.env not found." >&2
  echo "Run: cp ${APP_DIR}/.env.example ${APP_DIR}/.env  and fill in your tokens/keys first." >&2
  exit 1
fi

if [[ ! -d "${APP_DIR}/node_modules" ]]; then
  echo "Installing dependencies with ${BUN_BIN}..."
  (cd "${APP_DIR}" && "${BUN_BIN}" install)
fi

mkdir -p "${APP_DIR}/data"
if id "${RUN_USER}" >/dev/null 2>&1; then
  sudo chown -R "${RUN_USER}:${RUN_USER}" "${APP_DIR}/data"
fi

UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
echo "Writing systemd service to ${UNIT_FILE}..."

sudo tee "${UNIT_FILE}" >/dev/null <<EOF
[Unit]
Description=Evo Trading Screener Telegram Bot (Binance Futures Demo)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=${BUN_BIN} src/index.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}"
sudo systemctl status "${SERVICE_NAME}" --no-pager

echo ""
echo "Service '${SERVICE_NAME}' is installed and running."
echo "Useful commands:"
echo "  sudo systemctl status ${SERVICE_NAME}"
echo "  sudo systemctl restart ${SERVICE_NAME}"
echo "  sudo systemctl stop ${SERVICE_NAME}"
echo "  sudo journalctl -u ${SERVICE_NAME} -f"
