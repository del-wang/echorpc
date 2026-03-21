"""Tests for the Python viberpc package."""

# python -m pytest tests/test_python.py -v

import asyncio

import pytest
import pytest_asyncio

from viberpc import RpcServer, RpcClient, RpcError, ErrorCode

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def server():
    """Start a test server on a random port."""
    srv = RpcServer(host="127.0.0.1", port=0, ping_interval=300)

    # Register test methods — handlers now receive (params, conn)
    srv.register("echo", lambda params, conn: params)
    srv.register("add", lambda params, conn: {"sum": params["a"] + params["b"]})

    async def _fail(params, conn):
        raise RpcError(-100, "intentional error")

    srv.register("fail", _fail)

    await srv.start()
    port = srv._server.sockets[0].getsockname()[1]
    srv.port = port
    yield srv
    await srv.stop()


def make_client(port: int, **kwargs) -> RpcClient:
    return RpcClient(
        f"ws://127.0.0.1:{port}",
        token="test",
        role=kwargs.pop("role", "web"),
        auto_reconnect=False,
        ping_interval=300,
        **kwargs,
    )


class TestBasicRpc:
    async def test_echo(self, server):
        client = make_client(server.port)
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        result = await client.request("echo", {"hello": "world"})
        assert result == {"hello": "world"}

        await client.disconnect()
        task.cancel()

    async def test_add(self, server):
        client = make_client(server.port)
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        result = await client.request("add", {"a": 10, "b": 20})
        assert result == {"sum": 30}

        await client.disconnect()
        task.cancel()

    async def test_method_not_found(self, server):
        client = make_client(server.port)
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        with pytest.raises(RpcError) as exc_info:
            await client.request("nonexistent")
        assert exc_info.value.code == ErrorCode.METHOD_NOT_FOUND

        await client.disconnect()
        task.cancel()

    async def test_rpc_error(self, server):
        client = make_client(server.port)
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        with pytest.raises(RpcError) as exc_info:
            await client.request("fail")
        assert exc_info.value.code == -100

        await client.disconnect()
        task.cancel()


class TestHandlerConn:
    """Test that server handlers receive conn (the calling connection)."""

    async def test_handler_receives_conn_meta(self, server):
        """Handler can read conn.meta to identify the caller."""
        server.register("whoami", lambda params, conn: {
            "role": conn.meta.get("role"),
            "authenticated": conn.meta.get("authenticated"),
        })

        client = make_client(server.port, role="node")
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        result = await client.request("whoami")
        assert result["role"] == "node"
        assert result["authenticated"] is True

        await client.disconnect()
        task.cancel()

    async def test_handler_uses_conn_to_request_client(self, server):
        """Handler can use conn to call back into the client."""
        async def ask_client(params, conn):
            answer = await conn.request("client.answer")
            return {"answer": answer}

        server.register("ask.client", ask_client)

        client = make_client(server.port)
        client.register("client.answer", lambda params: "42")
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        result = await client.request("ask.client")
        assert result["answer"] == "42"

        await client.disconnect()
        task.cancel()


class TestBidirectionalRpc:
    async def test_server_requests_client(self, server):
        """Server can call methods registered on the client."""
        client = make_client(server.port)
        client.register("client.ping", lambda params: {"pong": True})

        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        # Get server-side connection and request client
        conns = server.get_connections()
        assert len(conns) == 1
        result = await conns[0].request("client.ping")
        assert result == {"pong": True}

        await client.disconnect()
        task.cancel()


class TestPubSub:
    async def test_client_receives_notification(self, server):
        client = make_client(server.port)
        received = []
        client.subscribe("test.event", lambda data: received.append(data))

        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        # Server broadcasts notification
        await server.broadcast("test.event", {"value": 42})
        await asyncio.sleep(0.1)

        assert len(received) == 1
        assert received[0] == {"value": 42}

        await client.disconnect()
        task.cancel()

    async def test_server_receives_notification_via_subscribe(self, server):
        """server.subscribe() registers a global notification listener with conn."""
        received = []
        server.subscribe("client.hello", lambda data, conn: received.append({
            "data": data,
            "role": conn.meta.get("role"),
        }))

        client = make_client(server.port)
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        await client.publish("client.hello", {"from": "test"})
        await asyncio.sleep(0.1)

        assert len(received) == 1
        assert received[0] == {"data": {"from": "test"}, "role": "web"}

        await client.disconnect()
        task.cancel()

    async def test_server_receives_notification_via_conn_subscribe(self, server):
        """conn.subscribe() on individual connection still works."""
        client = make_client(server.port)
        received = []

        def on_connect(conn):
            conn.subscribe("client.hello", lambda data: received.append(data))

        server.on_connect(on_connect)

        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        await client.publish("client.hello", {"from": "test"})
        await asyncio.sleep(0.1)

        assert len(received) == 1
        assert received[0] == {"from": "test"}

        await client.disconnect()
        task.cancel()


class TestDecorators:
    """Test @server.method() and @server.subscription() decorators."""

    async def test_method_decorator(self):
        srv = RpcServer(host="127.0.0.1", port=0, ping_interval=300)

        @srv.method("echo")
        def echo(params, conn):
            return params

        @srv.method()  # uses function name
        def add(params, conn):
            return {"sum": params["a"] + params["b"]}

        await srv.start()
        port = srv._server.sockets[0].getsockname()[1]

        client = make_client(port)
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        assert await client.request("echo", {"x": 1}) == {"x": 1}
        assert await client.request("add", {"a": 3, "b": 4}) == {"sum": 7}

        await client.disconnect()
        task.cancel()
        await srv.stop()

    async def test_subscription_decorator(self):
        srv = RpcServer(host="127.0.0.1", port=0, ping_interval=300)
        received = []

        @srv.subscription("chat.message")
        def on_chat(data, conn):
            received.append({"data": data, "role": conn.meta.get("role")})

        await srv.start()
        port = srv._server.sockets[0].getsockname()[1]

        client = make_client(port)
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        await client.publish("chat.message", {"msg": "hello"})
        await asyncio.sleep(0.1)

        assert len(received) == 1
        assert received[0] == {"data": {"msg": "hello"}, "role": "web"}

        await client.disconnect()
        task.cancel()
        await srv.stop()

    async def test_subscription_decorator_default_name(self):
        srv = RpcServer(host="127.0.0.1", port=0, ping_interval=300)
        received = []

        @srv.subscription()  # uses function name "ping_event"
        def ping_event(data, conn):
            received.append(data)

        await srv.start()
        port = srv._server.sockets[0].getsockname()[1]

        client = make_client(port)
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        await client.publish("ping_event", {"ts": 123})
        await asyncio.sleep(0.1)

        assert received == [{"ts": 123}]

        await client.disconnect()
        task.cancel()
        await srv.stop()


class TestBatchRequest:
    """Test batch RPC request support."""

    async def test_batch_request_basic(self, server):
        client = make_client(server.port)
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

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
        task.cancel()

    async def test_batch_request_with_error(self, server):
        """Batch with an error returns RpcError for that item."""
        client = make_client(server.port)
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

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
        task.cancel()

    async def test_batch_request_empty(self, server):
        client = make_client(server.port)
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        results = await client.batch_request([])
        assert results == []

        await client.disconnect()
        task.cancel()

    async def test_batch_request_preserves_order(self, server):
        """Results should be in request order, not response arrival order."""
        # Register a method that has variable delay
        async def slow_echo(params, conn):
            import random
            await asyncio.sleep(random.uniform(0.01, 0.05))
            return params

        server.register("slow_echo", slow_echo)

        client = make_client(server.port)
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        calls = [("slow_echo", {"i": i}) for i in range(10)]
        results = await client.batch_request(calls)

        for i, r in enumerate(results):
            assert r == {"i": i}

        await client.disconnect()
        task.cancel()


class TestMultipleWebClients:
    async def test_broadcast_to_all_web(self, server):
        """Multiple web clients all receive broadcast."""
        clients = []
        tasks = []
        for i in range(3):
            c = make_client(server.port, role="web", client_id=f"web-{i}")
            t = asyncio.create_task(c.connect())
            await c.wait_connected()
            clients.append(c)
            tasks.append(t)

        received = {i: [] for i in range(3)}
        for i, c in enumerate(clients):
            c.subscribe("broadcast", lambda data, idx=i: received[idx].append(data))

        await server.broadcast("broadcast", {"msg": "hello all"}, role="web")
        await asyncio.sleep(0.1)

        for i in range(3):
            assert len(received[i]) == 1
            assert received[i][0] == {"msg": "hello all"}

        for c, t in zip(clients, tasks):
            await c.disconnect()
            t.cancel()
