"""RpcConnection — composes a MessageRouter with a transport connection."""

from __future__ import annotations

import asyncio
from typing import Any

from .core import DEFAULT_REQUEST_TIMEOUT
from .router import EventCallback, Handler, MessageRouter


class RpcConnection:
    """Wraps a transport connection and provides bidirectional JSON-RPC 2.0."""

    def __init__(
        self,
        transport: Any,
        *,
        timeout: float = DEFAULT_REQUEST_TIMEOUT,
    ) -> None:
        self.transport = transport
        self.meta: dict[str, Any] = {}
        self._close_event = asyncio.Event()

        self.router = MessageRouter(
            lambda raw: self.transport.send(raw),
            timeout=timeout,
        )

        # Wire pong callback to transport
        self.router.on_pong = self._on_pong

    @property
    def is_open(self) -> bool:
        return self.transport.is_open

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def serve(self) -> None:
        """Start message loop. Blocks until connection closes."""
        self.transport.on_message = self._on_message
        self.transport.on_close = self._on_close

        # If transport has serve() (e.g. WsConnection), use it to block
        if hasattr(self.transport, "serve"):
            await self.transport.serve()
        else:
            # For transports without serve() (e.g. HTTP), wait for close event
            await self._close_event.wait()

    async def close(self) -> None:
        self.router.close()
        await self.transport.close()

    def _on_message(self, raw: str) -> Any:
        return self.router.dispatch_message(raw)

    def _on_close(self) -> None:
        self.router.close()
        self._close_event.set()

    def _on_pong(self) -> None:
        if hasattr(self.transport, "refresh_pong"):
            self.transport.refresh_pong()

    # ── RPC methods (delegate to router) ────────────────────────────────

    def register(self, method: str, handler: Handler) -> None:
        self.router.register(method, handler)

    def unregister(self, method: str) -> None:
        self.router.unregister(method)

    async def request(
        self, method: str, params: Any = None, *, timeout: float | None = None
    ) -> Any:
        return await self.router.request(method, params, timeout=timeout)

    async def batch_request(
        self,
        calls: list[tuple[str, Any]],
        *,
        timeout: float | None = None,
    ) -> list[Any]:
        return await self.router.batch_request(calls, timeout=timeout)

    # ── Pub/Sub (delegate to router) ────────────────────────────────────

    async def publish(self, method: str, params: Any = None) -> None:
        await self.router.publish(method, params)

    def subscribe(self, method: str, callback: EventCallback) -> None:
        self.router.subscribe(method, callback)

    def unsubscribe(self, method: str, callback: EventCallback) -> None:
        self.router.unsubscribe(method, callback)
