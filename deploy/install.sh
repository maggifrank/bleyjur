#!/usr/bin/env bash
# One-shot, idempotent installer for Bleyjur on a fresh Debian/Ubuntu LXC.
# Run as root:   bash install.sh          (or: APP_PIN=1234 bash install.sh)
# Safe to re-run: it only creates what is missing and never overwrites the env file.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/maggifrank/bleyjur.git}"
APP_DIR="${APP_DIR:-/opt/bleyjur}"
ENV_DIR=/etc/bleyjur
ENV_FILE="$ENV_DIR/bleyjur.env"
NODE_MAJOR_MIN=22

log() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
command -v apt-get >/dev/null || die "this installer expects Debian/Ubuntu (apt-get)"
umask 022

# --- Packages ---------------------------------------------------------------
log "installing prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates sqlite3 build-essential python3 >/dev/null

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null || [ "$(node_major)" -lt "$NODE_MAJOR_MIN" ]; then
    log "installing Node.js ${NODE_MAJOR_MIN}.x from NodeSource"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
fi
[ -x /usr/bin/node ] || die "expected node at /usr/bin/node (bleyjur.service uses that path)"
log "node $(node --version), npm $(npm --version)"

# --- User -------------------------------------------------------------------
if ! id bleyjur >/dev/null 2>&1; then
    log "creating system user bleyjur"
    useradd --system --home-dir /var/lib/bleyjur --no-create-home --shell /usr/sbin/nologin bleyjur
fi

# --- Checkout (owned by root, readable by bleyjur) --------------------------
if [ ! -d "$APP_DIR/.git" ]; then
    log "cloning $REPO_URL to $APP_DIR"
    git clone "$REPO_URL" "$APP_DIR"
else
    log "$APP_DIR already exists; leaving the checkout as is"
fi
cd "$APP_DIR"

# --- Env file -----------------------------------------------------------------
mkdir -p "$ENV_DIR"
chmod 755 "$ENV_DIR"
if [ ! -f "$ENV_FILE" ]; then
    log "creating $ENV_FILE"
    pin="${APP_PIN:-}"
    if [ -z "$pin" ] && [ -t 0 ]; then
        while [ -z "$pin" ]; do
            read -rsp "Choose the shared PIN for the app: " pin; echo
        done
    fi
    if [ -z "$pin" ]; then
        pin="$(printf '%06d' "$(( $(od -An -N4 -tu4 /dev/urandom | tr -d ' ') % 1000000 ))")"
        echo "No PIN given (non-interactive): generated APP_PIN=$pin. Change it in $ENV_FILE."
    fi
    install -m 600 -o root -g root .env.example "$ENV_FILE"
    # Escape characters special to sed's replacement.
    pin_escaped="$(printf '%s' "$pin" | sed 's/[&|\\]/\\&/g')"
    sed -i "s|^APP_PIN=.*|APP_PIN=$pin_escaped|" "$ENV_FILE"
else
    log "$ENV_FILE exists; not touching it"
    chmod 600 "$ENV_FILE"
fi
if grep -q '^APP_PIN=change-me$' "$ENV_FILE"; then
    die "APP_PIN in $ENV_FILE is still 'change-me'; set a real PIN and re-run"
fi

# --- Build ------------------------------------------------------------------
log "building (npm ci && npm run build)"
npm ci --include=dev --no-audit --no-fund
npm run build
chmod +x update.sh

# --- systemd ----------------------------------------------------------------
log "installing systemd units"
install -m 644 deploy/bleyjur.service deploy/bleyjur-update.service deploy/bleyjur-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bleyjur.service
systemctl restart bleyjur.service   # pick up a fresh build on re-runs
systemctl enable --now bleyjur-update.timer

# --- Health check -----------------------------------------------------------
port="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n1)"
port="${port:-3000}"
for _ in $(seq 1 15); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
        log "bleyjur is up on port $port. Open http://<tailscale-name-or-lan-ip>:$port on your phone."
        exit 0
    fi
    sleep 1
done
die "service did not become healthy; check: journalctl -u bleyjur -n 50"
