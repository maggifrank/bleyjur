# Deploying Bleyjur

Bleyjur runs as a systemd service in a Debian/Ubuntu LXC container and updates itself from GitHub. GitHub never connects to the server; the server polls.

| What | Where |
| --- | --- |
| Checkout (owned by root) | `/opt/bleyjur` |
| Config (chmod 600) | `/etc/bleyjur/bleyjur.env` |
| SQLite database | `/var/lib/bleyjur/bleyjur.db` |
| Pre-deploy DB copies | `/var/lib/bleyjur/backups/` (last 10) |
| App unit | `bleyjur.service` (runs as user `bleyjur`) |
| Updater | `bleyjur-update.timer` → `bleyjur-update.service` → `/opt/bleyjur/update.sh` |

## Fresh install

### With the installer

As root on a fresh container:

```sh
apt-get update && apt-get install -y git
git clone https://github.com/maggifrank/bleyjur.git /opt/bleyjur
bash /opt/bleyjur/deploy/install.sh        # asks for the PIN
# non-interactive: APP_PIN=1234 bash /opt/bleyjur/deploy/install.sh
```

It installs git, curl, sqlite3, build-essential and python3 (for better-sqlite3's native build), Node.js 22 from NodeSource if needed, creates the `bleyjur` user and `/etc/bleyjur/bleyjur.env`, builds, and enables `bleyjur.service` and `bleyjur-update.timer`. You can run it again safely: it never overwrites the env file.

### By hand

```sh
apt-get install -y git curl sqlite3 build-essential python3
# Node.js 22+ at /usr/bin/node, e.g.:
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs

useradd --system --home-dir /var/lib/bleyjur --no-create-home --shell /usr/sbin/nologin bleyjur
git clone https://github.com/maggifrank/bleyjur.git /opt/bleyjur
cd /opt/bleyjur

mkdir -p /etc/bleyjur
install -m 600 .env.example /etc/bleyjur/bleyjur.env
nano /etc/bleyjur/bleyjur.env              # set APP_PIN

npm ci && npm run build

cp deploy/bleyjur.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bleyjur.service
curl http://127.0.0.1:3000/api/health      # {"ok":true}
```

Then turn on automatic deploys:

```sh
cp deploy/bleyjur-update.* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bleyjur-update.timer
```

## Access (Tailscale)

The app listens on `0.0.0.0:3000`. Open it from the phones at `http://<tailscale-name>:3000` (or the container's LAN IP). **Never expose it publicly**: no port forwarding, no Tailscale Funnel. The PIN only keeps casual visitors out.

## Automatic deploys

Two minutes after boot, and every 5 minutes after that, the timer runs `update.sh`:

1. `git fetch`. If nothing is new, it exits without printing anything.
2. If the new revision already failed once (`.git/bleyjur-failed-rev`), it skips it.
3. If someone edited files in `/opt/bleyjur` by hand, it logs an error and does nothing.
4. `git merge --ff-only`, `npm ci`, `npm run build`, then copies the database to `/var/lib/bleyjur/backups/pre-deploy-<time>-<oldrev>.db`.
5. Restarts `bleyjur.service` and polls `/api/health` for up to 15 s.

**Rollback:** if the build, the backup, the restart or the health check fails, it records the new revision in `.git/bleyjur-failed-rev`, runs `git reset --hard` back to the old revision, rebuilds, and (if the new code had already started) stops the app, restores the pre-deploy database copy, and starts the app again. The bad revision is not retried. Pushing a newer commit retries automatically.

Checking on it:

```sh
systemctl list-timers bleyjur-update.timer
journalctl -u bleyjur-update -n 50
journalctl -u bleyjur -n 50               # the app itself
```

Pausing it:

```sh
systemctl disable --now bleyjur-update.timer
```

Clearing a failed revision so it's retried on the next run:

```sh
rm /opt/bleyjur/.git/bleyjur-failed-rev
```

Running an update right now: `systemctl start bleyjur-update.service`.

"Local changes" error: someone edited files in `/opt/bleyjur`. Look with `git -C /opt/bleyjur status`, then discard them (`git -C /opt/bleyjur checkout -- .`) or commit them upstream.

### Code deploys itself, unit files don't

The updater only picks up code. After changing anything under `deploy/` (including `bleyjur.service`), copy the units again and reload by hand:

```sh
cp /opt/bleyjur/deploy/bleyjur.service /opt/bleyjur/deploy/bleyjur-update.* /etc/systemd/system/
systemctl daemon-reload
systemctl restart bleyjur.service
```

Changes to `.env.example` are not applied either; edit `/etc/bleyjur/bleyjur.env` and `systemctl restart bleyjur`. If you change `PORT`, also change `HEALTH_URL` in `bleyjur-update.service`.

## Backups

The pre-deploy copies are only for rollbacks. For real backups, copy the database nightly with `sqlite3 .backup` (safe while the app is running) and get the file off the container. Example `/etc/cron.d/bleyjur-backup`:

```cron
# m h dom mon dow user command
30 3 * * * root mkdir -p /root/bleyjur-backups && sqlite3 /var/lib/bleyjur/bleyjur.db ".backup '/root/bleyjur-backups/bleyjur-$(date +\%F).db'" && find /root/bleyjur-backups -name 'bleyjur-*.db' -mtime +30 -delete
```

Better still, point the destination at a mounted share or your NAS. `GET /api/export` also returns all data as JSON.

Restoring a copy by hand:

```sh
systemctl stop bleyjur
cp /root/bleyjur-backups/bleyjur-2026-01-31.db /var/lib/bleyjur/bleyjur.db
rm -f /var/lib/bleyjur/bleyjur.db-wal /var/lib/bleyjur/bleyjur.db-shm
chown bleyjur:bleyjur /var/lib/bleyjur/bleyjur.db
systemctl start bleyjur
```

## Troubleshooting

- **`status=226/NAMESPACE` when starting `bleyjur.service`**: the sandboxing options (`PrivateTmp`, `ProtectSystem`, …) need namespaces. On Proxmox, enable *nesting* for the container (Options → Features → nesting). Otherwise comment out the hardening lines in `/etc/systemd/system/bleyjur.service` and `daemon-reload`.
- **better-sqlite3 fails to build**: make sure `build-essential` and `python3` are installed.
- **`git fetch` errors in the journal every 5 minutes**: the container can't reach GitHub (DNS or network). The app keeps running.
