"""RpcClient — composes a MessageRouter with a transport client."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable

from .core import RpcError, ErrorCode, DEFAULT_TIMEOUT
from .router import MessageRouter, Handler, EventCallback

logger = logging.getLogger("viberpc")


class RpcClient:
    """RPC client that composes a MessageRouter with any ITransportClient."""

    def __init__(
        self,
        transport: Any,
        *,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.transport = transport
        self._handlers: dict[str, Handler] = {}
        self._subscribers: dict[str, list[EventCallback]] = {}
        self._timeout = timeout

        self.router = MessageRouter(
            lambda raw: self.transport.send(raw),
            timeout=timeout,
        )

        # Wire pong callback to transport
        self.router.on_pong = self._on_pong

        self.on_connect: Callable[[], Any] | None = None
        self.on_disconnect: Callable[[], Any] | None = None

        # Wire transport events
        self.transport.on_message = self._on_message
        self.transport.on_open = self._on_open
        self.transport.on_close = self._on_close

    @property
    def connected(self) -> bool:
        return self.transport.connected

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def connect(self, timeout: float = 10.0) -> None:
        await self.transport.connect(timeout=timeout)

    async def disconnect(self) -> None:
        await self.transport.disconnect()
        self.router.close()

    # ── RPC methods (delegate to router) ────────────────────────────────

    def register(self, method: str, handler: Handler) -> None:
        self._handlers[method] = handler
        self.router.register(method, handler)

    def unregister(self, method: str) -> None:
        self._handlers.pop(method, None)
        self.router.unregister(method)

    async def request(self, method: str, params: Any = None, *, timeout: float | None = None) -> Any:
        if not self.connected:
            raise RpcError(ErrorCode.NOT_CONNECTED, "not connected")
        return await self.router.request(method, params, timeout=timeout)

    async def batch_request(
        self,
        calls: list[tuple[str, Any]],
        *,
        timeout: float | None = None,
    ) -> list[Any]:
        if not self.connected:
            raise RpcError(ErrorCode.NOT_CONNECTED, "not connected")
        return await self.router.batch_request(calls, timeout=timeout)

    # ── Pub/Sub (delegate to router) ────────────────────────────────────

    def subscribe(self, method: str, callback: EventCallback) -> None:
        self._subscribers.setdefault(method, []).append(callback)
        self.router.subscribe(method, callback)

    def unsubscribe(self, method: str, callback: EventCallback) -> None:
        cbs = self._subscribers.get(method)
        if cbs and callback in cbs:
            cbs.remove(callback)
        self.router.unsubscribe(method, callback)

    async def publish(self, method: str, params: Any = None) -> None:
        if not self.connected:
            raise RpcError(ErrorCode.NOT_CONNECTED, "not connected")
        await self.router.publish(method, params)

    # ── Transport event handlers ────────────────────────────────────────

    def _on_message(self, raw: str) -> Any:
        return self.router.dispatch_message(raw)

    def _on_open(self) -> None:
        # Reset router closed state on reconnect (handlers/subscribers persist)
        self.router.reopen()
        if self.on_connect:
            self.on_connect()

    def _on_close(self) -> None:
        if self.on_disconnect:
            self.on_disconnect()

    def _on_pong(self) -> None:
        if hasattr(self.transport, "refresh_pong"):
            self.transport.refresh_pong()
