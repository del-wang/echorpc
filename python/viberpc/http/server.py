"""HttpServer — HTTP POST transport server."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable, Awaitable

from aiohttp import web

from .connection import HttpConnection

logger = logging.getLogger("viberpc")


class HttpServer:
    """HTTP transport server with /connect, /disconnect, /rpc endpoints."""

    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 9200,
        *,
        auth_handler: Callable[[dict], Awaitable[dict] | dict] | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self.auth_handler = auth_handler

        self._connections: dict[str, HttpConnection] = {}
        self._app: web.Application | None = None
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._actual_port: int | None = None

        self.on_connection: Callable[[HttpConnection, dict[str, Any]], Any] | None = None

    @property
    def address(self) -> tuple[str, int] | None:
        if self._actual_port is not None:
            return (self.host, self._actual_port)
        return None

    async def start(self) -> None:
        self._app = web.Application()
        self._app.router.add_post("/connect", self._handle_connect)
        self._app.router.add_post("/disconnect", self._handle_disconnect)
        self._app.router.add_post("/rpc", self._handle_rpc)

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self.host, self.port)
        await self._site.start()

        # Get actual port
        if self._site._server and self._site._server.sockets:
            self._actual_port = self._site._server.sockets[0].getsockname()[1]
        else:
            self._actual_port = self.port

    async def stop(self) -> None:
        for conn in list(self._connections.values()):
            await conn.close()
        self._connections.clear()
        if self._runner:
            await self._runner.cleanup()
            self._runner = None

    async def _handle_connect(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            return web.Response(status=400, text="Invalid JSON")

        callback_url = data.get("callback_url")
        if not callback_url:
            return web.Response(status=400, text="Missing callback_url")

        meta = {
            "token": data.get("token", ""),
            "role": data.get("role", "web"),
            "client_id": data.get("client_id", ""),
            "authenticated": True,
        }

        if self.auth_handler:
            try:
                result = self.auth_handler(meta)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                return web.Response(status=401, text="Unauthorized")

        conn = HttpConnection(callback_url)
        self._connections[conn.id] = conn

        def on_close():
            self._connections.pop(conn.id, None)
        conn.on_close = on_close

        # Respond first, then fire the connection handler as a background task
        # (RpcServer._handle_connection blocks on conn.serve())
        if self.on_connection:
            asyncio.create_task(self._fire_on_connection(conn, meta))

        return web.json_response({"connection_id": conn.id})

    async def _fire_on_connection(self, conn: HttpConnection, meta: dict[str, Any]) -> None:
        try:
            result = self.on_connection(conn, meta)
            if asyncio.iscoroutine(result):
                await result
        except Exception:
            logger.exception("on_connection handler error")

    async def _handle_disconnect(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            return web.Response(status=400, text="Invalid JSON")

        conn_id = data.get("connection_id")
        conn = self._connections.get(conn_id)
        if conn:
            await conn.close()
            self._connections.pop(conn_id, None)

        return web.Response(text="OK")

    async def _handle_rpc(self, request: web.Request) -> web.Response:
        body = await request.text()
        conn_id = request.query.get("connection_id")

        if not conn_id:
            try:
                data = json.loads(body)
                conn_id = data.get("connection_id")
            except Exception:
                pass

        if not conn_id:
            return web.Response(status=400, text="Missing connection_id")

        conn = self._connections.get(conn_id)
        if not conn:
            return web.Response(status=404, text="Connection not found")

        result = conn.deliver_message(body)
        if asyncio.iscoroutine(result):
            await result

        return web.json_response({"ok": True})
