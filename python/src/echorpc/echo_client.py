"""EchoClient — convenience class bundling WsClient + RpcClient."""

from __future__ import annotations

from typing import Any, Callable

from .client import RpcClient
from .core import (
    DEFAULT_CONNECT_TIMEOUT,
    DEFAULT_MAX_RECONNECT_DELAY,
    DEFAULT_PING_INTERVAL,
    DEFAULT_PONG_TIMEOUT,
    DEFAULT_REQUEST_TIMEOUT,
    INITIAL_RECONNECT_DELAY,
)
from .router import EventCallback, Handler
from .ws.client import WsClient


class EchoClient:
    """RPC client with built-in WebSocket transport.

    Bundles WsClient and RpcClient into a single class for convenience.
    The underlying ``ws`` and ``rpc`` instances are exposed for advanced use.
    """

    def __init__(
        self,
        url: str,
        *,
        token: str = "",
        role: str = "web",
        client_id: str = "",
        ping_interval: float = DEFAULT_PING_INTERVAL,
        pong_timeout: float = DEFAULT_PONG_TIMEOUT,
        max_reconnect_delay: float = DEFAULT_MAX_RECONNECT_DELAY,
        initial_reconnect_delay: float = INITIAL_RECONNECT_DELAY,
        auto_reconnect: bool = True,
        timeout: float = DEFAULT_REQUEST_TIMEOUT,
    ) -> None:
        self.ws = WsClient(
            url,
            token=token,
            role=role,
            client_id=client_id,
            ping_interval=ping_interval,
            pong_timeout=pong_timeout,
            max_reconnect_delay=max_reconnect_delay,
            initial_reconnect_delay=initial_reconnect_delay,
            auto_reconnect=auto_reconnect,
        )
        self.rpc = RpcClient(self.ws, timeout=timeout)

    # ── Lifecycle ────────────────────────────────────────────────────────

    @property
    def connected(self) -> bool:
        return self.rpc.connected

    @property
    def on_connect(self) -> Callable[[], Any] | None:
        return self.rpc.on_connect

    @on_connect.setter
    def on_connect(self, cb: Callable[[], Any] | None) -> None:
        self.rpc.on_connect = cb

    @property
    def on_disconnect(self) -> Callable[[], Any] | None:
        return self.rpc.on_disconnect

    @on_disconnect.setter
    def on_disconnect(self, cb: Callable[[], Any] | None) -> None:
        self.rpc.on_disconnect = cb

    async def connect(self, timeout: float = DEFAULT_CONNECT_TIMEOUT) -> None:
        await self.rpc.connect(timeout=timeout)

    async def disconnect(self) -> None:
        await self.rpc.disconnect()

    # ── RPC methods ──────────────────────────────────────────────────────

    def register(self, method: str, handler: Handler) -> None:
        self.rpc.register(method, handler)

    def unregister(self, method: str) -> None:
        self.rpc.unregister(method)

    async def request(
        self, method: str, params: Any = None, *, timeout: float | None = None
    ) -> Any:
        return await self.rpc.request(method, params, timeout=timeout)

    async def batch_request(
        self,
        calls: list[tuple[str, Any]],
        *,
        timeout: float | None = None,
    ) -> list[Any]:
        return await self.rpc.batch_request(calls, timeout=timeout)

    # ── Pub/Sub ──────────────────────────────────────────────────────────

    def subscribe(self, method: str, callback: EventCallback) -> None:
        self.rpc.subscribe(method, callback)

    def unsubscribe(self, method: str, callback: EventCallback) -> None:
        self.rpc.unsubscribe(method, callback)

    async def publish(self, method: str, params: Any = None) -> None:
        await self.rpc.publish(method, params)
