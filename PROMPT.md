# Bleyjur: build spec

Build a small, mobile-first app for tracking an infant's diaper usage and the cost of those diapers.

## Tech stack (default)

No stack was specified, so use this default unless told otherwise:

- A single-page **web app installable as a PWA** (works offline, add-to-home-screen on iPhone/Android).
- Plain TypeScript + Vite, with a light UI library only if it clearly helps (e.g. Preact or vanilla web components). No backend.
- All data stored locally in the browser with **IndexedDB**.
- **Export / import** of all data as a JSON file, so data can be backed up or moved between devices.
- Unit tests (Vitest) for all cost and date-range calculations.

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

Derived: **price per diaper = price / count**, shown on every purchase.

## Cost of a diaper change

Every logged change gets a cost, taken from the packs of the **same size**, consumed in purchase order (FIFO):

- Changes of a given size draw down the oldest pack of that size that still has diapers left, then the next, and so on.
- The change's cost is that pack's price per diaper.
- If no pack covers a change (the user logged more diapers than they bought, or hasn't logged a purchase yet), use the price per diaper of the most recent pack of that size; if there is none, of the most recent pack of any size. Mark such costs as **estimated** in the UI.
- Recompute costs whenever a change or purchase is added, edited, or deleted.

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

At the start of each new week (first time the app is opened on or after Monday), show a summary card: "Last week: N diapers, X kr." with a comparison to the week before. The card can be dismissed and stays available on the dashboard.

## Screens

1. **Log**: a big "Log change" button with type choices (wet, dirty, both, dry) and the current size preselected. Below it, today's changes in a list, each editable and deletable.
2. **Dashboard**: the period reports above, plus stock on hand per size.
3. **Purchases**: list of packs with price per diaper and remaining count; add, edit, delete.
4. **Settings**: currency (default ISK, `kr.`), week start (default Monday), list of diaper sizes, baby's name, export/import data.

## Requirements

- Mobile-first, readable one-handed at night: large tap targets, dark mode following the system.
- UI in **Icelandic and English** (default Icelandic), all strings in one place.
- Dates and times use the device's local time zone.
- Money is stored in the smallest sensible unit and rounded only for display.
- Deleting anything asks for confirmation.
- Works fully offline after the first load.

## Out of scope for v1

Accounts, cloud sync, multiple children, notifications, and charts beyond simple numbers.

## Open questions

1. Is a web app / PWA fine, or should it be a native iPhone app?
2. Should data sync between two parents' phones? (That would need a backend, e.g. a shared Supabase or Firebase project.)
3. Is ISK the right default currency?
4. Should "dry" be a change type, or only wet / dirty / both?
5. Is FIFO per size the right way to price a change, or is a simple average price per size good enough?
