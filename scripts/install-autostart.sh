#!/usr/bin/env bash
# Installs agentphone as a systemd --user service.
# After this, `npm start` runs at WSL/Linux boot and restarts on crash.
# Idempotent: safe to re-run.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="$(id -un)"
SYSTEMD_DIR="$HOME/.config/systemd/user"
CONFIG_DIR="$HOME/.config/agentphone"
TEMPLATE="$DIR/scripts/agentphone.service.template"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "ERROR: template not found at $TEMPLATE" >&2
  exit 1
fi

# require systemd
if ! command -v systemctl >/dev/null 2>&1; then
  echo "ERROR: systemctl not found. WSL needs systemd enabled (add 'systemd=true' under [boot] in /etc/wsl.conf, then 'wsl --shutdown' from Windows)." >&2
  exit 1
fi

mkdir -p "$SYSTEMD_DIR" "$CONFIG_DIR"

# Create env file with a random token if it doesn't exist yet.
if [[ ! -f "$CONFIG_DIR/env" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    TOKEN="$(openssl rand -hex 16)"
  else
    TOKEN="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  cat > "$CONFIG_DIR/env" <<EOF
PHONE_AGENT_TOKEN=$TOKEN
PORT=8765
# PHONE_AGENT_CWD=/home/$USER_NAME/somewhere   # uncomment to pin default cwd
EOF
  chmod 600 "$CONFIG_DIR/env"
  echo "✓ generated $CONFIG_DIR/env (chmod 600)"
else
  echo "→ keeping existing $CONFIG_DIR/env"
fi

# Render and install unit
sed "s|__INSTALL_DIR__|$DIR|g; s|__HOME__|$HOME|g" \
    "$TEMPLATE" > "$SYSTEMD_DIR/agentphone.service"
echo "✓ wrote $SYSTEMD_DIR/agentphone.service"

systemctl --user daemon-reload
systemctl --user enable --now agentphone.service
echo "✓ enabled + started agentphone.service"

# Enable linger so the service keeps running when no shell is open (WSL needs this).
if command -v loginctl >/dev/null 2>&1; then
  if loginctl show-user "$USER_NAME" 2>/dev/null | grep -q '^Linger=yes'; then
    echo "→ loginctl linger already enabled"
  else
    echo "→ enabling loginctl linger (will sudo)…"
    sudo loginctl enable-linger "$USER_NAME" \
      && echo "✓ linger enabled" \
      || echo "⚠ linger setup skipped; run manually: sudo loginctl enable-linger $USER_NAME"
  fi
fi

echo ""
echo "─── status ───"
systemctl --user status agentphone --no-pager 2>&1 | head -8 || true
echo ""

# Print the URL the user should bookmark on their phone
TOKEN_VAL="$(grep -E '^PHONE_AGENT_TOKEN=' "$CONFIG_DIR/env" | cut -d= -f2)"
PORT_VAL="$(grep -E '^PORT=' "$CONFIG_DIR/env" | cut -d= -f2)"
PORT_VAL="${PORT_VAL:-8765}"
TS_IP="$(ip -4 addr 2>/dev/null | awk '/inet 100\./{print $2}' | cut -d/ -f1 | head -1)"
TS_IP="${TS_IP:-<your-tailscale-ip>}"

echo "Bookmark this on your phone (Chrome → Add to Home Screen):"
echo "   http://$TS_IP:$PORT_VAL/?token=$TOKEN_VAL"
echo ""
echo "stop:    systemctl --user stop agentphone"
echo "logs:    journalctl --user -u agentphone -f"
echo "remove:  systemctl --user disable --now agentphone && rm $SYSTEMD_DIR/agentphone.service"
