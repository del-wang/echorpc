from __future__ import annotations

from typing import Any, Awaitable, Callable

from .client import RpcClient
from .connection import RpcConnection
from .core import (
    DEFAULT_CONNECT_TIMEOUT,
    DEFAULT_MAX_RECONNECT_DELAY,
    DEFAULT_PING_INTERVAL,
    DEFAULT_PONG_TIMEOUT,
    DEFAULT_REQUEST_TIMEOUT,
    INITIAL_RECONNECT_DELAY,
)
from .router import EventCallback, Handler
from .server import RpcServer, ServerEventCallback, ServerHandler
from .ws.client import WsClient
from .ws.server import WsServer


class EchoServer:
    """RPC server with built-in WebSocket transport.

    Bundles WsServer and RpcServer into a single class for convenience.
    The underlying ``ws`` and ``rpc`` instances are exposed for advanced use.
    """

    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 9100,
        *,
        auth_handler: Callable[[dict], Awaitable[bool | dict] | bool | dict]
        | None = None,
        ping_interval: float = DEFAULT_PING_INTERVAL,
        pong_timeout: float = DEFAULT_PONG_TIMEOUT,
        timeout: float = DEFAULT_REQUEST_TIMEOUT,
    ) -> None:
        self.ws = WsServer(
            host,
            port,
            auth_handler=auth_handler,
            ping_interval=ping_interval,
            pong_timeout=pong_timeout,
        )
        self.core = RpcServer(self.ws, timeout=timeout)

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        await self.core.start()

    async def stop(self) -> None:
        await self.core.stop()

    async def serve_forever(self) -> None:
        await self.core.serve_forever()

    @property
    def address(self) -> tuple[str, int] | None:
        return self.core.address

    # ── RPC Registration ─────────────────────────────────────────────────

    def register(self, method: str, handler: ServerHandler) -> None:
        self.core.register(method, handler)

    def unregister(self, method: str) -> None:
        self.core.unregister(method)

    def command(self, name: str | None = None) -> Callable:
        return self.core.command(name)

    # ── Pub/Sub Registration ─────────────────────────────────────────────

    def subscribe(self, method: str, callback: ServerEventCallback) -> None:
        self.core.subscribe(method, callback)

    def unsubscribe(self, method: str, callback: ServerEventCallback) -> None:
        self.core.unsubscribe(method, callback)

    def event(self, name: str | None = None) -> Callable:
        return self.core.event(name)

    # ── Lifecycle hooks ──────────────────────────────────────────────────

    def on_connect(self, cb: Callable[[RpcConnection], Awaitable[None] | None]) -> None:
        self.core.on_connect(cb)

    def on_disconnect(
        self, cb: Callable[[RpcConnection], Awaitable[None] | None]
    ) -> None:
        self.core.on_disconnect(cb)

    # ── Connection access ────────────────────────────────────────────────

    def get_connections(self, role: str | None = None) -> list[RpcConnection]:
        return self.core.get_connections(role)

    # ── Broadcast ────────────────────────────────────────────────────────

    async def broadcast(
        self, method: str, params: Any = None, *, role: str | None = None
    ) -> None:
        await self.core.broadcast(method, params, role=role)

    async def broadcast_except(
        self, method: str, params: Any = None, *, exclude: RpcConnection | None = None
    ) -> None:
        await self.core.broadcast_except(method, params, exclude=exclude)


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
        self.core = RpcClient(self.ws, timeout=timeout)

    # ── Lifecycle ────────────────────────────────────────────────────────

    @property
    def connected(self) -> bool:
        return self.core.connected

    @property
    def on_connect(self) -> Callable[[], Any] | None:
        return self.core.on_connect

    @on_connect.setter
    def on_connect(self, cb: Callable[[], Any] | None) -> None:
        self.core.on_connect = cb

    @property
    def on_disconnect(self) -> Callable[[], Any] | None:
        return self.core.on_disconnect

    @on_disconnect.setter
    def on_disconnect(self, cb: Callable[[], Any] | None) -> None:
        self.core.on_disconnect = cb

    async def connect(self, timeout: float = DEFAULT_CONNECT_TIMEOUT) -> None:
        await self.core.connect(timeout=timeout)

    async def disconnect(self) -> None:
        await self.core.disconnect()

    # ── RPC methods ──────────────────────────────────────────────────────

    def register(self, method: str, handler: Handler) -> None:
        self.core.register(method, handler)

    def unregister(self, method: str) -> None:
        self.core.unregister(method)

    async def request(
        self, method: str, params: Any = None, *, timeout: float | None = None
    ) -> Any:
        return await self.core.request(method, params, timeout=timeout)

    async def batch_request(
        self,
        calls: list[tuple[str, Any]],
        *,
        timeout: float | None = None,
    ) -> list[Any]:
        return await self.core.batch_request(calls, timeout=timeout)

    # ── Pub/Sub ──────────────────────────────────────────────────────────

    def subscribe(self, method: str, callback: EventCallback) -> None:
        self.core.subscribe(method, callback)

    def unsubscribe(self, method: str, callback: EventCallback) -> None:
        self.core.unsubscribe(method, callback)

    async def publish(self, method: str, params: Any = None) -> None:
        await self.core.publish(method, params)
