"""WsClient — WebSocket client transport with auto-reconnect."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable
from urllib.parse import urlencode, urlparse, urlunparse

import websockets
from websockets.exceptions import InvalidStatus

from ..core import (
    DEFAULT_PING_INTERVAL, INITIAL_RECONNECT_DELAY,
    DEFAULT_MAX_RECONNECT_DELAY,
    RpcError, ErrorCode,
)
from .connection import WsConnection

logger = logging.getLogger("viberpc")


class WsClient:
    """WebSocket client transport with auto-reconnect."""

    def __init__(
        self,
        url: str,
        *,
        token: str = "",
        role: str = "web",
        client_id: str = "",
        ping_interval: float = DEFAULT_PING_INTERVAL,
        max_reconnect_delay: float = DEFAULT_MAX_RECONNECT_DELAY,
        auto_reconnect: bool = True,
    ) -> None:
        self.url = url
        self.token = token
        self.role = role
        self.client_id = client_id
        self.ping_interval = ping_interval
        self.max_reconnect_delay = max_reconnect_delay
        self.auto_reconnect = auto_reconnect

        self._conn: WsConnection | None = None
        self._reconnect_delay = INITIAL_RECONNECT_DELAY
        self._closed = False
        self._loop_task: asyncio.Task[None] | None = None

        self.on_open: Callable[[], Any] | None = None
        self.on_close: Callable[[], Any] | None = None
        self.on_message: Callable[[str], Any] | None = None
        self.on_auth_failed: Callable[[], Any] | None = None

    def _build_url(self) -> str:
        params = {}
        if self.token:
            params["token"] = self.token
        if self.role:
            params["role"] = self.role
        if self.client_id:
            params["client_id"] = self.client_id
        if not params:
            return self.url
        parsed = urlparse(self.url)
        sep = "&" if parsed.query else ""
        new_query = parsed.query + sep + urlencode(params) if parsed.query else urlencode(params)
        return urlunparse(parsed._replace(query=new_query))

    @property
    def connected(self) -> bool:
        return self._conn is not None and self._conn.is_open

    async def send(self, raw: str) -> None:
        """Send raw string."""
        if self._conn and self._conn.is_open:
            await self._conn.send(raw)

    async def connect(self, timeout: float = 10.0) -> None:
        """Start connection loop in background. Returns when first connected or raises on failure."""
        self._closed = False
        ready: asyncio.Future[None] = asyncio.get_event_loop().create_future()
        self._loop_task = asyncio.create_task(self._connect_loop(ready))
        await asyncio.wait_for(ready, timeout=timeout)

    async def _connect_loop(self, ready: asyncio.Future[None] | None = None) -> None:
        url = self._build_url()
        while not self._closed:
            try:
                ws = await websockets.connect(url)
                self._conn = WsConnection(ws, ping_interval=self.ping_interval)
                self._reconnect_delay = INITIAL_RECONNECT_DELAY

                # Wire message callback
                self._conn.on_message = self._on_ws_message
                self._conn.on_close = self._on_ws_close

                if ready and not ready.done():
                    ready.set_result(None)
                    ready = None
                if self.on_open:
                    self.on_open()
                logger.info("connected to %s (role=%s)", self.url, self.role)
                await self._conn.serve()

            except InvalidStatus as e:
                if e.response.status_code == 401:
                    logger.error("auth failed: HTTP 401")
                    if ready and not ready.done():
                        ready.set_exception(RpcError(ErrorCode.AUTH_FAILED, "auth failed"))
                        ready = None
                    if self.on_auth_failed:
                        self.on_auth_failed()
                    break
                logger.warning("connection lost: %s", e)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("connection lost: %s", e)
            finally:
                if self.on_close:
                    self.on_close()

            if not self.auto_reconnect or self._closed:
                break
            logger.info("reconnecting in %.1fs...", self._reconnect_delay)
            await asyncio.sleep(self._reconnect_delay)
            self._reconnect_delay = min(self._reconnect_delay * 2, self.max_reconnect_delay)

        if ready and not ready.done():
            ready.set_exception(RpcError(ErrorCode.NOT_CONNECTED, "connection failed"))

    async def disconnect(self) -> None:
        self._closed = True
        if self._conn:
            await self._conn.close()
        if self._loop_task and not self._loop_task.done():
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
            self._loop_task = None

    def _on_ws_message(self, raw: str) -> Any:
        if self.on_message:
            return self.on_message(raw)

    def _on_ws_close(self) -> None:
        # The on_close callback is fired from the connect() loop's finally
        pass
