"""Unit tests for MessageRouter — pure RPC engine without transport.

Mirrors typescript/tests/router.test.ts
"""

import asyncio
import json

import pytest

from echorpc.core import ErrorCode, RpcError
from echorpc.router import MessageRouter

pytestmark = pytest.mark.asyncio

sent: list[str] = []
router: MessageRouter


def create_router(timeout: float = 5.0) -> MessageRouter:
    global sent, router
    sent = []

    def send(raw: str):
        sent.append(raw)

    router = MessageRouter(send, timeout=timeout)
    return router


def last_sent() -> dict:
    return json.loads(sent[-1])


# ── Heartbeat ──────────────────────────────────────────────────────────


class TestHeartbeat:
    async def test_respond_to_ping_with_pong(self):
        create_router()
        await router.dispatch_message(json.dumps({"jsonrpc": "2.0", "method": "ping"}))
        assert last_sent() == {"jsonrpc": "2.0", "method": "pong"}

    async def test_silently_ignore_pong(self):
        create_router()
        await router.dispatch_message(json.dumps({"jsonrpc": "2.0", "method": "pong"}))
        assert len(sent) == 0


# ── RPC handlers ───────────────────────────────────────────────────────


class TestRpcHandlers:
    async def test_call_registered_handler_and_send_result(self):
        create_router()
        router.register("echo", lambda params: params)
        await router.dispatch_message(
            json.dumps(
                {"jsonrpc": "2.0", "id": "1", "method": "echo", "params": {"x": 1}}
            )
        )
        await asyncio.sleep(0.01)
        assert last_sent() == {"jsonrpc": "2.0", "id": "1", "result": {"x": 1}}

    async def test_method_not_found_for_unknown_method(self):
        create_router()
        await router.dispatch_message(
            json.dumps({"jsonrpc": "2.0", "id": "2", "method": "unknown"})
        )
        resp = last_sent()
        assert resp["id"] == "2"
        assert resp["error"]["code"] == ErrorCode.METHOD_NOT_FOUND

    async def test_error_when_handler_throws_rpc_error(self):
        create_router()

        def fail(params):
            raise RpcError(ErrorCode.INVALID_PARAMS, "bad")

        router.register("fail", fail)
        await router.dispatch_message(
            json.dumps({"jsonrpc": "2.0", "id": "3", "method": "fail"})
        )
        await asyncio.sleep(0.01)
        resp = last_sent()
        assert resp["error"]["code"] == ErrorCode.INVALID_PARAMS

    async def test_internal_error_for_generic_errors(self):
        create_router()

        def crash(params):
            raise Exception("oops")

        router.register("crash", crash)
        await router.dispatch_message(
            json.dumps({"jsonrpc": "2.0", "id": "4", "method": "crash"})
        )
        await asyncio.sleep(0.01)
        resp = last_sent()
        assert resp["error"]["code"] == ErrorCode.INTERNAL_ERROR

    async def test_unregister(self):
        create_router()
        router.register("temp", lambda params: "hi")
        router.unregister("temp")
        await router.dispatch_message(
            json.dumps({"jsonrpc": "2.0", "id": "5", "method": "temp"})
        )
        resp = last_sent()
        assert resp["error"]["code"] == ErrorCode.METHOD_NOT_FOUND

    async def test_register_reserved_method_raises(self):
        create_router()
        with pytest.raises(ValueError, match="reserved"):
            router.register("ping", lambda params: None)
        with pytest.raises(ValueError, match="reserved"):
            router.register("pong", lambda params: None)

    async def test_subscribe_reserved_method_raises(self):
        create_router()
        with pytest.raises(ValueError, match="reserved"):
            router.subscribe("ping", lambda data: None)
        with pytest.raises(ValueError, match="reserved"):
            router.subscribe("pong", lambda data: None)


# ── Pending requests ───────────────────────────────────────────────────


class TestPendingRequests:
    async def test_resolve_when_response_arrives(self):
        create_router()
        p = asyncio.create_task(router.request("echo", {"x": 1}))
        await asyncio.sleep(0.01)
        req = json.loads(sent[0])
        await router.dispatch_message(
            json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": {"x": 1}})
        )
        result = await p
        assert result == {"x": 1}

    async def test_reject_when_error_response_arrives(self):
        create_router()
        p = asyncio.create_task(router.request("fail"))
        await asyncio.sleep(0.01)
        req = json.loads(sent[0])
        await router.dispatch_message(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": req["id"],
                    "error": {"code": -100, "message": "err"},
                }
            )
        )
        with pytest.raises(RpcError):
            await p

    async def test_timeout(self):
        r = create_router(0.05)
        with pytest.raises(RpcError, match="timeout"):
            await r.request("slow")


# ── Pub/Sub ────────────────────────────────────────────────────────────


class TestPubSub:
    async def test_fire_subscribers_on_notification(self):
        create_router()
        received = []
        router.subscribe("event", lambda data: received.append(data))
        await router.dispatch_message(
            json.dumps({"jsonrpc": "2.0", "method": "event", "params": {"n": 1}})
        )
        assert received == [{"n": 1}]

    async def test_unsubscribe(self):
        create_router()
        received = []

        def cb(data):
            return received.append(data)

        router.subscribe("event", cb)
        router.unsubscribe("event", cb)
        await router.dispatch_message(
            json.dumps({"jsonrpc": "2.0", "method": "event", "params": {"n": 1}})
        )
        assert len(received) == 0

    async def test_publish_sends_notification(self):
        create_router()
        await router.publish("event", {"n": 1})
        assert last_sent() == {"jsonrpc": "2.0", "method": "event", "params": {"n": 1}}


# ── Batch ──────────────────────────────────────────────────────────────


class TestBatch:
    async def test_incoming_empty_batch_invalid_request(self):
        create_router()
        await router.dispatch_message(json.dumps([]))
        await asyncio.sleep(0.01)
        resp = last_sent()
        assert resp["error"]["code"] == ErrorCode.INVALID_REQUEST

    async def test_batch_request_resolves_in_order(self):
        create_router()
        p = asyncio.create_task(
            router.batch_request(
                [
                    ("echo", {"x": 1}),
                    ("add", {"a": 1, "b": 2}),
                ]
            )
        )
        await asyncio.sleep(0.01)
        batch = json.loads(sent[0])
        assert len(batch) == 2

        # Respond out of order
        await router.dispatch_message(
            json.dumps(
                [
                    {"jsonrpc": "2.0", "id": batch[1]["id"], "result": {"sum": 3}},
                    {"jsonrpc": "2.0", "id": batch[0]["id"], "result": {"x": 1}},
                ]
            )
        )

        results = await p
        assert results[0] == {"x": 1}
        assert results[1] == {"sum": 3}

    async def test_empty_batch_request_returns_empty_list(self):
        create_router()
        results = await router.batch_request([])
        assert results == []


# ── Close ──────────────────────────────────────────────────────────────


class TestClose:
    async def test_reject_all_pending_on_close(self):
        create_router()
        p1 = asyncio.create_task(router.request("a"))
        p2 = asyncio.create_task(router.request("b"))
        await asyncio.sleep(0.01)
        router.close()
        with pytest.raises(RpcError, match="disconnected"):
            await p1
        with pytest.raises(RpcError, match="disconnected"):
            await p2

    async def test_reject_new_requests_after_close(self):
        create_router()
        router.close()
        with pytest.raises(RpcError, match="not connected"):
            await router.request("x")

    async def test_no_send_after_close(self):
        create_router()
        router.close()
        await router.publish("event", {"n": 1})
        assert len(sent) == 0
