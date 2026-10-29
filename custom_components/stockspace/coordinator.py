"""DataUpdateCoordinator for StockSpace."""

from __future__ import annotations

from datetime import timedelta
import logging
from typing import Any

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    CONF_API_TOKEN,
    CONF_BASE_URL,
    DEFAULT_SCAN_INTERVAL_SECONDS,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)


class StockSpaceCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Polls /api/items to pull the full inventory snapshot."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}:{entry.entry_id}",
            update_interval=timedelta(seconds=DEFAULT_SCAN_INTERVAL_SECONDS),
        )
        self.entry = entry
        self._base_url: str = entry.data[CONF_BASE_URL].rstrip("/")
        self._token: str = entry.data[CONF_API_TOKEN]
        self._session: aiohttp.ClientSession = async_get_clientsession(hass)

    @property
    def base_url(self) -> str:
        return self._base_url

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/json",
        }

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            async with self._session.get(
                f"{self._base_url}/api/items",
                headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=20),
            ) as resp:
                if resp.status == 401:
                    raise UpdateFailed("Unauthorized — check the StockSpace API token")
                if resp.status >= 400:
                    raise UpdateFailed(f"StockSpace API returned {resp.status}")
                return await resp.json()
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Error talking to StockSpace: {err}") from err

    async def async_fetch_photo(self, appliance_id: str, item_id: str) -> bytes | None:
        """Fetch the JPEG bytes for one item, or None if there isn't one."""
        url = f"{self._base_url}/api/appliances/{appliance_id}/items/{item_id}/photo"
        try:
            async with self._session.get(
                url,
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=aiohttp.ClientTimeout(total=20),
            ) as resp:
                if resp.status == 404:
                    return None
                if resp.status >= 400:
                    _LOGGER.warning("Photo fetch failed: %s", resp.status)
                    return None
                return await resp.read()
        except aiohttp.ClientError as err:
            _LOGGER.warning("Photo fetch error: %s", err)
            return None

    async def _request_json(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        headers = dict(self._headers())
        if body is not None:
            headers["Content-Type"] = "application/json"
        try:
            async with self._session.request(
                method,
                f"{self._base_url}{path}",
                headers=headers,
                json=body,
                timeout=aiohttp.ClientTimeout(total=20),
            ) as resp:
                text = await resp.text()
                if resp.status >= 400:
                    raise UpdateFailed(
                        f"StockSpace {method} {path} -> {resp.status}: {text[:200]}"
                    )
                if not text:
                    return {}
                try:
                    return await resp.json(content_type=None)
                except Exception:  # noqa: BLE001
                    return {}
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Error talking to StockSpace: {err}") from err

    def find_item(self, item_id: str) -> dict[str, Any] | None:
        for i in (self.data or {}).get("items", []):
            if i.get("id") == item_id:
                return i
        return None

    async def async_create_item(
        self, appliance_id: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._request_json(
            "POST", f"/api/appliances/{appliance_id}/items", body
        )

    async def async_create_group(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._request_json("POST", "/api/groups", body)

    async def async_patch_item(
        self, appliance_id: str, item_id: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._request_json(
            "PATCH", f"/api/appliances/{appliance_id}/items/{item_id}", body
        )

    async def async_adjust_item(
        self, appliance_id: str, item_id: str, delta: float
    ) -> dict[str, Any]:
        return await self._request_json(
            "POST",
            f"/api/appliances/{appliance_id}/items/{item_id}/adjust",
            {"delta": delta},
        )
