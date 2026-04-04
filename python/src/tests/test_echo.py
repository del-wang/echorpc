"""Integration tests for EchoServer / EchoClient convenience classes."""

import asyncio

import pytest

from echorpc import EchoClient, EchoServer, ErrorCode, RpcError

pytestmark = pytest.mark.asyncio


def make_client(port: int, role: str = "web", **kwargs) -> EchoClient:
    return EchoClient(
        f"ws://127.0.0.1:{port}",
        token="test-token",
        role=role,
        auto_reconnect=False,
        ping_interval=300,
        **kwargs,
    )


# ── Basic RPC ──────────────────────────────────────────────────────────


class TestBasicRpc:
    @pytest.fixture(autouse=True)
    async def setup(self):
        self.server = EchoServer(host="127.0.0.1", port=0, ping_interval=300)
        self.server.register("echo", lambda conn, params: params)
        self.server.register(
            "add", lambda conn, params: {"sum": params["a"] + params["b"]}
        )
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

    async def test_method_not_found(self):
        client = make_client(self.port)
        await client.connect()
        with pytest.raises(RpcError) as exc_info:
            await client.request("nonexistent")
        assert exc_info.value.code == ErrorCode.METHOD_NOT_FOUND
        await client.disconnect()


# ── Decorators ─────────────────────────────────────────────────────────


class TestDecorators:
    @pytest.fixture(autouse=True)
    async def setup(self):
        self.server = EchoServer(host="127.0.0.1", port=0, ping_interval=300)

        @self.server.command("greet")
        def greet(params):
            return f"hello {params['name']}"

        @self.server.command()
        def ping_test():
            return "pong"

        await self.server.start()
        self.port = self.server.address[1]
        yield
        await self.server.stop()

    async def test_decorator_with_name(self):
        client = make_client(self.port)
        await client.connect()
        result = await client.request("greet", {"name": "world"})
        assert result == "hello world"
        await client.disconnect()

    async def test_decorator_infers_name(self):
        client = make_client(self.port)
        await client.connect()
        result = await client.request("ping_test")
        assert result == "pong"
        await client.disconnect()


# ── Pub/Sub ────────────────────────────────────────────────────────────


class TestPubSub:
    @pytest.fixture(autouse=True)
    async def setup(self):
        self.server = EchoServer(host="127.0.0.1", port=0, ping_interval=300)

        @self.server.event("chat")
        async def on_chat(conn, data):
            await self.server.broadcast("chat", data)

        await self.server.start()
        self.port = self.server.address[1]
        yield
        await self.server.stop()

    async def test_pub_sub(self):
        client1 = make_client(self.port)
        client2 = make_client(self.port)
        await client1.connect()
        await client2.connect()

        received = asyncio.Future()
        client2.subscribe("chat", lambda data: received.set_result(data))

        await client1.publish("chat", {"text": "hi"})
        result = await asyncio.wait_for(received, timeout=5)
        assert result == {"text": "hi"}

        await client1.disconnect()
        await client2.disconnect()


# ── Batch Requests ─────────────────────────────────────────────────────


class TestBatchRequests:
    @pytest.fixture(autouse=True)
    async def setup(self):
        self.server = EchoServer(host="127.0.0.1", port=0, ping_interval=300)
        self.server.register(
            "add", lambda conn, params: {"sum": params["a"] + params["b"]}
        )
        await self.server.start()
        self.port = self.server.address[1]
        yield
        await self.server.stop()

    async def test_batch_request(self):
        client = make_client(self.port)
        await client.connect()
        results = await client.batch_request(
            [
                ("add", {"a": 1, "b": 2}),
                ("add", {"a": 3, "b": 4}),
            ]
        )
        assert results == [{"sum": 3}, {"sum": 7}]
        await client.disconnect()


# ── Connection Management ──────────────────────────────────────────────


class TestConnectionManagement:
    @pytest.fixture(autouse=True)
    async def setup(self):
        self.server = EchoServer(host="127.0.0.1", port=0, ping_interval=300)
        await self.server.start()
        self.port = self.server.address[1]
        yield
        await self.server.stop()

    async def test_on_connect_disconnect(self):
        connected = asyncio.Future()
        disconnected = asyncio.Future()
        self.server.on_connect(lambda conn: connected.set_result(True))
        self.server.on_disconnect(lambda conn: disconnected.set_result(True))

        client = make_client(self.port)
        await client.connect()
        assert await asyncio.wait_for(connected, timeout=5)

        await client.disconnect()
        assert await asyncio.wait_for(disconnected, timeout=5)

    async def test_get_connections_by_role(self):
        c1 = make_client(self.port, role="admin")
        c2 = make_client(self.port, role="web")
        await c1.connect()
        await c2.connect()
        await asyncio.sleep(0.1)

        assert len(self.server.get_connections()) == 2
        assert len(self.server.get_connections("admin")) == 1
        assert len(self.server.get_connections("web")) == 1

        await c1.disconnect()
        await c2.disconnect()


# ── Underlying transport access ────────────────────────────────────────


class TestUnderlyingAccess:
    async def test_ws_and_rpc_exposed(self):
        server = EchoServer(host="127.0.0.1", port=0, ping_interval=300)
        assert server.ws is not None
        assert server.core is not None

        client = make_client(9999)
        assert client.ws is not None
        assert client.core is not None
