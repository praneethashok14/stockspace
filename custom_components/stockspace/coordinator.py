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
