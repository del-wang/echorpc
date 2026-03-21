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
    make_notification, DEFAULT_TIMEOUT, DEFAULT_PING_INTERVAL,
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
        self._subscribers: dict[str, list[EventCallback]] = {}
        self._closed = False
        self._ping_task: asyncio.Task[None] | None = None
        self.meta: dict[str, Any] = {}  # arbitrary metadata (role, client_id, etc.)

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
                if isinstance(msg, list):
                    await self._dispatch_batch(msg)
                else:
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

    # ── RPC methods ──────────────────────────────────────────────────────

    def register(self, method: str, handler: Handler) -> None:
        self._handlers[method] = handler

    def unregister(self, method: str) -> None:
        self._handlers.pop(method, None)

    async def request(self, method: str, params: Any = None, *, timeout: float | None = None) -> Any:
        """Send a JSON-RPC request and wait for the response."""
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

    async def batch_request(
        self,
        calls: list[tuple[str, Any]],
        *,
        timeout: float | None = None,
    ) -> list[Any]:
        """Send a batch of RPC requests. Returns results in request order.

        Each item in *calls* is a ``(method, params)`` tuple.
        If any individual call returns an error, the corresponding element
        in the result list will be an :class:`RpcError` instance.
        """
        if not self.is_open:
            raise RpcError(ErrorCode.NOT_CONNECTED, "not connected")
        if not calls:
            return []

        requests: list[dict] = []
        futures: list[asyncio.Future[Any]] = []
        loop = asyncio.get_event_loop()

        for method, params in calls:
            req = make_request(method, params)
            fut = loop.create_future()
            self._pending[req["id"]] = fut
            requests.append(req)
            futures.append(fut)

        # Send entire batch as a single JSON array
        await self._send_raw(json.dumps(requests))

        # Wait for all responses — use gather with return_exceptions so one
        # failure doesn't cancel the rest.
        try:
            results = await asyncio.wait_for(
                asyncio.gather(*futures, return_exceptions=True),
                timeout=timeout or self.timeout,
            )
        except asyncio.TimeoutError:
            for req in requests:
                self._pending.pop(req["id"], None)
            raise RpcError(ErrorCode.TIMEOUT, "batch timeout")

        return results

    # ── Pub/Sub (notifications) ──────────────────────────────────────────

    async def publish(self, method: str, params: Any = None) -> None:
        """Send a JSON-RPC notification (no response expected)."""
        await self._send(make_notification(method, params))

    def subscribe(self, method: str, callback: EventCallback) -> None:
        """Subscribe to incoming notifications with the given method name."""
        self._subscribers.setdefault(method, []).append(callback)

    def unsubscribe(self, method: str, callback: EventCallback) -> None:
        """Remove a notification subscription."""
        cbs = self._subscribers.get(method)
        if cbs and callback in cbs:
            cbs.remove(callback)

    # ── Internal dispatch ────────────────────────────────────────────────

    async def _dispatch(self, msg: dict) -> dict | None:
        """Dispatch a single JSON-RPC message. Returns a response dict for
        RPC calls, or ``None`` for notifications / responses."""
        method = msg.get("method")

        # Heartbeat
        if method == "ping":
            await self._send(make_notification("pong"))
            return None
        if method == "pong":
            return None

        req_id = msg.get("id")
        params = msg.get("params")

        # Response to our pending request
        if req_id is not None and req_id in self._pending:
            fut = self._pending.pop(req_id)
            if fut.done():
                return None
            error = msg.get("error")
            if error:
                fut.set_exception(RpcError(error["code"], error["message"], error.get("data")))
            else:
                fut.set_result(msg.get("result"))
            return None

        # Notification (no id) — fire subscribers
        if method is not None and req_id is None:
            for cb in self._subscribers.get(method, []):
                try:
                    result = cb(params)
                    if asyncio.iscoroutine(result):
                        await result
                except Exception:
                    logger.exception("notification handler error for %s", method)
            return None

        # Incoming RPC call (has method + id)
        if method and req_id is not None:
            handler = self._handlers.get(method)
            if not handler:
                resp = make_error_response(
                    req_id, RpcError(ErrorCode.METHOD_NOT_FOUND, f"method not found: {method}")
                )
                await self._send(resp)
                return resp
            # Run as task so the message loop stays unblocked
            asyncio.create_task(self._exec_and_send(req_id, handler, params))

        return None

    async def _dispatch_batch(self, batch: list) -> None:
        """Handle an incoming JSON-RPC batch (array of requests).

        Per the spec:
        - An empty array → single Invalid Request error
        - Non-object elements → Invalid Request error per element
        - Notifications produce no response
        - If all are notifications, nothing is returned
        """
        if not batch:
            await self._send(
                make_error_response(None, RpcError(ErrorCode.INVALID_REQUEST, "Invalid Request"))
            )
            return

        tasks: list[asyncio.Task] = []
        for item in batch:
            if not isinstance(item, dict):
                # Invalid element — create a resolved task with error response
                async def _invalid():
                    return make_error_response(
                        None, RpcError(ErrorCode.INVALID_REQUEST, "Invalid Request")
                    )
                tasks.append(asyncio.create_task(_invalid()))
            else:
                tasks.append(asyncio.create_task(self._process_batch_item(item)))

        raw_responses = await asyncio.gather(*tasks)
        # Filter out None (from notifications and responses to our pending calls)
        responses = [r for r in raw_responses if r is not None]

        if responses:
            await self._send_raw(json.dumps(responses))

    async def _process_batch_item(self, msg: dict) -> dict | None:
        """Process a single item within a batch. Returns a response dict
        for RPC calls, or None for notifications."""
        method = msg.get("method")
        req_id = msg.get("id")
        params = msg.get("params")

        # Heartbeat
        if method == "ping":
            return make_notification("pong")  # type: ignore[return-value]
        if method == "pong":
            return None

        # Response to our pending request
        if req_id is not None and req_id in self._pending:
            fut = self._pending.pop(req_id)
            if not fut.done():
                error = msg.get("error")
                if error:
                    fut.set_exception(RpcError(error["code"], error["message"], error.get("data")))
                else:
                    fut.set_result(msg.get("result"))
            return None

        # Notification (no id) — fire subscribers
        if method is not None and req_id is None:
            for cb in self._subscribers.get(method, []):
                try:
                    result = cb(params)
                    if asyncio.iscoroutine(result):
                        await result
                except Exception:
                    logger.exception("notification handler error for %s", method)
            return None

        # RPC call (has method + id) — execute and return response
        if method and req_id is not None:
            handler = self._handlers.get(method)
            if not handler:
                return make_error_response(
                    req_id, RpcError(ErrorCode.METHOD_NOT_FOUND, f"method not found: {method}")
                )
            return await self._handle_call(req_id, handler, params)

        # Invalid request (no method)
        return make_error_response(
            req_id, RpcError(ErrorCode.INVALID_REQUEST, "Invalid Request")
        )

    async def _handle_call(self, req_id: str | int, handler: Handler, params: Any) -> dict:
        """Execute an RPC handler and return the response dict."""
        try:
            result = handler(params)
            if asyncio.iscoroutine(result) or asyncio.isfuture(result):
                result = await result
            return make_response(req_id, result)
        except RpcError as e:
            return make_error_response(req_id, e)
        except Exception as e:
            return make_error_response(
                req_id, RpcError(ErrorCode.INTERNAL_ERROR, str(e))
            )

    async def _exec_and_send(self, req_id: str | int, handler: Handler, params: Any) -> None:
        """Execute a handler and send the response (for non-batch dispatch)."""
        resp = await self._handle_call(req_id, handler, params)
        await self._send(resp)

    # ── Heartbeat ────────────────────────────────────────────────────────

    async def _ping_loop(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(self.ping_interval)
                if self._closed:
                    break
                await self._send(make_notification("ping"))
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

    async def _send_raw(self, data: str) -> None:
        """Send a pre-serialized JSON string."""
        if self._closed:
            return
        try:
            await self.ws.send(data)
        except Exception:
            pass

    def _reject_all(self, err: RpcError) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(err)
        self._pending.clear()
