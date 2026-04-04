"""RpcServer — composes a transport server with per-connection routers."""

from __future__ import annotations

import asyncio
import inspect
import logging
from typing import Any, Awaitable, Callable

from .connection import RpcConnection
from .router import MessageRouter

logger = logging.getLogger("echorpc")

# Server-side handler types — receive conn (the calling connection) as 1st arg
ServerHandler = Callable[..., Awaitable[Any] | Any]
ServerEventCallback = Callable[..., Awaitable[None] | None]
OnConnectCallback = Callable[[RpcConnection], Awaitable[None] | None]
OnDisconnectCallback = Callable[[RpcConnection], Awaitable[None] | None]


class RpcServer:
    """RPC server that composes any ITransportServer with per-connection routers."""

    def __init__(
        self,
        transport: Any,
        *,
        timeout: float = 30.0,
    ) -> None:
        self.transport = transport
        self.timeout = timeout

        self._connections: set[RpcConnection] = set()
        self._global_handlers: dict[str, ServerHandler] = {}
        self._global_subscribers: dict[str, list[ServerEventCallback]] = {}
        self._on_connect_cbs: list[OnConnectCallback] = []
        self._on_disconnect_cbs: list[OnDisconnectCallback] = []

        # Wire transport connection event
        self.transport.on_connection = self._handle_connection

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        await self.transport.start()

    async def stop(self) -> None:
        for conn in list(self._connections):
            await conn.close()
        await self.transport.stop()

    async def serve_forever(self) -> None:
        await self.start()
        await asyncio.Future()  # block forever

    @property
    def address(self) -> tuple[str, int] | None:
        return self.transport.address

    # ── RPC Registration ─────────────────────────────────────────────────

    def register(self, method: str, handler: ServerHandler) -> None:
        if method in MessageRouter.RESERVED_METHODS:
            raise ValueError(f"'{method}' is a reserved method name")
        self._global_handlers[method] = handler

    def unregister(self, method: str) -> None:
        self._global_handlers.pop(method, None)

    def command(self, name: str | None = None) -> Callable:
        """Decorator to register an RPC method."""

        def decorator(fn: ServerHandler) -> ServerHandler:
            method_name = name if name is not None else fn.__name__
            self.register(method_name, fn)
            return fn

        return decorator

    # ── Pub/Sub Registration ─────────────────────────────────────────────

    def subscribe(self, method: str, callback: ServerEventCallback) -> None:
        if method in MessageRouter.RESERVED_METHODS:
            raise ValueError(f"'{method}' is a reserved method name")
        self._global_subscribers.setdefault(method, []).append(callback)

    def unsubscribe(self, method: str, callback: ServerEventCallback) -> None:
        cbs = self._global_subscribers.get(method)
        if cbs and callback in cbs:
            cbs.remove(callback)

    def event(self, name: str | None = None) -> Callable:
        """Decorator to register a notification subscriber."""

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

    async def broadcast(
        self, method: str, params: Any = None, *, role: str | None = None
    ) -> None:
        targets = self.get_connections(role)
        await asyncio.gather(
            *(c.publish(method, params) for c in targets if c.is_open),
            return_exceptions=True,
        )

    async def broadcast_except(
        self, method: str, params: Any = None, *, exclude: RpcConnection | None = None
    ) -> None:
        targets = [c for c in self._connections if c is not exclude and c.is_open]
        await asyncio.gather(
            *(c.publish(method, params) for c in targets), return_exceptions=True
        )

    # ── Internal ─────────────────────────────────────────────────────────

    @staticmethod
    def _wrap_handler(fn: Callable, conn: RpcConnection) -> Callable:
        """Wrap a server handler based on its arity.

        Supports three signature styles:
          - (conn, params) — full access
          - (params,)      — params only
          - ()             — no args
        """
        nparams = len(inspect.signature(fn).parameters)
        if nparams >= 2:
            return lambda params, _h=fn, _c=conn: _h(_c, params)
        elif nparams == 1:
            return lambda params, _h=fn: _h(params)
        else:
            return lambda params, _h=fn: _h()

    async def _handle_connection(
        self, transport_conn: Any, meta: dict[str, Any]
    ) -> None:
        conn = RpcConnection(transport_conn, timeout=self.timeout)
        conn.meta = {**meta}

        # Register global handlers — wrap based on handler arity
        for method, handler in self._global_handlers.items():
            conn.register(method, self._wrap_handler(handler, conn))

        # Register global subscribers — wrap based on callback arity
        for method, callbacks in self._global_subscribers.items():
            for cb in callbacks:
                conn.subscribe(method, self._wrap_handler(cb, conn))

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
