"""WsServer — WebSocket server transport."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable
from urllib.parse import parse_qs, urlparse

import websockets
from websockets.asyncio.server import ServerConnection
from websockets.http11 import Response

from ..core import DEFAULT_PING_INTERVAL
from .connection import WsConnection

logger = logging.getLogger("echorpc")


class WsServer:
    """WebSocket server transport."""

    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 9100,
        *,
        auth_handler: Callable[[dict], Awaitable[dict] | dict] | None = None,
        ping_interval: float = DEFAULT_PING_INTERVAL,
    ) -> None:
        self.host = host
        self.port = port
        self.auth_handler = auth_handler
        self.ping_interval = ping_interval

        self._server: Any = None

        self.on_connection: Callable[[WsConnection, dict[str, Any]], Any] | None = None

    @property
    def address(self) -> tuple[str, int] | None:
        if self._server and self._server.sockets:
            return self._server.sockets[0].getsockname()
        return None

    async def start(self) -> None:
        self._server = await websockets.serve(
            self._handle_connection,
            self.host,
            self.port,
            process_request=self._process_request if self.auth_handler else None,
        )
        logger.info("WS server listening on ws://%s:%d", self.host, self.port)

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    async def _process_request(
        self, connection: ServerConnection, request: Any
    ) -> Response | None:
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

        connection._echorpc_meta = {
            "token": token,
            "role": role,
            "client_id": client_id,
        }
        return None

    async def _handle_connection(self, ws: ServerConnection) -> None:
        conn = WsConnection(ws, ping_interval=self.ping_interval)

        # Read metadata stashed by process_request (or set defaults)
        meta_raw = getattr(ws, "_echorpc_meta", None)
        if meta_raw:
            meta = {**meta_raw, "authenticated": True}
        else:
            parsed = urlparse(ws.request.path)
            qs = parse_qs(parsed.query)
            meta = {
                "token": qs.get("token", [""])[0],
                "role": qs.get("role", ["web"])[0],
                "client_id": qs.get("client_id", [""])[0],
                "authenticated": True,
            }

        if self.on_connection:
            # on_connection handler (RpcServer._handle_connection) awaits conn.serve()
            # which calls transport.serve() — so we don't need to call serve() here.
            result = self.on_connection(conn, meta)
            if asyncio.iscoroutine(result):
                await result
        else:
            # No handler — just run the connection
            await conn.serve()
