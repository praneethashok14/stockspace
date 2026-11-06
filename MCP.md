# StockSpace MCP server

StockSpace exposes a **Model Context Protocol** server at `POST /mcp` on the
Cloudflare Worker, so Claude Desktop, Claude Code, or any MCP-compatible
client can read and change your inventory.

## Connect

1. In the StockSpace web app, open **Settings → API tokens** and create a
   token. Copy it immediately — you only see it once.
2. In your MCP client, add a remote MCP server:
   - **URL:** `https://<your-stockspace-worker-url>/mcp`
   - **Transport:** Streamable HTTP (POST)
   - **Auth:** `Authorization: Bearer <token>`

### Claude Code

```bash
claude mcp add --remote stockspace https://<your-stockspace-worker-url>/mcp \
  --header "Authorization: Bearer $STOCKSPACE_TOKEN"
```

### Claude Desktop

Settings → **Connectors** → **Add custom connector** → paste URL + bearer
token → Save.

## What's exposed

### Resources (read-only)

| URI                                 | What it is                                          |
| ----------------------------------- | --------------------------------------------------- |
| `stockspace://appliances`           | Every appliance                                     |
| `stockspace://groups`               | Every group (with `parent_group_id`)                |
| `stockspace://items`                | Every item with full fields                         |
| `stockspace://tags`                 | All tags                                            |
| `stockspace://low-stock`            | Items at or below their `low_threshold`             |
| `stockspace://expiring-soon`        | Items expired or expiring within 7 days             |
| `stockspace://items/{item_id}`      | One item by id (template)                           |

### Tools (mutations)

| Tool               | Purpose                                                           |
| ------------------ | ----------------------------------------------------------------- |
| `add_item`         | Create an item (requires `low_threshold`)                         |
| `set_quantity`     | Set an item's quantity (or pack_count) to an exact value          |
| `adjust_quantity`  | ±N quantity / pack_count                                          |
| `update_item`      | Patch one or more mutable fields                                  |
| `delete_item`      | Permanently delete the item + its photo                           |
| `add_group`        | Create a group, optionally nested under another                   |
| `assign_group`     | Move an item to another group, or ungroup                         |
| `open_pack`        | Mark a pack item opened (scope: `one` or `all`)                   |
| `close_pack`       | Mark a pack item unopened (scope: `one` or `all`)                 |

## Auth model

- Bearer tokens are issued from **Settings → API tokens** and only their
  sha-256 hashes are stored server-side.
- The MCP route (`/mcp`) refuses cookie-based sessions. You must use a
  bearer token. This prevents browser-origin requests from hitting it
  with the user's cookie.
- Revoking a token from Settings takes effect on the next MCP call.

## Family accounts

If your account is in a family, resources return the merged inventory the
web UI shows you, and tools act on the owning family member's data
automatically — no extra configuration.

## Things that aren't here yet

- Photo bytes as inline binary resources (today's resources point back
  at the REST endpoint instead; the client's bearer works there too).
- Server-sent events for streaming long tools. All current tools are
  synchronous.
- Per-token rate limiting.
