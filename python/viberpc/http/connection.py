"""HttpConnection — transport connection over HTTP POST."""

from __future__ import annotations

import uuid
import logging
from typing import Any, Callable

import aiohttp

logger = logging.getLogger("viberpc")


class HttpConnection:
    """Wraps a callback URL for bidirectional HTTP POST RPC."""

    def __init__(self, callback_url: str, connection_id: str | None = None) -> None:
        self.callback_url = callback_url
        self.id = connection_id or uuid.uuid4().hex[:12]
        self._open = True
        self._session: aiohttp.ClientSession | None = None

        self.on_message: Callable[[str], Any] | None = None
        self.on_close: Callable[[], Any] | None = None

    @property
    def is_open(self) -> bool:
        return self._open

    async def send(self, raw: str) -> None:
        """POST raw JSON to the peer's callback URL."""
        if not self._open:
            return
        try:
            if self._session is None:
                self._session = aiohttp.ClientSession()
            async with self._session.post(
                self.callback_url,
                data=raw,
                headers={"Content-Type": "application/json"},
            ) as resp:
                if resp.status >= 400:
                    await self._mark_closed()
        except Exception:
            await self._mark_closed()

    async def close(self) -> None:
        await self._mark_closed()
        if self._session:
            await self._session.close()
            self._session = None

    def deliver_message(self, raw: str) -> Any:
        """Deliver a message from the peer (called by HttpServer)."""
        if self.on_message:
            return self.on_message(raw)

    async def _mark_closed(self) -> None:
        if not self._open:
            return
        self._open = False
        if self._session:
            await self._session.close()
            self._session = None
        if self.on_close:
            self.on_close()
