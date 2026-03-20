"""Single WebSocket JSON-RPC connection handler."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable, Awaitable

import websockets
from websockets.asyncio.server import ServerConnection
from websockets.asyncio.client import ClientConnection

from .core import (
    RpcError, ErrorCode, make_response, make_error_response, make_request,
    make_event, DEFAULT_TIMEOUT, DEFAULT_PING_INTERVAL, PONG_TIMEOUT,
)

logger = logging.getLogger("viberpc")

Handler = Callable[..., Awaitable[Any] | Any]
EventCallback = Callable[[Any], Any]

WebSocketConn = ServerConnection | ClientConnection


class RpcConnection:
    """Wraps a single WebSocket and provides bidirectional JSON-RPC 2.0."""

    def __init__(
        self,
        ws: WebSocketConn,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        ping_interval: float = DEFAULT_PING_INTERVAL,
    ) -> None:
        self.ws = ws
        self.timeout = timeout
        self.ping_interval = ping_interval

        self._handlers: dict[str, Handler] = {}
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._event_listeners: dict[str, list[EventCallback]] = {}
        self._closed = False
        self._ping_task: asyncio.Task[None] | None = None
        self._meta: dict[str, Any] = {}  # arbitrary metadata (role, client_id, etc.)

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def serve(self) -> None:
        """Start listening + heartbeat. Blocks until connection closes."""
        self._ping_task = asyncio.create_task(self._ping_loop())
        try:
            async for raw in self.ws:
                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                await self._dispatch(msg)
        except websockets.ConnectionClosed:
            pass
        finally:
            self._closed = True
            self._cancel_ping()
            self._reject_all(RpcError(ErrorCode.NOT_CONNECTED, "disconnected"))

    async def close(self) -> None:
        self._closed = True
        self._cancel_ping()
        self._reject_all(RpcError(ErrorCode.NOT_CONNECTED, "closed"))
        try:
            await self.ws.close()
        except Exception:
            pass

    @property
    def is_open(self) -> bool:
        return not self._closed and self.ws.state.name == "OPEN"

    # ── Public API ───────────────────────────────────────────────────────

    def register(self, method: str, handler: Handler) -> None:
        self._handlers[method] = handler

    def unregister(self, method: str) -> None:
        self._handlers.pop(method, None)

    async def call(self, method: str, params: Any = None, *, timeout: float | None = None) -> Any:
        if not self.is_open:
            raise RpcError(ErrorCode.NOT_CONNECTED, "not connected")
        req = make_request(method, params)
        req_id = req["id"]
        fut: asyncio.Future[Any] = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        await self._send(req)
        try:
            return await asyncio.wait_for(fut, timeout=timeout or self.timeout)
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            raise RpcError(ErrorCode.TIMEOUT, "timeout")

    async def notify(self, method: str, params: Any = None) -> None:
        """Send a notification (no id, no response expected)."""
        msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        await self._send(msg)

    async def emit(self, event: str, data: Any = None) -> None:
        await self._send(make_event(event, data))

    def on(self, event: str, callback: EventCallback) -> None:
        self._event_listeners.setdefault(event, []).append(callback)

    def off(self, event: str, callback: EventCallback) -> None:
        cbs = self._event_listeners.get(event)
        if cbs and callback in cbs:
            cbs.remove(callback)

    # ── Internal dispatch ────────────────────────────────────────────────

    async def _dispatch(self, msg: dict) -> None:
        method = msg.get("method")

        # Heartbeat
        if method == "ping":
            await self._send({"jsonrpc": "2.0", "method": "pong"})
            return
        if method == "pong":
            return

        req_id = msg.get("id")
        params = msg.get("params")

        # Response to our pending call
        if req_id and req_id in self._pending:
            fut = self._pending.pop(req_id)
            if fut.done():
                return
            error = msg.get("error")
            if error:
                fut.set_exception(RpcError(error["code"], error["message"], error.get("data")))
            else:
                fut.set_result(msg.get("result"))
            return

        # Event
        if isinstance(method, str) and method.startswith("event:"):
            ev_name = method[6:]
            for cb in self._event_listeners.get(ev_name, []):
                try:
                    result = cb(params)
                    if asyncio.iscoroutine(result):
                        await result
                except Exception:
                    logger.exception("event handler error for %s", ev_name)
            return

        # Incoming RPC call
        if method and req_id is not None:
            handler = self._handlers.get(method)
            if not handler:
                await self._send(make_error_response(
                    req_id, RpcError(ErrorCode.METHOD_NOT_FOUND, f"method not found: {method}")
                ))
                return
            try:
                result = handler(params)
                if asyncio.iscoroutine(result) or asyncio.isfuture(result):
                    result = await result
                await self._send(make_response(req_id, result))
            except RpcError as e:
                await self._send(make_error_response(req_id, e))
            except Exception as e:
                await self._send(make_error_response(
                    req_id, RpcError(ErrorCode.INTERNAL_ERROR, str(e))
                ))

    # ── Heartbeat ────────────────────────────────────────────────────────

    async def _ping_loop(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(self.ping_interval)
                if self._closed:
                    break
                await self._send({"jsonrpc": "2.0", "method": "ping"})
        except asyncio.CancelledError:
            pass

    def _cancel_ping(self) -> None:
        if self._ping_task and not self._ping_task.done():
            self._ping_task.cancel()

    # ── Helpers ──────────────────────────────────────────────────────────

    async def _send(self, msg: dict) -> None:
        if self._closed:
            return
        try:
            await self.ws.send(json.dumps(msg))
        except Exception:
            pass

    def _reject_all(self, err: RpcError) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(err)
        self._pending.clear()
