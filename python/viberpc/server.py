"""WebSocket JSON-RPC 2.0 server with connection management."""

from __future__ import annotations

import asyncio
import inspect
import logging
from typing import Any, Callable, Awaitable

import websockets
from websockets.asyncio.server import ServerConnection

from .core import RpcError, ErrorCode
from .connection import RpcConnection, Handler, EventCallback

logger = logging.getLogger("viberpc")

# Server-side handler types — receive conn (the calling connection) as 2nd arg
ServerHandler = Callable[..., Awaitable[Any] | Any]
ServerEventCallback = Callable[..., Awaitable[None] | None]
OnConnectCallback = Callable[[RpcConnection], Awaitable[None] | None]
OnDisconnectCallback = Callable[[RpcConnection], Awaitable[None] | None]


class RpcServer:
    """Production-grade WebSocket JSON-RPC 2.0 server.

    Features:
    - Token + role authentication
    - Connection tagging (node / web / custom)
    - Bidirectional RPC + events
    - Broadcast to role groups

    Server-side handlers receive ``(params, conn)`` where ``conn`` is the
    :class:`RpcConnection` that made the call / emitted the event::

        server.register("echo", lambda params, conn: params)
        server.on("chat.message", lambda data, conn: ...)

    Decorators are also available for cleaner registration::

        @server.method("echo")
        def echo(params, conn):
            return params

        @server.event("chat.message")
        async def on_chat(data, conn):
            await server.broadcast_event_except("chat.message", data, exclude=conn)
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
        self._global_event_listeners: dict[str, list[ServerEventCallback]] = {}
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

    def register(self, method: str, handler: ServerHandler) -> None:
        """Register a global RPC method. Handler signature: ``(params, conn)``.

        ``conn`` is the :class:`RpcConnection` that made the call, allowing
        you to call/emit back to that specific client::

            server.register("greet", lambda params, conn: f"hello {conn.meta['role']}")
        """
        self._global_handlers[method] = handler

    def unregister(self, method: str) -> None:
        self._global_handlers.pop(method, None)

    def method(self, name: str | None = None) -> Callable:
        """Decorator to register an RPC method::

            @server.method("echo")
            def echo(params, conn):
                return params

            # Or use function name:
            @server.method()
            def echo(params, conn):
                return params
        """
        def decorator(fn: ServerHandler) -> ServerHandler:
            method_name = name if name is not None else fn.__name__
            self.register(method_name, fn)
            return fn
        return decorator

    def on(self, event: str, callback: ServerEventCallback) -> None:
        """Listen for events emitted by clients. Callback: ``(data, conn)``::

            server.on("chat.message", lambda data, conn: ...)
        """
        self._global_event_listeners.setdefault(event, []).append(callback)

    def off(self, event: str, callback: ServerEventCallback) -> None:
        cbs = self._global_event_listeners.get(event)
        if cbs and callback in cbs:
            cbs.remove(callback)

    def event(self, name: str | None = None) -> Callable:
        """Decorator to register an event listener::

            @server.event("chat.message")
            async def on_chat(data, conn):
                await server.broadcast_event_except("chat.message", data, exclude=conn)

            # Or use function name:
            @server.event()
            async def chat_message(data, conn):
                ...
        """
        def decorator(fn: ServerEventCallback) -> ServerEventCallback:
            event_name = name if name is not None else fn.__name__
            self.on(event_name, fn)
            return fn
        return decorator

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

        # Register global handlers — wrap to inject conn
        for method, handler in self._global_handlers.items():
            conn.register(method, lambda params, _h=handler, _c=conn: _h(params, _c))

        # Register global event listeners — wrap to inject conn
        for event, callbacks in self._global_event_listeners.items():
            for cb in callbacks:
                conn.on(event, lambda data, _cb=cb, _c=conn: _cb(data, _c))

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

        conn.meta["token"] = token
        conn.meta["role"] = role
        conn.meta["client_id"] = client_id
        conn.meta["authenticated"] = True

        logger.info("client authenticated: role=%s client_id=%s", role, client_id)
        return result
