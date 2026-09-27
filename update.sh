#!/usr/bin/env bash
# Bleyjur self-updater. Run by bleyjur-update.service (as root) every 5 minutes.
# See DEPLOY.md. Prints nothing when there is nothing to do.
# The whole script is one { ... } block so bash parses it completely before
# running: git merge/reset below may replace this very file.
{
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/bleyjur}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
APP_SERVICE="${APP_SERVICE:-bleyjur.service}"
DATA_DIR="${DATA_DIR:-/var/lib/bleyjur}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-15}"   # seconds
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"

umask 022   # checkout is root-owned but must stay readable by the bleyjur user

log() { echo "bleyjur-update: $*"; }
err() { echo "bleyjur-update: ERROR: $*" >&2; }

cd "$APP_DIR"
GIT_DIR_ABS="$(git rev-parse --absolute-git-dir)"
FAILED_MARKER="$GIT_DIR_ABS/bleyjur-failed-rev"
LOCK_FILE="$GIT_DIR_ABS/bleyjur-update.lock"

# Never let two runs overlap (e.g. a manual run while the timer fires).
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    exit 0
fi

git fetch --quiet origin

OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse '@{u}')"

# Nothing new: exit silently so the journal stays clean.
if [ "$OLD" = "$NEW" ]; then
    exit 0
fi

# This exact revision already failed once: don't retry every 5 minutes.
if [ -f "$FAILED_MARKER" ] && [ "$(cat "$FAILED_MARKER")" = "$NEW" ]; then
    exit 0
fi

if [ -n "$(git status --porcelain)" ]; then
    err "working tree in $APP_DIR has local changes; refusing to update. See 'git status'."
    exit 1
fi

if ! git merge --ff-only --quiet '@{u}'; then
    err "fast-forward from ${OLD:0:7} to ${NEW:0:7} failed (diverged history?); nothing changed."
    exit 1
fi

log "updating ${OLD:0:7} -> ${NEW:0:7}"

# ---------------------------------------------------------------------------
# From here on, any failure (set -e, explicit exit 1, or a signal) runs the
# EXIT trap, which rolls back according to how far we got.
#   phase=building   code/build changed, service still running old process
#   phase=restarted  service was (or may have been) restarted on the new code
#   phase=done       success, nothing to undo
# ---------------------------------------------------------------------------
phase=building
DB="$DATA_DIR/bleyjur.db"
BACKUP=""        # path of the pre-deploy DB copy, if one was made
DB_EXISTED=0
DB_OWNER=""

file_owner() { stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1"; }

health_check() {
    local i
    for ((i = 0; i < HEALTH_TIMEOUT; i++)); do
        if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

build() {
    # --include=dev: the build needs TypeScript/Vite even if NODE_ENV=production leaks in.
    npm ci --include=dev --no-audit --no-fund && npm run build
}

restore_db() {
    local stamp
    if [ -n "$BACKUP" ]; then
        log "restoring database from $BACKUP"
        rm -f "$DB-wal" "$DB-shm"
        cp "$BACKUP" "$DB" || return 1
        [ -n "$DB_OWNER" ] && chown "$DB_OWNER" "$DB"
    elif [ "$DB_EXISTED" = 0 ] && [ -f "$DB" ]; then
        # There was no database before this deploy; the new code created one.
        stamp="$(date -u +%Y%m%dT%H%M%SZ)"
        log "moving database created by the failed deploy aside to $DB.failed-$stamp"
        mv "$DB" "$DB.failed-$stamp"
        rm -f "$DB-wal" "$DB-shm"
    fi
    return 0
}

rollback() {
    set +e   # best effort from here: try every step even if one fails
    err "deploy of ${NEW:0:7} failed; rolling back to ${OLD:0:7}"
    echo "$NEW" >"$FAILED_MARKER"

    git reset --hard --quiet "$OLD" || err "git reset --hard $OLD failed"
    if ! build; then
        err "rebuilding ${OLD:0:7} failed too; the app may be broken. Manual attention needed."
    fi

    if [ "$phase" = restarted ]; then
        systemctl stop "$APP_SERVICE" || err "systemctl stop $APP_SERVICE failed"
        restore_db || err "database restore failed; backup is at ${BACKUP:-<none>}"
        systemctl start "$APP_SERVICE" || err "systemctl start $APP_SERVICE failed"
    else
        systemctl restart "$APP_SERVICE" || err "systemctl restart $APP_SERVICE failed"
    fi

    if health_check; then
        log "rolled back to ${OLD:0:7}; service is healthy. ${NEW:0:7} will not be retried (see DEPLOY.md)."
    else
        err "rolled back to ${OLD:0:7} but the service is still unhealthy. Manual attention needed."
    fi
}

on_exit() {
    local status=$?
    trap - EXIT
    if [ "$status" -ne 0 ] && { [ "$phase" = building ] || [ "$phase" = restarted ]; }; then
        rollback
        exit 1
    fi
    exit "$status"
}
trap on_exit EXIT
trap 'exit 1' INT TERM HUP

# --- Pre-restart steps -------------------------------------------------------
build

if [ -f "$DB" ]; then
    DB_EXISTED=1
    DB_OWNER="$(file_owner "$DB")"
    mkdir -p "$DATA_DIR/backups"
    chmod 700 "$DATA_DIR/backups"
    BACKUP="$DATA_DIR/backups/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)-${OLD:0:7}.db"
    sqlite3 "$DB" ".backup '$BACKUP'"
    log "database backed up to $BACKUP"
    # Keep only the newest $KEEP_BACKUPS pre-deploy copies (names sort by time).
    shopt -s nullglob
    backups=("$DATA_DIR"/backups/pre-deploy-*.db)
    shopt -u nullglob
    if [ "${#backups[@]}" -gt "$KEEP_BACKUPS" ]; then
        rm -f -- "${backups[@]:0:${#backups[@]}-KEEP_BACKUPS}"
    fi
else
    log "no database at $DB yet; skipping backup"
fi

# --- Restart and health-check -----------------------------------------------
phase=restarted
systemctl restart "$APP_SERVICE"

if ! health_check; then
    err "$APP_SERVICE did not become healthy at $HEALTH_URL within ${HEALTH_TIMEOUT}s"
    exit 1   # EXIT trap rolls back
fi

phase=done
rm -f "$FAILED_MARKER"

# === POST-DEPLOY STEPS ======================================================
# Runs only after a successful, healthy deploy. None needed yet; add them here.
# A failure here does NOT roll back (the new code is already live and healthy).
# ===========================================================================

log "deployed ${NEW:0:7} successfully"
exit 0
}
