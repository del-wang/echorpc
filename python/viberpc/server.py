"""WebSocket JSON-RPC 2.0 server with connection management."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Awaitable
from urllib.parse import urlparse, parse_qs

import websockets
from websockets.asyncio.server import ServerConnection
from websockets.http11 import Response

from .connection import RpcConnection

logger = logging.getLogger("viberpc")

# Server-side handler types — receive conn (the calling connection) as 1st arg
ServerHandler = Callable[..., Awaitable[Any] | Any]
ServerEventCallback = Callable[..., Awaitable[None] | None]
OnConnectCallback = Callable[[RpcConnection], Awaitable[None] | None]
OnDisconnectCallback = Callable[[RpcConnection], Awaitable[None] | None]


class RpcServer:
    """Production-grade WebSocket JSON-RPC 2.0 server.

    Features:
    - Token + role authentication
    - Connection tagging (node / web / custom)
    - Bidirectional RPC + pub/sub notifications
    - Broadcast to role groups

    Server-side handlers receive ``(conn, params)`` where ``conn`` is the
    :class:`RpcConnection` that made the call / published the notification::

        server.register("echo", lambda conn, params: params)
        server.subscribe("chat.message", lambda conn, data: ...)

    Decorators are also available for cleaner registration::

        @server.method("echo")
        def echo(conn, params):
            return params

        @server.subscription("chat.message")
        async def on_chat(conn, data):
            await server.broadcast_except("chat.message", data, exclude=conn)
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
        self._global_handlers: dict[str, ServerHandler] = {}
        self._global_subscribers: dict[str, list[ServerEventCallback]] = {}
        self._on_connect_cbs: list[OnConnectCallback] = []
        self._on_disconnect_cbs: list[OnDisconnectCallback] = []
        self._server: Any = None

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        self._server = await websockets.serve(
            self._handle_connection,
            self.host,
            self.port,
            process_request=self._process_request if self.auth_handler else None,
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

    # ── RPC Registration ─────────────────────────────────────────────────

    def register(self, method: str, handler: ServerHandler) -> None:
        """Register a global RPC method. Handler signature: ``(conn, params)``.

        ``conn`` is the :class:`RpcConnection` that made the call, allowing
        you to call/publish back to that specific client::

            server.register("greet", lambda conn, params: f"hello {conn.meta['role']}")
        """
        self._global_handlers[method] = handler

    def unregister(self, method: str) -> None:
        self._global_handlers.pop(method, None)

    def method(self, name: str | None = None) -> Callable:
        """Decorator to register an RPC method::

            @server.method("echo")
            def echo(conn, params):
                return params

            # Or use function name:
            @server.method()
            def echo(conn, params):
                return params
        """
        def decorator(fn: ServerHandler) -> ServerHandler:
            method_name = name if name is not None else fn.__name__
            self.register(method_name, fn)
            return fn
        return decorator

    # ── Pub/Sub Registration ─────────────────────────────────────────────

    def subscribe(self, method: str, callback: ServerEventCallback) -> None:
        """Subscribe to notifications from clients. Callback: ``(conn, data)``::

            server.subscribe("chat.message", lambda conn, data: ...)
        """
        self._global_subscribers.setdefault(method, []).append(callback)

    def unsubscribe(self, method: str, callback: ServerEventCallback) -> None:
        cbs = self._global_subscribers.get(method)
        if cbs and callback in cbs:
            cbs.remove(callback)

    def subscription(self, name: str | None = None) -> Callable:
        """Decorator to register a notification subscriber::

            @server.subscription("chat.message")
            async def on_chat(conn, data):
                await server.broadcast_except("chat.message", data, exclude=conn)

            # Or use function name:
            @server.subscription()
            async def chat_message(conn, data):
                ...
        """
        def decorator(fn: ServerEventCallback) -> ServerEventCallback:
            sub_name = name if name is not None else fn.__name__
            self.subscribe(sub_name, fn)
            return fn
        return decorator

    # ── Lifecycle hooks ──────────────────────────────────────────────────

    def on_connect(self, cb: OnConnectCallback) -> None:
        self._on_connect_cbs.append(cb)

    def on_disconnect(self, cb: OnDisconnectCallback) -> None:
        self._on_disconnect_cbs.append(cb)

    # ── Connection access ────────────────────────────────────────────────

    def get_connections(self, role: str | None = None) -> list[RpcConnection]:
        if role is None:
            return list(self._connections)
        return [c for c in self._connections if c.meta.get("role") == role]

    # ── Broadcast ────────────────────────────────────────────────────────

    async def broadcast(self, method: str, params: Any = None, *, role: str | None = None) -> None:
        """Publish a notification to all (or role-filtered) connections."""
        targets = self.get_connections(role)
        await asyncio.gather(
            *(c.publish(method, params) for c in targets if c.is_open),
            return_exceptions=True,
        )

    async def broadcast_except(
        self, method: str, params: Any = None, *, exclude: RpcConnection | None = None
    ) -> None:
        """Publish a notification to all connections except *exclude*."""
        targets = [c for c in self._connections if c is not exclude and c.is_open]
        await asyncio.gather(*(c.publish(method, params) for c in targets), return_exceptions=True)

    # ── Internal ─────────────────────────────────────────────────────────

    async def _process_request(self, connection: ServerConnection, request: Any) -> Response | None:
        """Validate auth during the HTTP upgrade handshake."""
        parsed = urlparse(request.path)
        qs = parse_qs(parsed.query)
        token = qs.get("token", [""])[0]
        role = qs.get("role", ["web"])[0]
        client_id = qs.get("client_id", [""])[0]

        auth_params = {"token": token, "role": role, "client_id": client_id}
        try:
            result = self.auth_handler(auth_params)
            if asyncio.iscoroutine(result):
                result = await result
        except Exception:
            return connection.respond(401, "Unauthorized\n")

        # Stash metadata on the raw connection for _handle_connection to pick up
        connection._viberpc_meta = {"token": token, "role": role, "client_id": client_id}
        return None

    async def _handle_connection(self, ws: ServerConnection) -> None:
        conn = RpcConnection(ws, timeout=self.timeout, ping_interval=self.ping_interval)

        # Read metadata stashed by process_request (or set defaults)
        meta = getattr(ws, "_viberpc_meta", None)
        if meta:
            conn.meta.update(meta)
            conn.meta["authenticated"] = True
        else:
            # No auth_handler — parse query params for metadata only
            parsed = urlparse(ws.request.path)
            qs = parse_qs(parsed.query)
            conn.meta["token"] = qs.get("token", [""])[0]
            conn.meta["role"] = qs.get("role", ["web"])[0]
            conn.meta["client_id"] = qs.get("client_id", [""])[0]
            conn.meta["authenticated"] = True

        # Register global handlers — wrap to inject conn as 1st arg
        for method, handler in self._global_handlers.items():
            conn.register(method, lambda params, _h=handler, _c=conn: _h(_c, params))

        # Register global subscribers — wrap to inject conn as 1st arg
        for method, callbacks in self._global_subscribers.items():
            for cb in callbacks:
                conn.subscribe(method, lambda data, _cb=cb, _c=conn: _cb(_c, data))

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
