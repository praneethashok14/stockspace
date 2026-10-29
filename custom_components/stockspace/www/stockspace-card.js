// StockSpace Lovelace card.
//
// Zero-config: auto-discovers every StockSpace item sensor currently in HA,
// groups them by appliance, and renders a tile with +/- buttons and a long-
// press "set exact" prompt. Also offers a + button per appliance to add a new
// item without leaving HA.
//
// Usage in a dashboard: just drop `type: custom:stockspace-card` as a card.

const CARD_VERSION = "0.1.0";

const STYLES = `
  :host { display: block; }
  .wrap {
    background: var(--ha-card-background, var(--card-background-color, #fff));
    border-radius: var(--ha-card-border-radius, 12px);
    box-shadow: var(--ha-card-box-shadow, none);
    border: var(--ha-card-border-width, 1px) solid
            var(--ha-card-border-color, var(--divider-color, #e0e0e0));
    padding: 16px;
    color: var(--primary-text-color);
    font-family: var(--paper-font-body1_-_font-family, sans-serif);
  }
  h2 {
    margin: 0 0 12px 0;
    font-size: 1.15rem;
    font-weight: 600;
  }
  .empty { color: var(--secondary-text-color); font-size: .9rem; }
  details {
    margin: 10px 0;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 10px;
    overflow: hidden;
  }
  summary {
    cursor: pointer;
    padding: 10px 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 600;
    list-style: none;
    background: var(--secondary-background-color, rgba(0,0,0,.03));
  }
  summary::-webkit-details-marker { display: none; }
  summary .caret {
    width: 10px; height: 10px;
    border-right: 2px solid currentColor;
    border-bottom: 2px solid currentColor;
    transform: rotate(-45deg);
    transition: transform .15s;
  }
  details[open] summary .caret { transform: rotate(45deg); }
  .count {
    margin-left: auto;
    color: var(--secondary-text-color);
    font-weight: 500;
    font-size: .9rem;
  }
  .add-btn {
    appearance: none;
    border: 1px solid var(--divider-color, #e0e0e0);
    background: var(--card-background-color);
    color: var(--primary-text-color);
    border-radius: 999px;
    padding: 4px 10px;
    font-size: .85rem;
    cursor: pointer;
  }
  .add-btn:hover { background: var(--secondary-background-color); }
  .items {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 8px;
    padding: 10px;
  }
  .item {
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 10px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--card-background-color);
  }
  .item .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item .meta {
    font-size: .78rem;
    color: var(--secondary-text-color);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item .meta.expired { color: var(--error-color, #d33); font-weight: 600; }
  .item .meta.soon { color: var(--warning-color, #c80); font-weight: 600; }
  .controls {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: auto;
  }
  .controls button {
    flex: 0 0 auto;
    width: 36px; height: 36px;
    border-radius: 50%;
    border: 1px solid var(--divider-color, #e0e0e0);
    background: var(--card-background-color);
    color: var(--primary-text-color);
    font-size: 1.1rem;
    cursor: pointer;
  }
  .controls button:hover { background: var(--secondary-background-color); }
  .controls .val {
    flex: 1 1 auto;
    text-align: center;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    cursor: pointer;
    padding: 6px 4px;
    border-radius: 8px;
  }
  .controls .val:hover { background: var(--secondary-background-color); }
  .pack-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 6px;
    font-size: .7rem;
    margin-left: 6px;
    background: var(--secondary-background-color);
    color: var(--secondary-text-color);
  }
  .pack-badge.opened { background: var(--warning-color, #c80); color: #fff; }
`;

class StockSpaceCard extends HTMLElement {
  constructor() {
    super();
    this._root = this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = {};
    this._lastSignature = "";
  }

  setConfig(config) {
    this._config = config || {};
  }

  getCardSize() {
    return 6;
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _collect() {
    const hass = this._hass;
    if (!hass) return { appliances: new Map(), items: [] };
    const items = [];
    const applianceNames = new Map();

    for (const [entity_id, stObj] of Object.entries(hass.states)) {
      const attrs = stObj.attributes || {};
      if (!attrs.item_id || !attrs.appliance_id) continue;
      items.push({
        entity_id,
        name: attrs.friendly_name || entity_id,
        appliance_id: attrs.appliance_id,
        item_id: attrs.item_id,
        group_id: attrs.group_id || null,
        tracking: attrs.tracking,
        pack_status: attrs.pack_status || null,
        expiration_date: attrs.expiration_date || null,
        category: attrs.category || null,
        state: stObj.state,
        unit: attrs.unit_of_measurement || "",
      });
    }

    const entMap = hass.entities || {};
    const devMap = hass.devices || {};
    for (const item of items) {
      if (applianceNames.has(item.appliance_id)) continue;
      const regEnt = entMap[item.entity_id];
      if (regEnt && regEnt.device_id && devMap[regEnt.device_id]) {
        const d = devMap[regEnt.device_id];
        applianceNames.set(item.appliance_id, d.name_by_user || d.name || "Appliance");
      } else {
        applianceNames.set(item.appliance_id, "Appliance");
      }
    }

    const byAppliance = new Map();
    for (const item of items) {
      if (!byAppliance.has(item.appliance_id)) byAppliance.set(item.appliance_id, []);
      byAppliance.get(item.appliance_id).push(item);
    }
    for (const list of byAppliance.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }

    return { byAppliance, applianceNames };
  }

  _signature(data) {
    const parts = [];
    for (const [appId, list] of data.byAppliance) {
      parts.push(appId + ":" + data.applianceNames.get(appId));
      for (const it of list) {
        parts.push(
          [it.entity_id, it.state, it.unit, it.expiration_date, it.pack_status].join("|"),
        );
      }
    }
    return parts.join("~");
  }

  _render() {
    if (!this._hass) return;
    const data = this._collect();
    const sig = this._signature(data);
    if (sig === this._lastSignature && this._root.firstChild) {
      return;
    }
    this._lastSignature = sig;

    const todayStr = new Date().toISOString().slice(0, 10);
    const sevenDays = new Date();
    sevenDays.setDate(sevenDays.getDate() + 7);
    const sevenStr = sevenDays.toISOString().slice(0, 10);

    const html = [
      `<style>${STYLES}</style>`,
      `<ha-card class="wrap">`,
      `<h2>StockSpace</h2>`,
    ];

    if (data.byAppliance.size === 0) {
      html.push(
        `<div class="empty">No StockSpace items visible yet. Add some items in the app or via <code>stockspace.add_item</code>.</div>`,
      );
    } else {
      for (const [appId, list] of data.byAppliance) {
        const appName = data.applianceNames.get(appId) || "Appliance";
        html.push(
          `<details open>`,
          `<summary><span class="caret"></span><span>${escapeHtml(appName)}</span><span class="count">${list.length} item${list.length === 1 ? "" : "s"}</span><button class="add-btn" data-action="add" data-appliance="${escapeAttr(appId)}">+ item</button></summary>`,
          `<div class="items">`,
        );
        for (const item of list) {
          let metaCls = "meta";
          let metaBits = [];
          if (item.category) metaBits.push(escapeHtml(item.category));
          if (item.expiration_date) {
            if (item.expiration_date < todayStr) metaCls = "meta expired";
            else if (item.expiration_date <= sevenStr) metaCls = "meta soon";
            metaBits.push(`exp ${escapeHtml(item.expiration_date)}`);
          }
          const metaText = metaBits.join(" · ") || "&nbsp;";

          const packBadge =
            item.tracking === "pack" && item.pack_status
              ? `<span class="pack-badge ${item.pack_status === "opened" ? "opened" : ""}">${item.pack_status}</span>`
              : "";

          html.push(
            `<div class="item">`,
            `<div class="name">${escapeHtml(item.name)}${packBadge}</div>`,
            `<div class="${metaCls}">${metaText}</div>`,
            `<div class="controls">`,
            `<button data-action="dec" data-entity="${escapeAttr(item.entity_id)}" data-tracking="${item.tracking}" title="Decrement">−</button>`,
            `<div class="val" data-action="set" data-entity="${escapeAttr(item.entity_id)}" data-tracking="${item.tracking}" title="Set exact value">${escapeHtml(item.state)}${item.unit ? " " + escapeHtml(item.unit) : ""}</div>`,
            `<button data-action="inc" data-entity="${escapeAttr(item.entity_id)}" data-tracking="${item.tracking}" title="Increment">+</button>`,
            `</div>`,
            `</div>`,
          );
        }
        html.push(`</div></details>`);
      }
    }

    html.push(`</ha-card>`);
    this._root.innerHTML = html.join("");

    this._root.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", (e) => this._onClick(e));
    });
  }

  async _onClick(e) {
    e.stopPropagation();
    const el = e.currentTarget;
    const action = el.dataset.action;
    const entity = el.dataset.entity;
    const tracking = el.dataset.tracking;
    const hass = this._hass;
    if (!hass) return;

    if (action === "inc" || action === "dec") {
      const delta = action === "inc" ? 1 : -1;
      try {
        await hass.callService("stockspace", "adjust_quantity", {
          entity_id: entity,
          delta,
        });
      } catch (err) {
        this._toast(`Could not update: ${err.message || err}`);
      }
      return;
    }

    if (action === "set") {
      const current = hass.states[entity]?.state ?? "";
      const label =
        tracking === "pack"
          ? "New pack count (whole number):"
          : "New quantity:";
      const next = window.prompt(label, current);
      if (next == null || next === "") return;
      const value = Number(next);
      if (!Number.isFinite(value) || value < 0) {
        this._toast("Enter a non-negative number");
        return;
      }
      try {
        await hass.callService("stockspace", "set_quantity", {
          entity_id: entity,
          value,
        });
      } catch (err) {
        this._toast(`Could not set: ${err.message || err}`);
      }
      return;
    }

    if (action === "add") {
      const appliance_id = el.dataset.appliance;
      const name = window.prompt("Item name:");
      if (!name) return;
      const trackingChoice = (
        window.prompt("Tracking: individual or pack", "individual") || ""
      )
        .trim()
        .toLowerCase();
      if (trackingChoice !== "individual" && trackingChoice !== "pack") {
        this._toast("Tracking must be 'individual' or 'pack'");
        return;
      }
      const devId = this._deviceForAppliance(appliance_id);
      if (!devId) {
        this._toast("No device matches this appliance; open Developer Tools → stockspace.add_item.");
        return;
      }
      const payload = { device_id: devId, name, tracking: trackingChoice };
      if (trackingChoice === "individual") {
        const q = Number(window.prompt("Quantity:", "1"));
        const unit = window.prompt("Unit (e.g. pcs, L, g):", "pcs");
        if (!Number.isFinite(q) || q < 0 || !unit) return;
        payload.quantity = q;
        payload.unit = unit;
      } else {
        const n = Number(window.prompt("Pack count:", "1"));
        const label = window.prompt("Pack label (e.g. 6-pack):", "pack");
        if (!Number.isInteger(n) || n < 0 || !label) return;
        payload.pack_count = n;
        payload.pack_label = label;
        payload.pack_status = "unopened";
      }
      try {
        await hass.callService("stockspace", "add_item", payload);
      } catch (err) {
        this._toast(`Could not add: ${err.message || err}`);
      }
      return;
    }
  }

  _deviceForAppliance(applianceId) {
    const hass = this._hass;
    const entMap = hass.entities || {};
    for (const [entity_id, stObj] of Object.entries(hass.states)) {
      const a = stObj.attributes || {};
      if (a.appliance_id === applianceId && !a.item_id && !a.group_id) {
        const reg = entMap[entity_id];
        if (reg && reg.device_id) return reg.device_id;
      }
    }
    for (const [entity_id, stObj] of Object.entries(hass.states)) {
      const a = stObj.attributes || {};
      if (a.appliance_id === applianceId) {
        const reg = entMap[entity_id];
        if (reg && reg.device_id) return reg.device_id;
      }
    }
    return null;
  }

  _toast(msg) {
    const ev = new Event("hass-notification", { bubbles: true, composed: true });
    ev.detail = { message: msg };
    this.dispatchEvent(ev);
    try {
      console.warn("[stockspace-card]", msg);
    } catch (_) {}
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s) {
  return escapeHtml(s);
}

if (!customElements.get("stockspace-card")) {
  customElements.define("stockspace-card", StockSpaceCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c.type === "stockspace-card")) {
  window.customCards.push({
    type: "stockspace-card",
    name: "StockSpace",
    description:
      "Browse all your StockSpace items with +/- buttons and quick add. No config needed.",
    preview: false,
  });
}

console.info(
  `%c STOCKSPACE-CARD %c v${CARD_VERSION} `,
  "color: #fff; background: #333; font-weight: 700;",
  "color: #333; background: #eee;",
);
