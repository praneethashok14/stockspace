"""The StockSpace integration."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import voluptuous as vol
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .const import DOMAIN
from .coordinator import StockSpaceCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.SENSOR, Platform.IMAGE]

CARD_URL = "/stockspace_static/stockspace-card.js"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up StockSpace from a config entry."""
    coordinator = StockSpaceCoordinator(hass, entry)
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    _async_register_services(hass)
    await _async_register_card(hass)
    return True


async def _async_register_card(hass: HomeAssistant) -> None:
    """Serve the bundled Lovelace card and register it as a frontend resource."""
    if hass.data.setdefault(DOMAIN, {}).get("_card_registered"):
        return
    www_dir = Path(__file__).parent / "www"
    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig("/stockspace_static", str(www_dir), True)]
        )
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning("Could not serve StockSpace card assets: %s", err)
        return
    add_extra_js_url(hass, CARD_URL)
    hass.data[DOMAIN]["_card_registered"] = True
    _LOGGER.info("Registered StockSpace Lovelace card at %s", CARD_URL)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    if not hass.data.get(DOMAIN):
        for svc in ("add_item", "add_group", "set_quantity", "adjust_quantity", "assign_group"):
            hass.services.async_remove(DOMAIN, svc)
    return unload_ok


# ---------- Service wiring ----------

def _coordinator_for_entry(hass: HomeAssistant, entry_id: str) -> StockSpaceCoordinator:
    coord = hass.data.get(DOMAIN, {}).get(entry_id)
    if coord is None:
        raise ServiceValidationError("StockSpace integration not loaded")
    return coord


def _resolve_device(
    hass: HomeAssistant, device_id: str
) -> tuple[StockSpaceCoordinator, str]:
    """Return (coordinator, appliance_id) for a StockSpace device_id."""
    device = dr.async_get(hass).async_get(device_id)
    if device is None:
        raise ServiceValidationError(f"Unknown device {device_id}")
    for domain, ident in device.identifiers:
        if domain == DOMAIN and ":" in ident:
            entry_id, appliance_id = ident.split(":", 1)
            return _coordinator_for_entry(hass, entry_id), appliance_id
    raise ServiceValidationError("Device is not a StockSpace appliance")


def _resolve_item_entity(
    hass: HomeAssistant, entity_id: str
) -> tuple[StockSpaceCoordinator, str, str]:
    """Return (coordinator, appliance_id, item_id) for a StockSpace item sensor."""
    reg = er.async_get(hass).async_get(entity_id)
    if reg is None or reg.platform != DOMAIN:
        raise ServiceValidationError(f"{entity_id} is not a StockSpace entity")
    parts = reg.unique_id.split(":")
    # Expected shape: <entry_id>:item:<item_id>
    if len(parts) < 3 or parts[1] != "item":
        raise ServiceValidationError(
            f"{entity_id} is not a StockSpace item sensor"
        )
    entry_id = parts[0]
    item_id = ":".join(parts[2:])
    coord = _coordinator_for_entry(hass, entry_id)
    item = coord.find_item(item_id)
    if item is None:
        raise ServiceValidationError(f"Item {item_id} no longer exists")
    return coord, item["appliance_id"], item_id


def _resolve_group_entity(
    hass: HomeAssistant, entity_id: str
) -> tuple[StockSpaceCoordinator, str, str]:
    """Return (coordinator, appliance_id, group_id) for a StockSpace group sensor."""
    reg = er.async_get(hass).async_get(entity_id)
    if reg is None or reg.platform != DOMAIN:
        raise ServiceValidationError(f"{entity_id} is not a StockSpace entity")
    parts = reg.unique_id.split(":")
    if len(parts) < 3 or parts[1] != "group":
        raise ServiceValidationError(
            f"{entity_id} is not a StockSpace group sensor"
        )
    entry_id = parts[0]
    group_id = ":".join(parts[2:])
    coord = _coordinator_for_entry(hass, entry_id)
    group = next(
        (g for g in (coord.data or {}).get("groups", []) if g.get("id") == group_id),
        None,
    )
    if group is None:
        raise ServiceValidationError(f"Group {group_id} no longer exists")
    return coord, group["appliance_id"], group_id


def _async_register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, "add_item"):
        return

    async def handle_add_item(call: ServiceCall) -> None:
        data: dict[str, Any] = dict(call.data)
        coord, appliance_id = _resolve_device(hass, data["device_id"])
        body: dict[str, Any] = {"name": data["name"], "tracking": data["tracking"]}
        if data["tracking"] == "individual":
            if "quantity" not in data or "unit" not in data:
                raise ServiceValidationError(
                    "quantity and unit are required for individual tracking"
                )
            body["quantity"] = float(data["quantity"])
            body["unit"] = str(data["unit"])
        else:
            if "pack_count" not in data or "pack_label" not in data:
                raise ServiceValidationError(
                    "pack_count and pack_label are required for pack tracking"
                )
            body["pack_count"] = int(data["pack_count"])
            body["pack_label"] = str(data["pack_label"])
            body["pack_status"] = data.get("pack_status", "unopened")

        group_entity = data.get("group_entity")
        if group_entity:
            group_coord, group_app_id, group_id = _resolve_group_entity(hass, group_entity)
            if group_coord is not coord or group_app_id != appliance_id:
                raise ServiceValidationError(
                    "Group must belong to the chosen appliance"
                )
            body["group_id"] = group_id

        for optional in ("category", "notes"):
            if data.get(optional):
                body[optional] = data[optional]
        if data.get("expiration_date"):
            body["expiration_date"] = str(data["expiration_date"])

        await coord.async_create_item(appliance_id, body)
        await coord.async_request_refresh()

    async def handle_add_group(call: ServiceCall) -> None:
        data: dict[str, Any] = dict(call.data)
        coord, appliance_id = _resolve_device(hass, data["device_id"])
        body: dict[str, Any] = {
            "name": data["name"],
            "appliance_id": appliance_id,
        }
        if data.get("description"):
            body["description"] = data["description"]
        parent_entity = data.get("parent_group_entity")
        if parent_entity:
            parent_coord, parent_app_id, parent_group_id = _resolve_group_entity(
                hass, parent_entity
            )
            if parent_coord is not coord or parent_app_id != appliance_id:
                raise ServiceValidationError(
                    "Parent group must live in the same appliance"
                )
            body["parent_group_id"] = parent_group_id

        await coord.async_create_group(body)
        await coord.async_request_refresh()

    async def handle_set_quantity(call: ServiceCall) -> None:
        entity_id = call.data["entity_id"]
        if isinstance(entity_id, list):
            entity_id = entity_id[0]
        value = float(call.data["value"])
        coord, appliance_id, item_id = _resolve_item_entity(hass, entity_id)
        item = coord.find_item(item_id) or {}
        if item.get("tracking") == "pack":
            if value != int(value):
                raise ServiceValidationError(
                    "Pack count must be a whole number"
                )
            current = int(item.get("pack_count") or 0)
            delta: float = int(value) - current
        else:
            current = float(item.get("quantity") or 0)
            delta = value - current
        if delta == 0:
            return
        await coord.async_adjust_item(appliance_id, item_id, delta)
        await coord.async_request_refresh()

    async def handle_adjust_quantity(call: ServiceCall) -> None:
        entity_id = call.data["entity_id"]
        if isinstance(entity_id, list):
            entity_id = entity_id[0]
        delta = float(call.data["delta"])
        if delta == 0:
            return
        coord, appliance_id, item_id = _resolve_item_entity(hass, entity_id)
        item = coord.find_item(item_id) or {}
        if item.get("tracking") == "pack" and delta != int(delta):
            raise ServiceValidationError(
                "Pack counts change in whole-pack increments"
            )
        await coord.async_adjust_item(
            appliance_id,
            item_id,
            int(delta) if item.get("tracking") == "pack" else delta,
        )
        await coord.async_request_refresh()

    async def handle_assign_group(call: ServiceCall) -> None:
        entity_id = call.data["entity_id"]
        if isinstance(entity_id, list):
            entity_id = entity_id[0]
        coord, appliance_id, item_id = _resolve_item_entity(hass, entity_id)
        group_entity = call.data.get("group_entity")
        if group_entity:
            group_coord, group_app_id, group_id = _resolve_group_entity(
                hass, group_entity
            )
            if group_coord is not coord or group_app_id != appliance_id:
                raise ServiceValidationError(
                    "Target group must belong to the item's appliance"
                )
            body: dict[str, Any] = {"group_id": group_id}
        else:
            body = {"group_id": None}
        await coord.async_patch_item(appliance_id, item_id, body)
        await coord.async_request_refresh()

    service_schemas = {
        "add_item": vol.Schema(
            {
                vol.Required("device_id"): str,
                vol.Required("name"): str,
                vol.Required("tracking"): vol.In(["individual", "pack"]),
                vol.Optional("quantity"): vol.Coerce(float),
                vol.Optional("unit"): str,
                vol.Optional("pack_count"): vol.Coerce(int),
                vol.Optional("pack_label"): str,
                vol.Optional("pack_status"): vol.In(["opened", "unopened"]),
                vol.Optional("group_entity"): str,
                vol.Optional("category"): str,
                vol.Optional("expiration_date"): str,
                vol.Optional("notes"): str,
            },
            extra=vol.ALLOW_EXTRA,
        ),
        "add_group": vol.Schema(
            {
                vol.Required("device_id"): str,
                vol.Required("name"): str,
                vol.Optional("description"): str,
                vol.Optional("parent_group_entity"): str,
            },
            extra=vol.ALLOW_EXTRA,
        ),
        "set_quantity": vol.Schema(
            {
                vol.Required("entity_id"): vol.Any(str, [str]),
                vol.Required("value"): vol.Coerce(float),
            },
            extra=vol.ALLOW_EXTRA,
        ),
        "adjust_quantity": vol.Schema(
            {
                vol.Required("entity_id"): vol.Any(str, [str]),
                vol.Required("delta"): vol.Coerce(float),
            },
            extra=vol.ALLOW_EXTRA,
        ),
        "assign_group": vol.Schema(
            {
                vol.Required("entity_id"): vol.Any(str, [str]),
                vol.Optional("group_entity"): str,
            },
            extra=vol.ALLOW_EXTRA,
        ),
    }

    hass.services.async_register(
        DOMAIN, "add_item", handle_add_item, schema=service_schemas["add_item"]
    )
    hass.services.async_register(
        DOMAIN, "add_group", handle_add_group, schema=service_schemas["add_group"]
    )
    hass.services.async_register(
        DOMAIN,
        "set_quantity",
        handle_set_quantity,
        schema=service_schemas["set_quantity"],
    )
    hass.services.async_register(
        DOMAIN,
        "adjust_quantity",
        handle_adjust_quantity,
        schema=service_schemas["adjust_quantity"],
    )
    hass.services.async_register(
        DOMAIN,
        "assign_group",
        handle_assign_group,
        schema=service_schemas["assign_group"],
    )
