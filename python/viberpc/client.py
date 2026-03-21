"""WebSocket JSON-RPC 2.0 client with auto-reconnect."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Awaitable
from urllib.parse import urlencode, urlparse, urlunparse

import websockets
from websockets.exceptions import InvalidStatus

from .core import (
    RpcError, ErrorCode, DEFAULT_TIMEOUT, DEFAULT_PING_INTERVAL,
    INITIAL_RECONNECT_DELAY, DEFAULT_MAX_RECONNECT_DELAY,
)
from .connection import RpcConnection, Handler, EventCallback

logger = logging.getLogger("viberpc")


class RpcClient:
    """Auto-reconnecting WebSocket JSON-RPC 2.0 client.

    Usage:
        client = RpcClient("ws://localhost:9100", token="secret", role="node")
        client.register("echo", lambda params: params)
        await client.connect()
        result = await client.request("server.method", {"key": "value"})
    """

    def __init__(
        self,
        url: str,
        *,
        token: str = "",
        role: str = "web",
        client_id: str = "",
        timeout: float = DEFAULT_TIMEOUT,
        ping_interval: float = DEFAULT_PING_INTERVAL,
        max_reconnect_delay: float = DEFAULT_MAX_RECONNECT_DELAY,
        auto_reconnect: bool = True,
    ) -> None:
        self.url = url
        self.token = token
        self.role = role
        self.client_id = client_id
        self.timeout = timeout
        self.ping_interval = ping_interval
        self.max_reconnect_delay = max_reconnect_delay
        self.auto_reconnect = auto_reconnect

        self._conn: RpcConnection | None = None
        self._handlers: dict[str, Handler] = {}
        self._subscribers: dict[str, list[EventCallback]] = {}
        self._reconnect_delay = INITIAL_RECONNECT_DELAY
        self._closed = False
        self._connected_event = asyncio.Event()

        self.on_connect: Callable[[], Any] | None = None
        self.on_disconnect: Callable[[], Any] | None = None

    def _build_url(self) -> str:
        """Append auth credentials as URL query parameters."""
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
        # Preserve any existing query string
        sep = "&" if parsed.query else ""
        new_query = parsed.query + sep + urlencode(params) if parsed.query else urlencode(params)
        return urlunparse(parsed._replace(query=new_query))

    @property
    def connected(self) -> bool:
        return self._conn is not None and self._conn.is_open

    async def wait_connected(self, timeout: float = 10.0) -> None:
        await asyncio.wait_for(self._connected_event.wait(), timeout=timeout)

    # ── RPC ──────────────────────────────────────────────────────────────

    def register(self, method: str, handler: Handler) -> None:
        self._handlers[method] = handler
        if self._conn:
            self._conn.register(method, handler)

    def unregister(self, method: str) -> None:
        self._handlers.pop(method, None)
        if self._conn:
            self._conn.unregister(method)

    async def request(self, method: str, params: Any = None, *, timeout: float | None = None) -> Any:
        """Send a JSON-RPC request and wait for the response."""
        if not self._conn or not self._conn.is_open:
            raise RpcError(ErrorCode.NOT_CONNECTED, "not connected")
        return await self._conn.request(method, params, timeout=timeout)

    async def batch_request(
        self,
        calls: list[tuple[str, Any]],
        *,
        timeout: float | None = None,
    ) -> list[Any]:
        """Send a batch of RPC requests. Returns results in request order.

        Each item in *calls* is a ``(method, params)`` tuple.
        If any individual call returns an error, the corresponding element
        in the result list will be an :class:`RpcError` instance.
        """
        if not self._conn or not self._conn.is_open:
            raise RpcError(ErrorCode.NOT_CONNECTED, "not connected")
        return await self._conn.batch_request(calls, timeout=timeout)

    # ── Pub/Sub ──────────────────────────────────────────────────────────

    def subscribe(self, method: str, callback: EventCallback) -> None:
        """Subscribe to incoming notifications with the given method name."""
        self._subscribers.setdefault(method, []).append(callback)
        if self._conn:
            self._conn.subscribe(method, callback)

    def unsubscribe(self, method: str, callback: EventCallback) -> None:
        """Remove a notification subscription."""
        cbs = self._subscribers.get(method)
        if cbs and callback in cbs:
            cbs.remove(callback)
        if self._conn:
            self._conn.unsubscribe(method, callback)

    async def publish(self, method: str, params: Any = None) -> None:
        """Send a JSON-RPC notification (no response expected)."""
        if not self._conn or not self._conn.is_open:
            raise RpcError(ErrorCode.NOT_CONNECTED, "not connected")
        await self._conn.publish(method, params)

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def connect(self) -> None:
        """Connect with auto-reconnect loop. Blocks until closed."""
        self._closed = False
        url = self._build_url()
        while not self._closed:
            try:
                ws = await websockets.connect(url)
                self._conn = RpcConnection(ws, timeout=self.timeout, ping_interval=self.ping_interval)
                self._reconnect_delay = INITIAL_RECONNECT_DELAY

                # Apply registered handlers and subscribers
                for method, handler in self._handlers.items():
                    self._conn.register(method, handler)
                for method, cbs in self._subscribers.items():
                    for cb in cbs:
                        self._conn.subscribe(method, cb)

                self._connected_event.set()
                if self.on_connect:
                    self.on_connect()
                logger.info("connected to %s (role=%s)", self.url, self.role)
                await self._conn.serve()

            except InvalidStatus as e:
                if e.response.status_code == 401:
                    logger.error("auth failed: HTTP 401")
                    break
                logger.warning("connection lost: %s", e)
            except Exception as e:
                logger.warning("connection lost: %s", e)
            finally:
                self._connected_event.clear()
                if self.on_disconnect:
                    self.on_disconnect()

            if not self.auto_reconnect or self._closed:
                break
            logger.info("reconnecting in %.1fs...", self._reconnect_delay)
            await asyncio.sleep(self._reconnect_delay)
            self._reconnect_delay = min(self._reconnect_delay * 2, self.max_reconnect_delay)

    async def disconnect(self) -> None:
        self._closed = True
        if self._conn:
            await self._conn.close()
