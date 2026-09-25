# Bleyjur: build spec

Build a small, mobile-first app for tracking an infant's diaper usage and the cost of those diapers.

## Tech stack and hosting

The app is **self-hosted on a local LXC container** on the home network, and **both parents share the same data** from their own phones.

- **Server:** Node.js + TypeScript (Fastify or Express) with a small JSON REST API. One process serves both the API and the built frontend.
- **Database:** **SQLite** file on the container (e.g. `better-sqlite3`), with simple versioned migrations. All data lives on the server, never only in a browser.
- **Frontend:** single-page web app in TypeScript + Vite (Preact or vanilla), **installable as a PWA** (add to home screen on iPhone/Android).
- **Shared data:** every client reads from and writes to the server. When the app is opened or regains focus it refetches, and it polls every ~30 s while open, so one parent sees the other's entries without reloading.
- **Offline tolerance:** if the server can't be reached (e.g. phone off Wi-Fi), new changes are queued locally and sent when the connection returns. Each record gets a client-generated UUID so retries never create duplicates.
- **Who logged it:** each device picks a parent name once (stored on the device); every change and purchase records `logged_by`.
- **Access:** LAN only, no user accounts. Optional shared PIN/passphrase set via an environment variable, checked by the server.
- **Deployment:** runs as a **systemd service** in the LXC (Debian/Ubuntu). Config via environment variables: `PORT` (default 3000), `DATA_DIR` (SQLite location), `APP_PIN` (optional). Include a README with install steps and a one-command update (`git pull && npm ci && npm run build && systemctl restart bleyjur`).
- **Backups:** a `GET /api/export` endpoint returning all data as JSON, an import endpoint, and a note in the README on copying the SQLite file (e.g. nightly cron with `sqlite3 .backup`).
- **Tests:** unit tests (Vitest) for all cost and date-range calculations, run on the server where those calculations live.

## Core concepts

### 1. Diaper change (usage log)

Each time a diaper is used, the user logs a change. This must be fast: one tap for the common case.

| Field    | Type                                  | Notes                                                        |
| -------- | ------------------------------------- | ------------------------------------------------------------ |
| id       | string                                | generated                                                    |
| time     | datetime                              | defaults to now, editable                                    |
| size     | string                                | e.g. `1`, `2`, `3`, `4`, `5`; defaults to the last used size |
| type     | `wet` \| `dirty` \| `both` \| `dry`   | what the diaper contained                                    |
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

Every logged change gets a cost, taken from the packs of the **same size**, consumed in purchase order (FIFO):

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

## Requirements

- Mobile-first, readable one-handed at night: large tap targets, dark mode following the system.
- UI in **Icelandic and English** (default Icelandic), all strings in one place.
- Dates and times use the device's local time zone.
- Money is stored in the smallest sensible unit and rounded only for display.
- Deleting anything asks for confirmation.
- The app shell loads offline, and changes logged while offline sync when the server is reachable again, with a visible "not synced" indicator.

## Out of scope for v1

User accounts, access from outside the home network, multiple children, notifications, and charts beyond simple numbers.

## Open questions

1. Is ISK the right default currency?
2. Should "dry" be a change type, or only wet / dirty / both?
3. Is FIFO per size the right way to price a change, or is a simple average price per size good enough?
4. Do you want a PIN on the app, or is being on the home network enough?
