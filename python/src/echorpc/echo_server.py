"""EchoServer — convenience class bundling WsServer + RpcServer."""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from .connection import RpcConnection
from .core import DEFAULT_PING_INTERVAL, DEFAULT_PONG_TIMEOUT, DEFAULT_REQUEST_TIMEOUT
from .server import RpcServer, ServerEventCallback, ServerHandler
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
        self.rpc = RpcServer(self.ws, timeout=timeout)

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        await self.rpc.start()

    async def stop(self) -> None:
        await self.rpc.stop()

    async def serve_forever(self) -> None:
        await self.rpc.serve_forever()

    @property
    def address(self) -> tuple[str, int] | None:
        return self.rpc.address

    # ── RPC Registration ─────────────────────────────────────────────────

    def register(self, method: str, handler: ServerHandler) -> None:
        self.rpc.register(method, handler)

    def unregister(self, method: str) -> None:
        self.rpc.unregister(method)

    def method(self, name: str | None = None) -> Callable:
        return self.rpc.method(name)

    # ── Pub/Sub Registration ─────────────────────────────────────────────

    def subscribe(self, method: str, callback: ServerEventCallback) -> None:
        self.rpc.subscribe(method, callback)

    def unsubscribe(self, method: str, callback: ServerEventCallback) -> None:
        self.rpc.unsubscribe(method, callback)

    def subscription(self, name: str | None = None) -> Callable:
        return self.rpc.subscription(name)

    # ── Lifecycle hooks ──────────────────────────────────────────────────

    def on_connect(self, cb: Callable[[RpcConnection], Awaitable[None] | None]) -> None:
        self.rpc.on_connect(cb)

    def on_disconnect(self, cb: Callable[[RpcConnection], Awaitable[None] | None]) -> None:
        self.rpc.on_disconnect(cb)

    # ── Connection access ────────────────────────────────────────────────

    def get_connections(self, role: str | None = None) -> list[RpcConnection]:
        return self.rpc.get_connections(role)

    # ── Broadcast ────────────────────────────────────────────────────────

    async def broadcast(
        self, method: str, params: Any = None, *, role: str | None = None
    ) -> None:
        await self.rpc.broadcast(method, params, role=role)

    async def broadcast_except(
        self, method: str, params: Any = None, *, exclude: RpcConnection | None = None
    ) -> None:
        await self.rpc.broadcast_except(method, params, exclude=exclude)
