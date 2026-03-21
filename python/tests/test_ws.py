"""Integration tests for the WebSocket transport layer.

Mirrors typescript/tests/ws.test.ts
"""

import asyncio

import pytest

from viberpc import RpcServer, RpcClient, RpcError, ErrorCode, WsServer, WsClient

pytestmark = pytest.mark.asyncio


def make_client(port: int, role: str = "web", **kwargs) -> RpcClient:
    transport = WsClient(
        f"ws://127.0.0.1:{port}",
        token="test-token",
        role=role,
        auto_reconnect=False,
        ping_interval=300,
        **kwargs,
    )
    return RpcClient(transport)


# ── Basic RPC ──────────────────────────────────────────────────────────


class TestBasicRpc:
    @pytest.fixture(autouse=True)
    async def setup(self):
        ws_server = WsServer(host="127.0.0.1", port=0, ping_interval=300)
        self.server = RpcServer(ws_server)
        self.server.register("echo", lambda conn, params: params)
        self.server.register("add", lambda conn, params: {"sum": params["a"] + params["b"]})
        self.server.register("server.time", lambda conn, params: {"time": 12345})
        self.server.register("throws", lambda conn, params: (_ for _ in ()).throw(
            RpcError(ErrorCode.INVALID_PARAMS, "bad params")
        ))

        async def throws_generic(conn, params):
            raise Exception("something broke")
        self.server.register("throws.generic", throws_generic)

        await self.server.start()
        self.port = self.server.address[1]
        yield
        await self.server.stop()

    async def test_connect_and_authenticate(self):
        client = make_client(self.port)
        await client.connect()
        assert client.connected
        await client.disconnect()

    async def test_request_echo(self):
        client = make_client(self.port)
        await client.connect()
        result = await client.request("echo", {"msg": "hello"})
        assert result == {"msg": "hello"}
        await client.disconnect()

    async def test_request_add(self):
        client = make_client(self.port)
        await client.connect()
        result = await client.request("add", {"a": 10, "b": 20})
        assert result == {"sum": 30}
        await client.disconnect()

    async def test_request_server_time(self):
        client = make_client(self.port)
        await client.connect()
        result = await client.request("server.time")
        assert result["time"] > 0
        await client.disconnect()

    async def test_method_not_found(self):
        client = make_client(self.port)
        await client.connect()
        with pytest.raises(RpcError) as exc_info:
            await client.request("nonexistent")
        assert exc_info.value.code == ErrorCode.METHOD_NOT_FOUND
        await client.disconnect()

    async def test_rpc_error_from_handler(self):
        client = make_client(self.port)
        await client.connect()
        with pytest.raises(RpcError) as exc_info:
            await client.request("throws")
        assert exc_info.value.code == ErrorCode.INVALID_PARAMS
        assert exc_info.value.message == "bad params"
        await client.disconnect()

    async def test_generic_error_from_handler(self):
        client = make_client(self.port)
        await client.connect()
        with pytest.raises(RpcError) as exc_info:
            await client.request("throws.generic")
        assert exc_info.value.code == ErrorCode.INTERNAL_ERROR
        await client.disconnect()


# ── Handler conn ─────────────────────────────────────────────────────


class TestHandlerConn:
    @pytest.fixture(autouse=True)
    async def setup(self):
        ws_server = WsServer(host="127.0.0.1", port=0, ping_interval=300)
        self.server = RpcServer(ws_server)
        self.server.register("whoami", lambda conn, params: {
            "role": conn.meta.get("role"),
            "authenticated": conn.meta.get("authenticated"),
        })

        async def ask_client(conn, params):
            answer = await conn.request("client.answer")
            return {"answer": answer}

        self.server.register("ask.client", ask_client)

        await self.server.start()
        self.port = self.server.address[1]
        yield
        await self.server.stop()

    async def test_handler_receives_conn_with_meta(self):
        client = make_client(self.port, role="node")
        await client.connect()
        result = await client.request("whoami")
        assert result["role"] == "node"
        assert result["authenticated"] is True
        await client.disconnect()

    async def test_handler_requests_back_into_client(self):
        client = make_client(self.port, role="node")
        client.register("client.answer", lambda params: "42")
        await client.connect()
        result = await client.request("ask.client")
        assert result["answer"] == "42"
        await client.disconnect()


# ── Bidirectional RPC ────────────────────────────────────────────────


class TestBidirectionalRpc:
    @pytest.fixture(autouse=True)
    async def setup(self):
        ws_server = WsServer(host="127.0.0.1", port=0, ping_interval=300)
        self.server = RpcServer(ws_server)
        self.server.register("echo", lambda conn, params: params)
        await self.server.start()
        self.port = self.server.address[1]
        yield
        await self.server.stop()

    async def test_server_requests_client_method(self):
        client = make_client(self.port, role="node")
        client.register("client.ping", lambda params: "pong")
        await client.connect()

        conn = self.server.get_connections("node")[0]
        result = await conn.request("client.ping")
        assert result == "pong"

        await client.disconnect()

    async def test_server_requests_client_with_params(self):
        client = make_client(self.port, role="node")
        client.register("client.add", lambda params: params["a"] + params["b"])
        await client.connect()

        conns = self.server.get_connections("node")
        conn = conns[-1]
        result = await conn.request("client.add", {"a": 7, "b": 8})
        assert result == 15

        await client.disconnect()


# ── Pub/Sub ──────────────────────────────────────────────────────────


class TestPubSub:
    @pytest.fixture(autouse=True)
    async def setup(self):
        ws_server = WsServer(host="127.0.0.1", port=0, ping_interval=300)
        self.server = RpcServer(ws_server)
        await self.server.start()
        self.port = self.server.address[1]
        yield
        await self.server.stop()

    async def test_client_receives_broadcast(self):
        client = make_client(self.port)
        events = []
        client.subscribe("test.event", lambda data: events.append(data))
        await client.connect()

        await self.server.broadcast("test.event", {"x": 42})
        await asyncio.sleep(0.2)
        assert events == [{"x": 42}]

        await client.disconnect()

    async def test_server_receives_notification_via_subscribe(self):
        ws_server = WsServer(host="127.0.0.1", port=0, ping_interval=300)
        fresh_server = RpcServer(ws_server)
        received = []
        fresh_server.subscribe("client.hello", lambda conn, data: received.append({
            "data": data,
            "role": conn.meta.get("role"),
        }))
        await fresh_server.start()
        port = fresh_server.address[1]

        client = make_client(port, role="web")
        await client.connect()

        await client.publish("client.hello", {"from": "test"})
        await asyncio.sleep(0.2)

        assert received == [{"data": {"from": "test"}, "role": "web"}]

        await client.disconnect()
        await fresh_server.stop()

    async def test_server_receives_notification_via_conn_subscribe(self):
        client = make_client(self.port)
        await client.connect()

        received = []
        conn = self.server.get_connections("web")[0]
        conn.subscribe("client.hello", lambda data: received.append(data))

        await client.publish("client.hello", {"from": "test"})
        await asyncio.sleep(0.2)
        assert received == [{"from": "test"}]

        await client.disconnect()

    async def test_broadcast_except_skips_excluded(self):
        client1 = make_client(self.port, role="web")
        client2 = make_client(self.port, role="web")
        events1, events2 = [], []
        client1.subscribe("selective", lambda d: events1.append(d))
        client2.subscribe("selective", lambda d: events2.append(d))

        await client1.connect()
        await client2.connect()

        conns = self.server.get_connections("web")
        await self.server.broadcast_except("selective", {"msg": "hi"}, exclude=conns[0])
        await asyncio.sleep(0.2)

        total = len(events1) + len(events2)
        assert total == 1

        await client1.disconnect()
        await client2.disconnect()


# ── Batch requests ──────────────────────────────────────────────────


class TestBatchRequests:
    @pytest.fixture(autouse=True)
    async def setup(self):
        ws_server = WsServer(host="127.0.0.1", port=0, ping_interval=300)
        self.server = RpcServer(ws_server)
        self.server.register("echo", lambda conn, params: params)
        self.server.register("add", lambda conn, params: {"sum": params["a"] + params["b"]})
        self.server.register("fail", lambda conn, params: (_ for _ in ()).throw(
            RpcError(-100, "intentional error")
        ))

        async def slow_echo(conn, params):
            import random
            await asyncio.sleep(random.uniform(0.01, 0.05))
            return params

        self.server.register("slow_echo", slow_echo)

        await self.server.start()
        self.port = self.server.address[1]
        yield
        await self.server.stop()

    async def test_basic_batch(self):
        client = make_client(self.port)
        await client.connect()

        results = await client.batch_request([
            ("echo", {"x": 1}),
            ("add", {"a": 10, "b": 20}),
            ("echo", {"x": 2}),
        ])

        assert len(results) == 3
        assert results[0] == {"x": 1}
        assert results[1] == {"sum": 30}
        assert results[2] == {"x": 2}

        await client.disconnect()

    async def test_batch_with_errors(self):
        client = make_client(self.port)
        await client.connect()

        results = await client.batch_request([
            ("echo", {"ok": True}),
            ("fail", None),
            ("add", {"a": 1, "b": 2}),
        ])

        assert len(results) == 3
        assert results[0] == {"ok": True}
        assert isinstance(results[1], RpcError)
        assert results[1].code == -100
        assert results[2] == {"sum": 3}

        await client.disconnect()

    async def test_empty_batch(self):
        client = make_client(self.port)
        await client.connect()

        results = await client.batch_request([])
        assert results == []

        await client.disconnect()

    async def test_batch_preserves_order(self):
        client = make_client(self.port)
        await client.connect()

        calls = [("slow_echo", {"i": i}) for i in range(10)]
        results = await client.batch_request(calls)

        for i, r in enumerate(results):
            assert r == {"i": i}

        await client.disconnect()


# ── Connection management ──────────────────────────────────────────────


class TestConnectionManagement:
    @pytest.fixture(autouse=True)
    async def setup(self):
        ws_server = WsServer(host="127.0.0.1", port=0, ping_interval=300)
        self.server = RpcServer(ws_server)
        await self.server.start()
        self.port = self.server.address[1]
        yield
        await self.server.stop()

    async def test_on_connect_and_on_disconnect(self):
        connected = []
        disconnected = []

        self.server.on_connect(lambda conn: connected.append(conn))
        self.server.on_disconnect(lambda conn: disconnected.append(conn))

        client = make_client(self.port, role="node")
        await client.connect()

        assert len(connected) >= 1
        assert len(self.server.get_connections()) >= 1

        await client.disconnect()
        await asyncio.sleep(0.2)

        assert len(disconnected) >= 1
        assert any(c.meta.get("role") == "node" for c in disconnected)

    async def test_get_connections_filter_by_role(self):
        ws_server = WsServer(host="127.0.0.1", port=0, ping_interval=300)
        fresh_server = RpcServer(ws_server)
        await fresh_server.start()
        port = fresh_server.address[1]

        c1 = make_client(port, role="web")
        await c1.connect()
        c2 = make_client(port, role="node")
        await c2.connect()
        await asyncio.sleep(0.05)

        assert len(fresh_server.get_connections("web")) == 1
        assert len(fresh_server.get_connections("node")) == 1
        assert len(fresh_server.get_connections()) == 2

        await c1.disconnect()
        await c2.disconnect()
        await asyncio.sleep(0.2)
        await fresh_server.stop()

    async def test_multiple_web_clients(self):
        clients = []
        events = [[] for _ in range(3)]

        for i in range(3):
            c = make_client(self.port, role="web")
            c.subscribe("multi.test", lambda d, idx=i: events[idx].append(d))
            await c.connect()
            clients.append(c)

        await self.server.broadcast("multi.test", {"n": 1}, role="web")
        await asyncio.sleep(0.2)

        for ev_list in events:
            assert ev_list == [{"n": 1}]

        for c in clients:
            await c.disconnect()
        await asyncio.sleep(0.2)


# ── Auth ────────────────────────────────────────────────────────────────


class TestAuth:
    async def test_valid_token_connects(self):
        def auth(params):
            if params["token"] != "valid-token":
                raise Exception("invalid token")
            return {"ok": True}

        ws_server = WsServer(host="127.0.0.1", port=0, ping_interval=300, auth_handler=auth)
        server = RpcServer(ws_server)
        server.register("echo", lambda conn, p: p)
        await server.start()
        port = server.address[1]

        transport = WsClient(
            f"ws://127.0.0.1:{port}", token="valid-token",
            auto_reconnect=False, ping_interval=300,
        )
        client = RpcClient(transport)
        await client.connect()
        assert client.connected

        result = await client.request("echo", "ok")
        assert result == "ok"

        await client.disconnect()
        await server.stop()

    async def test_invalid_token_rejected(self):
        def auth(params):
            if params["token"] != "valid-token":
                raise Exception("invalid token")
            return {"ok": True}

        ws_server = WsServer(host="127.0.0.1", port=0, ping_interval=300, auth_handler=auth)
        server = RpcServer(ws_server)
        server.register("echo", lambda conn, p: p)
        await server.start()
        port = server.address[1]

        transport = WsClient(
            f"ws://127.0.0.1:{port}", token="wrong-token",
            auto_reconnect=False, ping_interval=300,
        )
        client = RpcClient(transport)
        with pytest.raises(RpcError) as exc_info:
            await client.connect()
        assert exc_info.value.code == ErrorCode.AUTH_FAILED
        assert not client.connected
        assert len(server.get_connections()) == 0

        await server.stop()

    async def test_no_auth_handler_accepts_all(self):
        ws_server = WsServer(host="127.0.0.1", port=0, ping_interval=300)
        server = RpcServer(ws_server)
        server.register("echo", lambda conn, p: p)
        await server.start()
        port = server.address[1]

        transport = WsClient(
            f"ws://127.0.0.1:{port}", token="anything",
            auto_reconnect=False, ping_interval=300,
        )
        client = RpcClient(transport)
        await client.connect()
        assert client.connected

        result = await client.request("echo", "ok")
        assert result == "ok"

        await client.disconnect()
        await server.stop()

    async def test_unauthenticated_cannot_call_methods(self):
        def auth(params):
            if params["token"] != "valid-token":
                raise Exception("nope")
            return {"ok": True}

        ws_server = WsServer(host="127.0.0.1", port=0, ping_interval=300, auth_handler=auth)
        server = RpcServer(ws_server)
        server.register("echo", lambda conn, p: p)
        await server.start()
        port = server.address[1]

        transport = WsClient(
            f"ws://127.0.0.1:{port}", token="wrong-token",
            auto_reconnect=False, ping_interval=300,
        )
        client = RpcClient(transport)
        with pytest.raises(RpcError) as exc_info:
            await client.connect()
        assert exc_info.value.code == ErrorCode.AUTH_FAILED
        assert not client.connected
        assert len(server.get_connections()) == 0

        with pytest.raises(RpcError) as exc_info:
            await client.request("echo", "ok")
        assert exc_info.value.code == ErrorCode.NOT_CONNECTED

        with pytest.raises(RpcError) as exc_info:
            await client.publish("echo", "ok")
        assert exc_info.value.code == ErrorCode.NOT_CONNECTED

        await server.stop()
