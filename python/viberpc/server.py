"""WebSocket JSON-RPC 2.0 server with connection management."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Awaitable

import websockets
from websockets.asyncio.server import ServerConnection

from .core import RpcError, ErrorCode
from .connection import RpcConnection, Handler, EventCallback

logger = logging.getLogger("viberpc")

OnConnectCallback = Callable[[RpcConnection], Awaitable[None] | None]
OnDisconnectCallback = Callable[[RpcConnection], Awaitable[None] | None]


class RpcServer:
    """Production-grade WebSocket JSON-RPC 2.0 server.

    Features:
    - Token + role authentication
    - Connection tagging (node / web / custom)
    - Bidirectional RPC + events
    - Broadcast to role groups
    """

    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 9100,
        *,
        auth_handler: Callable[[dict], Awaitable[dict] | dict] | None = None,
        ping_interval: float = 30.0,
        timeout: float = 30.0,
    ) -> None:
        self.host = host
        self.port = port
        self.auth_handler = auth_handler
        self.ping_interval = ping_interval
        self.timeout = timeout

        self._connections: set[RpcConnection] = set()
        self._global_handlers: dict[str, Handler] = {}
        self._on_connect_cbs: list[OnConnectCallback] = []
        self._on_disconnect_cbs: list[OnDisconnectCallback] = []
        self._server: Any = None

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        self._server = await websockets.serve(
            self._handle_connection,
            self.host,
            self.port,
        )
        logger.info("JSON-RPC server listening on ws://%s:%d", self.host, self.port)

    async def stop(self) -> None:
        for conn in list(self._connections):
            await conn.close()
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    async def serve_forever(self) -> None:
        await self.start()
        await asyncio.Future()  # block forever

    # ── Registration ─────────────────────────────────────────────────────

    def register(self, method: str, handler: Handler) -> None:
        """Register a global RPC method available on all connections."""
        self._global_handlers[method] = handler

    def on_connect(self, cb: OnConnectCallback) -> None:
        self._on_connect_cbs.append(cb)

    def on_disconnect(self, cb: OnDisconnectCallback) -> None:
        self._on_disconnect_cbs.append(cb)

    # ── Connection access ────────────────────────────────────────────────

    def get_connections(self, role: str | None = None) -> list[RpcConnection]:
        if role is None:
            return list(self._connections)
        return [c for c in self._connections if c._meta.get("role") == role]

    # ── Broadcast ────────────────────────────────────────────────────────

    async def broadcast_event(self, event: str, data: Any = None, *, role: str | None = None) -> None:
        targets = self.get_connections(role)
        await asyncio.gather(*(c.emit(event, data) for c in targets if c.is_open), return_exceptions=True)

    async def broadcast_event_except(
        self, event: str, data: Any = None, *, exclude: RpcConnection | None = None
    ) -> None:
        targets = [c for c in self._connections if c is not exclude and c.is_open]
        await asyncio.gather(*(c.emit(event, data) for c in targets), return_exceptions=True)

    # ── Internal ─────────────────────────────────────────────────────────

    async def _handle_connection(self, ws: ServerConnection) -> None:
        conn = RpcConnection(ws, timeout=self.timeout, ping_interval=self.ping_interval)

        # Register global handlers
        for method, handler in self._global_handlers.items():
            conn.register(method, handler)

        # Built-in auth
        conn.register("auth.login", lambda params: self._do_auth(conn, params))

        self._connections.add(conn)

        for cb in self._on_connect_cbs:
            try:
                result = cb(conn)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                logger.exception("on_connect callback error")

        try:
            await conn.serve()
        finally:
            self._connections.discard(conn)
            for cb in self._on_disconnect_cbs:
                try:
                    result = cb(conn)
                    if asyncio.iscoroutine(result):
                        await result
                except Exception:
                    logger.exception("on_disconnect callback error")

    async def _do_auth(self, conn: RpcConnection, params: dict) -> dict:
        if self.auth_handler:
            result = self.auth_handler(params)
            if asyncio.iscoroutine(result):
                result = await result
        else:
            result = {"ok": True}

        token = params.get("token", "")
        role = params.get("role", "web")
        client_id = params.get("client_id", "")

        conn._meta["token"] = token
        conn._meta["role"] = role
        conn._meta["client_id"] = client_id
        conn._meta["authenticated"] = True

        logger.info("client authenticated: role=%s client_id=%s", role, client_id)
        return result
