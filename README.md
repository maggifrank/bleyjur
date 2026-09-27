# Bleyjur

A small, self-hosted web app for tracking an infant's diaper changes and what those diapers cost. Both parents log from their own phones against the same server; the app works as a home-screen PWA and keeps queued changes when a phone is offline.

The full spec is in [PROMPT.md](PROMPT.md).

## What it does

- **Log a change in one tap**: wet, dirty, both or dry, with the current size preselected.
- **Log pack purchases**: size, count and price, giving a price per diaper.
- **Cost per change**: each change uses one diaper from the oldest pack of its size (a pack of 20 for 1.000 kr. makes those diapers 50 kr. each). Changes not covered by any pack are priced from the latest pack and marked as estimated (≈).
- **Reports** for today, week to date, last week, month to date and last month, a weekly summary card, and stock on hand per size.
- Icelandic and English, dark mode, shared PIN, JSON export/import.

## Development

Requires Node.js 20+.

```bash
npm install
```

Run the server and the Vite dev server in two terminals:

```bash
APP_PIN=1234 npm run dev:server
```

```bash
npm run dev:client
```

Open the URL Vite prints; `/api` is proxied to the server on port 3000. Data goes to `./data/` unless `DATA_DIR` is set.

```bash
npm test
```

## Production

```bash
npm ci && npm run build && APP_PIN=1234 DATA_DIR=/var/lib/bleyjur npm start
```

Configuration is by environment variable (see [.env.example](.env.example)):

| Variable   | Default    | Notes                                  |
| ---------- | ---------- | -------------------------------------- |
| `APP_PIN`  | (required) | shared PIN both parents enter once     |
| `PORT`     | `3000`     |                                        |
| `HOST`     | `0.0.0.0`  | listens on LAN and Tailscale           |
| `DATA_DIR` | `./data`   | SQLite database lives here             |

Installing on the LXC container, automatic deploys from GitHub, rollback and backups are covered in [DEPLOY.md](DEPLOY.md).

## Layout

```
server/   Fastify API, SQLite, cost and report calculations (+ tests)
client/   Preact PWA (Vite)
shared/   API types used by both
deploy/   systemd units and install script
update.sh auto-deploy script run by bleyjur-update.timer
```
