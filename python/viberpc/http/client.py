"""HttpClient — HTTP POST transport client."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable

from aiohttp import web
import aiohttp

from ..core import RpcError, ErrorCode

logger = logging.getLogger("viberpc")


class HttpClient:
    """HTTP transport client with local callback server for bidirectional RPC."""

    def __init__(
        self,
        server_url: str,
        *,
        token: str = "",
        role: str = "web",
        client_id: str = "",
        callback_host: str = "127.0.0.1",
        callback_port: int = 0,
    ) -> None:
        self.server_url = server_url
        self.token = token
        self.role = role
        self.client_id = client_id
        self.callback_host = callback_host
        self.callback_port = callback_port

        self._connected = False
        self._connection_id: str | None = None
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._session: aiohttp.ClientSession | None = None
        self._callback_url: str | None = None
        self._connected_event = asyncio.Event()

        self.on_open: Callable[[], Any] | None = None
        self.on_close: Callable[[], Any] | None = None
        self.on_message: Callable[[str], Any] | None = None
        self.on_auth_failed: Callable[[], Any] | None = None

    @property
    def connected(self) -> bool:
        return self._connected

    async def send(self, raw: str) -> None:
        if not self._connected or not self._connection_id:
            return
        try:
            if not self._session:
                self._session = aiohttp.ClientSession()
            url = f"{self.server_url}/rpc?connection_id={self._connection_id}"
            async with self._session.post(
                url,
                data=raw,
                headers={"Content-Type": "application/json"},
            ) as resp:
                if resp.status >= 400:
                    await self._mark_disconnected()
        except Exception:
            await self._mark_disconnected()

    async def wait_connected(self, timeout: float = 10.0) -> None:
        await asyncio.wait_for(self._connected_event.wait(), timeout=timeout)

    async def connect(self) -> None:
        """Start callback server and register with remote server."""
        try:
            # Start local callback server
            app = web.Application()
            app.router.add_post("/rpc", self._handle_callback)
            self._runner = web.AppRunner(app)
            await self._runner.setup()
            self._site = web.TCPSite(self._runner, self.callback_host, self.callback_port)
            await self._site.start()

            actual_port = self._site._server.sockets[0].getsockname()[1]
            self._callback_url = f"http://{self.callback_host}:{actual_port}/rpc"

            # Register with server
            if not self._session:
                self._session = aiohttp.ClientSession()

            async with self._session.post(
                f"{self.server_url}/connect",
                json={
                    "callback_url": self._callback_url,
                    "token": self.token,
                    "role": self.role,
                    "client_id": self.client_id,
                },
            ) as resp:
                if resp.status == 401:
                    if self.on_auth_failed:
                        self.on_auth_failed()
                    await self._stop_callback_server()
                    return

                if resp.status != 200:
                    await self._stop_callback_server()
                    return

                data = await resp.json()
                self._connection_id = data["connection_id"]
                self._connected = True
                self._connected_event.set()
                if self.on_open:
                    self.on_open()

        except Exception:
            await self._stop_callback_server()

    async def disconnect(self) -> None:
        if self._connection_id and self._session:
            try:
                async with self._session.post(
                    f"{self.server_url}/disconnect",
                    json={"connection_id": self._connection_id},
                ):
                    pass
            except Exception:
                pass
        await self._mark_disconnected()
        await self._stop_callback_server()
        if self._session:
            await self._session.close()
            self._session = None

    async def _handle_callback(self, request: web.Request) -> web.Response:
        body = await request.text()
        if self.on_message:
            result = self.on_message(body)
            if asyncio.iscoroutine(result):
                await result
        return web.Response(text="OK")

    async def _mark_disconnected(self) -> None:
        if not self._connected:
            return
        self._connected = False
        self._connection_id = None
        self._connected_event.clear()
        if self.on_close:
            self.on_close()

    async def _stop_callback_server(self) -> None:
        if self._runner:
            await self._runner.cleanup()
            self._runner = None
