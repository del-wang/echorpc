"""WsConnection — wraps a websockets connection, provides ITransportConnection."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable

import websockets
from websockets.asyncio.server import ServerConnection
from websockets.asyncio.client import ClientConnection

from ..core import DEFAULT_PING_INTERVAL, make_notification

logger = logging.getLogger("viberpc")

WebSocketConn = ServerConnection | ClientConnection


class WsConnection:
    """Wraps a single WebSocket and provides transport-level I/O."""

    def __init__(
        self,
        ws: WebSocketConn,
        *,
        ping_interval: float = DEFAULT_PING_INTERVAL,
    ) -> None:
        self.ws = ws
        self.ping_interval = ping_interval
        self._closed = False
        self._ping_task: asyncio.Task[None] | None = None

        self.on_message: Callable[[str], Any] | None = None
        self.on_close: Callable[[], Any] | None = None

    @property
    def is_open(self) -> bool:
        return not self._closed and self.ws.state.name == "OPEN"

    async def send(self, raw: str) -> None:
        """Send raw string."""
        if self._closed:
            return
        await self.ws.send(raw)

    async def close(self) -> None:
        self._closed = True
        self._cancel_ping()
        try:
            await self.ws.close()
        except Exception:
            pass

    async def serve(self) -> None:
        """Start listening + heartbeat. Blocks until connection closes."""
        self._ping_task = asyncio.create_task(self._ping_loop())
        try:
            async for raw in self.ws:
                if self.on_message:
                    result = self.on_message(raw)
                    if asyncio.iscoroutine(result):
                        await result
        except websockets.ConnectionClosed:
            pass
        finally:
            self._closed = True
            self._cancel_ping()
            if self.on_close:
                result = self.on_close()
                if asyncio.iscoroutine(result):
                    await result

    async def _ping_loop(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(self.ping_interval)
                if self._closed:
                    break
                try:
                    await self.ws.send(json.dumps(make_notification("ping")))
                except Exception:
                    break
        except asyncio.CancelledError:
            pass

    def _cancel_ping(self) -> None:
        if self._ping_task and not self._ping_task.done():
            self._ping_task.cancel()
