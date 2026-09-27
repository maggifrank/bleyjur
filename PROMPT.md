# Bleyjur: build spec

Build a small, mobile-first app for tracking an infant's diaper usage and the cost of those diapers.

## Tech stack and hosting

The app is **self-hosted on a local LXC container**, reachable only on the home network or over **Tailscale**, and **both parents share the same data** from their own phones.

- **Server:** Node.js + TypeScript (Fastify or Express) with a small JSON REST API. One process serves both the API and the built frontend.
- **Database:** **SQLite** file on the container (e.g. `better-sqlite3`), with simple versioned migrations. All data lives on the server, never only in a browser.
- **Frontend:** single-page web app in TypeScript + Vite (Preact or vanilla), **installable as a PWA** (add to home screen on iPhone/Android).
- **Shared data:** every client reads from and writes to the server. When the app is opened or regains focus it refetches, and it polls every ~30 s while open, so one parent sees the other's entries without reloading.
- **Offline tolerance:** if the server can't be reached (e.g. phone off Wi-Fi), new changes are queued locally and sent when the connection returns. Each record gets a client-generated UUID so retries never create duplicates.
- **Who logged it:** each device picks a parent name once (stored on the device); every change and purchase records `logged_by`.
- **Access:** reachable only on the home network or via Tailscale (no public exposure, no user accounts). A **shared PIN is required**: set via an environment variable, entered once per device, checked by the server, which then issues a long-lived session cookie. Rate-limit wrong PIN attempts. Bind to `0.0.0.0` so both the LAN and Tailscale interfaces work.
- **Deployment:** runs as a **systemd service** in the LXC (Debian/Ubuntu). Config via environment variables: `PORT` (default 3000), `DATA_DIR` (SQLite location), `APP_PIN` (required). The app's unit is `bleyjur.service`. Keep the SQLite database outside the repo checkout (e.g. `DATA_DIR=/var/lib/bleyjur`). Include a README with install steps. Updates deploy automatically, see **Automatic deploys** below.
- **Backups:** a `GET /api/export` endpoint returning all data as JSON, an import endpoint, and a note in the README on copying the SQLite file (e.g. nightly cron with `sqlite3 .backup`).
- **Tests:** unit tests (Vitest) for all cost and date-range calculations, run on the server where those calculations live.

## Automatic deploys

The server pulls new code from GitHub on its own. GitHub never pushes to the server, so nothing has to be exposed to the internet. The repo has no `update.sh` yet, so write it from scratch to this design.

### Health endpoint

Add `GET /api/health`: **no PIN required**, cheap, returns `200 {"ok":true}` when the server is up and the database opens, and non-2xx otherwise.

### Timer and service

1. `deploy/bleyjur-update.timer` runs `bleyjur-update.service` 2 minutes after boot and then every 5 minutes: `OnBootSec=2min`, `OnUnitActiveSec=5min`, `RandomizedDelaySec=30s` so it doesn't hit GitHub exactly on the minute.
2. `deploy/bleyjur-update.service` is `Type=oneshot` and runs as root, because it backs up the database and calls `systemctl`. Nothing from the repo runs as root: `git`, `npm ci` and `npm run build` run as the unprivileged `bleyjur-build` user (via `runuser`), which owns the checkout. `ExecStart=` is `/usr/local/sbin/bleyjur-update`, a root-owned copy of `update.sh` that `deploy/install.sh` installs, so a push can't change what runs as root. The repo path (`APP_DIR`) and health-check URL (`HEALTH_URL`, e.g. `http://127.0.0.1:3000/api/health`) come in through `Environment=` lines.

### `update.sh`

- Runs with `set -euo pipefail` and `git fetch --quiet origin`.
- Compares `git rev-parse HEAD` with `git rev-parse '@{u}'`. If they match, exits 0 **without printing anything**, so unchanged checks leave nothing in the journal.
- Keeps a "last failed revision" marker in `/var/lib/bleyjur-update/failed-rev` (root-only, outside the checkout, which root never reads from). If the remote revision equals the marker, exits 0. A bad push is tried once, not every 5 minutes.
- If the working tree has local changes (`git status --porcelain` is non-empty, i.e. files were edited by hand on the server), prints an error and exits 1 without touching anything.
- Updates with `git merge --ff-only`, **never** `git pull` or `reset --hard`. If the fast-forward fails, prints an error and exits 1.
- Logs `updating OLD -> NEW`.
- Pre-restart steps: `npm ci` and `npm run build`, then a copy of the SQLite database (`sqlite3 .backup`) so a rollback can undo a migration. If any of these fail, treat it as a failed deploy (below).
- Restarts `bleyjur.service`.
- Health-checks it: `curl -fsS --max-time 2 "$HEALTH_URL"` once a second for up to 15 seconds.
- **Healthy:** deletes the failed marker, runs any post-deploy steps (none needed yet; leave a clearly marked spot for them), and logs success.
- **Unhealthy or a pre-restart step failed:** writes the new revision to the failed marker, `git reset --hard OLD`, runs `npm ci && npm run build` again for the old revision, restores the database copy if the app was restarted on the new code, restarts the service, and exits 1.

### Docs

A `DEPLOY.md` (linked from the README) with:

- Install: `cp deploy/bleyjur-update.* /etc/systemd/system/`, `systemctl daemon-reload`, `systemctl enable --now bleyjur-update.timer`.
- Checking on it: `systemctl list-timers`, `journalctl -u bleyjur-update -n 50`.
- Pausing it: `systemctl disable --now bleyjur-update.timer`.
- Clearing a failed revision so it's retried: `rm .git/bleyjur-failed-rev`.
- A note that **code deploys itself but unit files don't**. After changing anything under `deploy/` (or `bleyjur.service`), copy the units again and run `systemctl daemon-reload` by hand.

## Core concepts

### 1. Diaper change (usage log)

Each time a diaper is used, the user logs a change. This must be fast: one tap for the common case.

| Field    | Type                                  | Notes                                                        |
| -------- | ------------------------------------- | ------------------------------------------------------------ |
| id       | string                                | generated                                                    |
| time     | datetime                              | defaults to now, editable                                    |
| size     | string                                | e.g. `1`, `2`, `3`, `4`, `5`; defaults to the last used size |
| type     | `wet` \| `dirty` \| `both` \| `dry`   | what the diaper contained; `dry` still counts as a used diaper (it's only logged when a diaper was actually changed) |
| note     | string, optional                      |                                                              |
| logged_by | string                               | parent name from the device                                  |

### 2. Diaper pack purchase

| Field     | Type             | Notes                                   |
| --------- | ---------------- | --------------------------------------- |
| id        | string           | generated                               |
| date      | date             | defaults to today                       |
| size      | string           | same size values as changes             |
| brand     | string, optional |                                         |
| count     | integer          | number of diapers in the pack           |
| price     | number           | total price paid for the pack           |
| store     | string, optional |                                         |
| logged_by | string           | parent name from the device             |

Derived: **price per diaper = price / count**, shown on every purchase.

## Cost of a diaper change

Every logged change gets a cost, taken from the packs of the **same size**, consumed in purchase order (FIFO). Example: a pack of 20 diapers for 1000 kr. makes those 20 diapers cost 50 kr. each; the next pack of 15 for 899 kr. makes its 15 diapers cost ~60 kr. each (899 / 15 = 59.93). Every change of every type, including `dry`, uses up one diaper.

- Changes of a given size draw down the oldest pack of that size that still has diapers left, then the next, and so on.
- The change's cost is that pack's price per diaper.
- If no pack covers a change (the user logged more diapers than they bought, or hasn't logged a purchase yet), use the price per diaper of the most recent pack of that size; if there is none, of the most recent pack of any size. Mark such costs as **estimated** in the UI.
- Recompute costs on the server whenever a change or purchase is added, edited, or deleted, so both parents always see the same numbers.

Also show **stock on hand per size**: diapers bought minus diapers used.

## Reports

A dashboard shows, for each of these periods:

- **Today**
- **Week to date** (Monday to now)
- **Last week** (previous Monday to Sunday)
- **Month to date** (1st of this month to now)
- **Last month** (whole previous calendar month)

For each period show:

- number of diapers used, broken down by size and by type (wet / dirty / both / dry)
- total diaper cost for the period (sum of change costs), flagged if any part is estimated
- average diapers per day
- money spent on packs bought in that period (separate from usage cost)

### Weekly summary

At the start of each new week (first time the app is opened on a device on or after Monday), show a summary card: "Last week: N diapers, X kr." with a comparison to the week before. The card can be dismissed and stays available on the dashboard.

## Screens

1. **Log**: a big "Log change" button with type choices (wet, dirty, both, dry) and the current size preselected. Below it, today's changes in a list, each editable and deletable.
2. **Dashboard**: the period reports above, plus stock on hand per size.
3. **Purchases**: list of packs with price per diaper and remaining count; add, edit, delete.
4. **Settings**: this device's parent name, and shared settings stored on the server: currency (default ISK, `kr.`), week start (default Monday), list of diaper sizes, baby's name, export/import data.

## App icon

Use the ready-made icon in `icons/` (a cheering baby turtle in a diaper, with a krónur coin and a droplet, on a blue-violet background). `icons/icon.svg` is the source; the rest are rendered from it:

| File                         | Use                                                        |
| ---------------------------- | ---------------------------------------------------------- |
| `icons/icon.svg`             | source, and `<link rel="icon" type="image/svg+xml">`        |
| `icons/icon-192.png`         | web manifest icon, 192x192                                 |
| `icons/icon-512.png`         | web manifest icon, 512x512, `"purpose": "any"` |
| `icons/apple-touch-icon.png` | `<link rel="apple-touch-icon">`, 180x180 for iOS home screen |
| `icons/favicon.ico`          | browser tab favicon (16, 32, 48)                           |
| `icons/favicon-32.png`       | PNG favicon fallback                                       |

Copy them into the frontend's public/static folder. Use `#7A86F5` as the manifest `theme_color` and `background_color`.

## Requirements

- Mobile-first, readable one-handed at night: large tap targets, dark mode following the system.
- UI in **Icelandic and English** (default Icelandic), all strings in one place.
- Dates and times use the device's local time zone.
- Money is stored in the smallest sensible unit and rounded only for display.
- Deleting anything asks for confirmation.
- The app shell loads offline, and changes logged while offline sync when the server is reachable again, with a visible "not synced" indicator.

## Out of scope for v1

User accounts, public internet exposure, multiple children, notifications, and charts beyond simple numbers.
