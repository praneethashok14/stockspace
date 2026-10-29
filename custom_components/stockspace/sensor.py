"""StockSpace sensor platform.

For every appliance we expose a Home Assistant device, and under it:
  * four appliance-level sensors (total items / expiring soon / expired / open packs)
  * one sensor per group showing its item count
  * one sensor per item showing its quantity (or pack count)

The coordinator snapshot is the single source of truth; entities just read
from it, so we don't fan out HTTP requests per entity.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import ATTR_APPLIANCE_ID, ATTR_GROUP_ID, ATTR_ITEM_ID, DOMAIN
from .coordinator import StockSpaceCoordinator

EXPIRING_SOON_DAYS = 7


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: StockSpaceCoordinator = hass.data[DOMAIN][entry.entry_id]
    known: set[str] = set()

    @callback
    def _sync() -> None:
        new_entities: list[SensorEntity] = []
        data = coordinator.data or {}
        for appliance in data.get("appliances", []):
            app_id = appliance["id"]
            for metric in ("total", "expiring", "expired", "open_packs"):
                uid = f"{entry.entry_id}:app:{app_id}:{metric}"
                if uid in known:
                    continue
                known.add(uid)
                new_entities.append(
                    ApplianceMetricSensor(coordinator, entry, appliance, metric, uid)
                )
        for group in data.get("groups", []):
            uid = f"{entry.entry_id}:group:{group['id']}"
            if uid in known:
                continue
            known.add(uid)
            new_entities.append(GroupCountSensor(coordinator, entry, group, uid))
        for item in data.get("items", []):
            uid = f"{entry.entry_id}:item:{item['id']}"
            if uid in known:
                continue
            known.add(uid)
            new_entities.append(ItemQuantitySensor(coordinator, entry, item, uid))
        if new_entities:
            async_add_entities(new_entities)

    _sync()
    entry.async_on_unload(coordinator.async_add_listener(_sync))


def _appliance_device(entry: ConfigEntry, appliance: dict[str, Any]) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, f"{entry.entry_id}:{appliance['id']}")},
        name=appliance.get("name") or "StockSpace appliance",
        manufacturer="StockSpace",
        model=appliance.get("kind") or "appliance",
        configuration_url=None,
    )


def _parse_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s).date()
    except ValueError:
        try:
            return date.fromisoformat(s)
        except ValueError:
            return None


class _Base(CoordinatorEntity[StockSpaceCoordinator], SensorEntity):
    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: StockSpaceCoordinator,
        entry: ConfigEntry,
        uid: str,
    ) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_unique_id = uid


class ApplianceMetricSensor(_Base):
    _attr_state_class = SensorStateClass.MEASUREMENT

    _METRIC_LABELS = {
        "total": "Total items",
        "expiring": "Expiring soon",
        "expired": "Expired",
        "open_packs": "Open packs",
    }

    def __init__(
        self,
        coordinator: StockSpaceCoordinator,
        entry: ConfigEntry,
        appliance: dict[str, Any],
        metric: str,
        uid: str,
    ) -> None:
        super().__init__(coordinator, entry, uid)
        self._appliance_id = appliance["id"]
        self._metric = metric
        self._attr_name = self._METRIC_LABELS[metric]
        self._attr_device_info = _appliance_device(entry, appliance)
        self._attr_extra_state_attributes = {ATTR_APPLIANCE_ID: appliance["id"]}

    @property
    def native_value(self) -> int:
        items = [
            i
            for i in (self.coordinator.data or {}).get("items", [])
            if i.get("appliance_id") == self._appliance_id
        ]
        today = date.today()
        if self._metric == "total":
            return len(items)
        if self._metric == "expiring":
            cutoff = today + timedelta(days=EXPIRING_SOON_DAYS)
            n = 0
            for i in items:
                d = _parse_date(i.get("expiration_date"))
                if d is not None and today <= d <= cutoff:
                    n += 1
            return n
        if self._metric == "expired":
            n = 0
            for i in items:
                d = _parse_date(i.get("expiration_date"))
                if d is not None and d < today:
                    n += 1
            return n
        if self._metric == "open_packs":
            return sum(
                1
                for i in items
                if i.get("tracking") == "pack" and i.get("pack_status") == "opened"
            )
        return 0


class GroupCountSensor(_Base):
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(
        self,
        coordinator: StockSpaceCoordinator,
        entry: ConfigEntry,
        group: dict[str, Any],
        uid: str,
    ) -> None:
        super().__init__(coordinator, entry, uid)
        self._group_id = group["id"]
        self._appliance_id = group["appliance_id"]
        self._attr_name = f"Group · {group.get('name') or 'Unnamed'}"
        appliance = next(
            (
                a
                for a in (coordinator.data or {}).get("appliances", [])
                if a["id"] == group["appliance_id"]
            ),
            {"id": group["appliance_id"], "name": "Appliance"},
        )
        self._attr_device_info = _appliance_device(entry, appliance)
        self._attr_extra_state_attributes = {
            ATTR_APPLIANCE_ID: group["appliance_id"],
            ATTR_GROUP_ID: group["id"],
        }

    @property
    def native_value(self) -> int:
        return sum(
            1
            for i in (self.coordinator.data or {}).get("items", [])
            if i.get("group_id") == self._group_id
        )


class ItemQuantitySensor(_Base):
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(
        self,
        coordinator: StockSpaceCoordinator,
        entry: ConfigEntry,
        item: dict[str, Any],
        uid: str,
    ) -> None:
        super().__init__(coordinator, entry, uid)
        self._item_id = item["id"]
        self._appliance_id = item["appliance_id"]
        self._attr_name = item.get("name") or "Item"
        appliance = next(
            (
                a
                for a in (coordinator.data or {}).get("appliances", [])
                if a["id"] == item["appliance_id"]
            ),
            {"id": item["appliance_id"], "name": "Appliance"},
        )
        self._attr_device_info = _appliance_device(entry, appliance)

    def _item(self) -> dict[str, Any] | None:
        for i in (self.coordinator.data or {}).get("items", []):
            if i.get("id") == self._item_id:
                return i
        return None

    @property
    def native_value(self) -> float | int | None:
        item = self._item()
        if item is None:
            return None
        if item.get("tracking") == "pack":
            return item.get("pack_count")
        return item.get("quantity")

    @property
    def native_unit_of_measurement(self) -> str | None:
        item = self._item()
        if item is None:
            return None
        if item.get("tracking") == "pack":
            return item.get("pack_label")
        return item.get("unit")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        item = self._item() or {}
        attrs: dict[str, Any] = {
            ATTR_APPLIANCE_ID: self._appliance_id,
            ATTR_ITEM_ID: self._item_id,
            "tracking": item.get("tracking"),
        }
        if item.get("group_id"):
            attrs[ATTR_GROUP_ID] = item["group_id"]
        if item.get("expiration_date"):
            attrs["expiration_date"] = item["expiration_date"]
        if item.get("tracking") == "pack":
            attrs["pack_status"] = item.get("pack_status")
        if item.get("category"):
            attrs["category"] = item["category"]
        return attrs

    @property
    def available(self) -> bool:
        return super().available and self._item() is not None
