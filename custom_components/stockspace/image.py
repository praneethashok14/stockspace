"""Image entity: one per item that has a photo."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.image import ImageEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .coordinator import StockSpaceCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: StockSpaceCoordinator = hass.data[DOMAIN][entry.entry_id]
    known: set[str] = set()

    @callback
    def _sync() -> None:
        new_entities: list[ImageEntity] = []
        data = coordinator.data or {}
        for item in data.get("items", []):
            if not item.get("has_photo"):
                continue
            uid = f"{entry.entry_id}:photo:{item['id']}"
            if uid in known:
                continue
            known.add(uid)
            appliance = next(
                (
                    a
                    for a in data.get("appliances", [])
                    if a["id"] == item["appliance_id"]
                ),
                {"id": item["appliance_id"], "name": "Appliance"},
            )
            new_entities.append(StockSpaceItemImage(hass, coordinator, entry, item, appliance, uid))
        if new_entities:
            async_add_entities(new_entities)

    _sync()
    entry.async_on_unload(coordinator.async_add_listener(_sync))


class StockSpaceItemImage(ImageEntity):
    _attr_has_entity_name = True
    _attr_content_type = "image/jpeg"

    def __init__(
        self,
        hass: HomeAssistant,
        coordinator: StockSpaceCoordinator,
        entry: ConfigEntry,
        item: dict[str, Any],
        appliance: dict[str, Any],
        uid: str,
    ) -> None:
        super().__init__(hass)
        self._coordinator = coordinator
        self._entry = entry
        self._item_id = item["id"]
        self._appliance_id = item["appliance_id"]
        self._attr_unique_id = uid
        self._attr_name = f"{item.get('name') or 'Item'} photo"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, f"{entry.entry_id}:{appliance['id']}")},
            name=appliance.get("name") or "StockSpace appliance",
            manufacturer="StockSpace",
            model=appliance.get("kind") or "appliance",
        )
        self._last_updated_at: str | None = item.get("updated_at")
        self._attr_image_last_updated = self._parse_updated(item.get("updated_at"))

    @staticmethod
    def _parse_updated(s: str | None) -> datetime | None:
        if not s:
            return None
        try:
            parsed = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt_util.UTC)
        return parsed

    def _current_item(self) -> dict[str, Any] | None:
        for i in (self._coordinator.data or {}).get("items", []):
            if i.get("id") == self._item_id:
                return i
        return None

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(self._coordinator.async_add_listener(self._handle_coordinator))

    @callback
    def _handle_coordinator(self) -> None:
        item = self._current_item()
        if item and item.get("updated_at") != self._last_updated_at:
            self._last_updated_at = item.get("updated_at")
            self._attr_image_last_updated = self._parse_updated(self._last_updated_at)
            self._cached_image = None
            self.async_write_ha_state()

    async def async_image(self) -> bytes | None:
        return await self._coordinator.async_fetch_photo(
            self._appliance_id, self._item_id
        )

    @property
    def available(self) -> bool:
        item = self._current_item()
        return item is not None and bool(item.get("has_photo"))
