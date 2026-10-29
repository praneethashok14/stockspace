# StockSpace — Home Assistant integration

Expose your StockSpace inventory (appliances, groups, items, and item photos)
as Home Assistant entities so you can build automations against them —
"notify me when any item expires in the next 3 days", "flash the lights when
the eggs are at 2", etc.

Each appliance becomes an HA **device**. Under each device you get:

| Entity                          | What it shows                                                            |
| ------------------------------- | ------------------------------------------------------------------------ |
| `sensor.<appliance>_total_items`    | Total items in the appliance                                         |
| `sensor.<appliance>_expiring_soon`  | Items expiring within the next 7 days                                |
| `sensor.<appliance>_expired`        | Items whose expiration date is already in the past                   |
| `sensor.<appliance>_open_packs`     | Pack-tracked items that are currently opened                         |
| `sensor.group_<name>`               | Item count in each group (indented naming follows your UI)           |
| `sensor.<item name>`                | Quantity (`individual`) or pack count (`pack`); unit = unit / label  |
| `image.<item name>_photo`           | Item photo (only for items that have one)                            |

Polls every 60 seconds.

## Install

### Option A — HACS custom repository

1. In Home Assistant, open **HACS → Integrations → ⋯ → Custom repositories**.
2. Add `https://github.com/praneethashok14/stockspace` as an **Integration**.
3. Install **StockSpace** from HACS and restart Home Assistant.

### Option B — manual

Copy the folder `custom_components/stockspace/` from this repo into your HA
config dir, so you end up with:

```
<config>/custom_components/stockspace/
  manifest.json
  __init__.py
  config_flow.py
  coordinator.py
  sensor.py
  image.py
  const.py
  strings.json
  translations/en.json
```

Then restart Home Assistant.

## Set up

1. In the StockSpace web app, open **Settings → API tokens** and create a
   token. **Copy the shown token immediately** — you won't see it again.
2. In Home Assistant, go to **Settings → Devices & Services → Add Integration**
   and search for **StockSpace**.
3. Enter:
   - **Base URL** — the URL of your StockSpace deployment, e.g.
     `https://stockspace.example.workers.dev`
   - **API token** — the token you just copied
4. The integration validates the token with a `GET /api/items` call and then
   creates one device per appliance.

## Security notes

- The token is a long-lived bearer credential. Treat it like a password.
- `GET /api/items` returns the full inventory snapshot for the authenticated
  account; the token has the same visibility as a signed-in session.
- Tokens can be revoked at any time from **Settings → API tokens** in the web
  app. Revoking takes effect on the next integration poll.
- The server only stores `sha256(token)` and the first 8 characters (for the
  UI). The plaintext never leaves your browser after creation.

## Troubleshooting

- **"The API token was rejected"** — the token was mistyped, revoked, or
  belongs to a different account. Create a new one.
- **"Could not reach StockSpace at that URL"** — check the URL is reachable
  from HA (`curl -I <url>/api/health` should return `200`).
- **Entities don't show up for new items** — the integration adds entities on
  the next poll (default 60 s) once an item appears in `/api/items`.
