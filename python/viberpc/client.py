"""WebSocket JSON-RPC 2.0 client with auto-reconnect."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Awaitable

import websockets

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
        result = await client.call("server.method", {"key": "value"})
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
        self._event_listeners: dict[str, list[EventCallback]] = {}
        self._reconnect_delay = INITIAL_RECONNECT_DELAY
        self._closed = False
        self._connected_event = asyncio.Event()

        self.on_connect: Callable[[], Any] | None = None
        self.on_disconnect: Callable[[], Any] | None = None

    @property
    def connected(self) -> bool:
        return self._conn is not None and self._conn.is_open

    async def wait_connected(self, timeout: float = 10.0) -> None:
        await asyncio.wait_for(self._connected_event.wait(), timeout=timeout)

    # ── RPC ─────────────────────────────────────────────────────

    def register(self, method: str, handler: Handler) -> None:
        self._handlers[method] = handler
        if self._conn:
            self._conn.register(method, handler)
            
    def unregister(self, method: str) -> None:
        self._handlers.pop(method, None)
        if self._conn:
            self._conn.unregister(method)
            
    async def call(self, method: str, params: Any = None, *, timeout: float | None = None) -> Any:
        if not self._conn or not self._conn.is_open:
            raise RpcError(ErrorCode.NOT_CONNECTED, "not connected")
        return await self._conn.call(method, params, timeout=timeout)

    # ── RPC ──────────────────────────────────────────────────────────────

    def on(self, event: str, callback: EventCallback) -> None:
        self._event_listeners.setdefault(event, []).append(callback)
        if self._conn:
            self._conn.on(event, callback)

    def off(self, event: str, callback: EventCallback) -> None:
        cbs = self._event_listeners.get(event)
        if cbs and callback in cbs:
            cbs.remove(callback)
        if self._conn:
            self._conn.off(event, callback)

    async def emit(self, event: str, data: Any = None) -> None:
        if not self._conn or not self._conn.is_open:
            raise RpcError(ErrorCode.NOT_CONNECTED, "not connected")
        await self._conn.emit(event, data)

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def connect(self) -> None:
        """Connect with auto-reconnect loop. Blocks until closed."""
        self._closed = False
        while not self._closed:
            try:
                ws = await websockets.connect(self.url)
                self._conn = RpcConnection(ws, timeout=self.timeout, ping_interval=self.ping_interval)
                self._reconnect_delay = INITIAL_RECONNECT_DELAY

                # Apply registered handlers and listeners
                for method, handler in self._handlers.items():
                    self._conn.register(method, handler)
                for event, cbs in self._event_listeners.items():
                    for cb in cbs:
                        self._conn.on(event, cb)

                # Authenticate
                if self.token:
                    auth_params = {"token": self.token, "role": self.role}
                    if self.client_id:
                        auth_params["client_id"] = self.client_id
                    # We need to start serve() in background to handle auth response
                    serve_task = asyncio.create_task(self._conn.serve())
                    try:
                        await self._conn.call("auth.login", auth_params)
                    except Exception as e:
                        logger.error("auth failed: %s", e)
                        serve_task.cancel()
                        await self._conn.close()
                        raise

                    self._connected_event.set()
                    if self.on_connect:
                        self.on_connect()
                    logger.info("connected to %s (role=%s)", self.url, self.role)
                    await serve_task
                else:
                    self._connected_event.set()
                    if self.on_connect:
                        self.on_connect()
                    logger.info("connected to %s", self.url)
                    await self._conn.serve()

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
