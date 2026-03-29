"""MessageRouter — Pure async RPC/event bus engine.

No transport knowledge: takes a `send(raw: str)` coroutine,
exposes `dispatch_message(raw: str)` for incoming data.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable

from .core import (
    DEFAULT_REQUEST_TIMEOUT,
    ErrorCode,
    RpcError,
    make_error_response,
    make_notification,
    make_request,
    make_response,
)

logger = logging.getLogger("echorpc")

Handler = Callable[..., Awaitable[Any] | Any]
EventCallback = Callable[[Any], Any]


class MessageRouter:
    """Pure RPC engine — no transport knowledge."""

    def __init__(
        self,
        send: Callable[[str], Awaitable[None] | None],
        *,
        timeout: float = DEFAULT_REQUEST_TIMEOUT,
    ) -> None:
        self._send_fn = send
        self.timeout = timeout
        self._handlers: dict[str, Handler] = {}
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._subscribers: dict[str, list[EventCallback]] = {}
        self._closed = False
        self.on_pong: Callable[[], Any] | None = None

    # ── Incoming message entry point ────────────────────────────────────

    async def dispatch_message(self, raw: str) -> None:
        """Called by transport when a raw JSON message arrives."""
        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return
        if isinstance(msg, list):
            await self._dispatch_batch(msg)
        else:
            await self._dispatch(msg)

    # ── RPC methods ─────────────────────────────────────────────────────

    def register(self, method: str, handler: Handler) -> None:
        """Register an RPC method handler."""
        self._handlers[method] = handler

    def unregister(self, method: str) -> None:
        self._handlers.pop(method, None)

    async def request(
        self, method: str, params: Any = None, *, timeout: float | None = None
    ) -> Any:
        """Send an RPC request and wait for response."""
        if self._closed:
            raise RpcError(ErrorCode.NOT_CONNECTED, "not connected")
        req = make_request(method, params)
        req_id = req["id"]
        fut: asyncio.Future[Any] = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        await self._raw_send(req)
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
        """Send a batch of RPC requests. Returns results in request order."""
        if self._closed:
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

        await self._raw_send_str(json.dumps(requests))

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
        await self._raw_send(make_notification(method, params))

    def subscribe(self, method: str, callback: EventCallback) -> None:
        """Subscribe to incoming notifications with the given method name."""
        self._subscribers.setdefault(method, []).append(callback)

    def unsubscribe(self, method: str, callback: EventCallback) -> None:
        """Remove a notification subscription."""
        cbs = self._subscribers.get(method)
        if cbs and callback in cbs:
            cbs.remove(callback)

    # ── Lifecycle ───────────────────────────────────────────────────────

    def close(self) -> None:
        """Reject all pending calls and clean up."""
        if self._closed:
            return
        self._closed = True
        self._reject_all(RpcError(ErrorCode.NOT_CONNECTED, "disconnected"))

    def reopen(self) -> None:
        """Reset closed state so the router can be reused after reconnect."""
        self._closed = False

    @property
    def closed(self) -> bool:
        return self._closed

    # ── Internal dispatch ───────────────────────────────────────────────

    async def _dispatch(self, msg: dict) -> dict | None:
        method = msg.get("method")

        # Heartbeat
        if method == "ping":
            await self._raw_send(make_notification("pong"))
            return None
        if method == "pong":
            if self.on_pong:
                self.on_pong()
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
                fut.set_exception(
                    RpcError(error["code"], error["message"], error.get("data"))
                )
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
                    req_id,
                    RpcError(ErrorCode.METHOD_NOT_FOUND, f"method not found: {method}"),
                )
                await self._raw_send(resp)
                return resp
            # Run as task so the message loop stays unblocked
            asyncio.create_task(self._exec_and_send(req_id, handler, params))

        return None

    async def _dispatch_batch(self, batch: list) -> None:
        if not batch:
            await self._raw_send(
                make_error_response(
                    None, RpcError(ErrorCode.INVALID_REQUEST, "Invalid Request")
                )
            )
            return

        tasks: list[asyncio.Task] = []
        for item in batch:
            if not isinstance(item, dict):

                async def _invalid():
                    return make_error_response(
                        None, RpcError(ErrorCode.INVALID_REQUEST, "Invalid Request")
                    )

                tasks.append(asyncio.create_task(_invalid()))
            else:
                tasks.append(asyncio.create_task(self._process_batch_item(item)))

        raw_responses = await asyncio.gather(*tasks)
        responses = [r for r in raw_responses if r is not None]

        if responses:
            await self._raw_send_str(json.dumps(responses))

    async def _process_batch_item(self, msg: dict) -> dict | None:
        method = msg.get("method")
        req_id = msg.get("id")
        params = msg.get("params")

        if method == "ping":
            return make_notification("pong")
        if method == "pong":
            if self.on_pong:
                self.on_pong()
            return None

        if req_id is not None and req_id in self._pending:
            fut = self._pending.pop(req_id)
            if not fut.done():
                error = msg.get("error")
                if error:
                    fut.set_exception(
                        RpcError(error["code"], error["message"], error.get("data"))
                    )
                else:
                    fut.set_result(msg.get("result"))
            return None

        if method is not None and req_id is None:
            for cb in self._subscribers.get(method, []):
                try:
                    result = cb(params)
                    if asyncio.iscoroutine(result):
                        await result
                except Exception:
                    logger.exception("notification handler error for %s", method)
            return None

        if method and req_id is not None:
            handler = self._handlers.get(method)
            if not handler:
                return make_error_response(
                    req_id,
                    RpcError(ErrorCode.METHOD_NOT_FOUND, f"method not found: {method}"),
                )
            return await self._handle_call(req_id, handler, params)

        return make_error_response(
            req_id, RpcError(ErrorCode.INVALID_REQUEST, "Invalid Request")
        )

    async def _handle_call(
        self, req_id: str | int, handler: Handler, params: Any
    ) -> dict:
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

    async def _exec_and_send(
        self, req_id: str | int, handler: Handler, params: Any
    ) -> None:
        resp = await self._handle_call(req_id, handler, params)
        await self._raw_send(resp)

    # ── Helpers ─────────────────────────────────────────────────────────

    async def _raw_send(self, msg: dict) -> None:
        if self._closed:
            return
        try:
            result = self._send_fn(json.dumps(msg))
            if asyncio.iscoroutine(result):
                await result
        except Exception:
            pass

    async def _raw_send_str(self, data: str) -> None:
        if self._closed:
            return
        try:
            result = self._send_fn(data)
            if asyncio.iscoroutine(result):
                await result
        except Exception:
            pass

    def _reject_all(self, err: RpcError) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(err)
        self._pending.clear()
