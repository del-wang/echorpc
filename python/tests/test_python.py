"""Tests for the Python viberpc package."""

# python -m pytest tests/test_python.py -v

import asyncio
import sys
import os

import pytest
import pytest_asyncio

from viberpc import RpcServer, RpcClient, RpcError, ErrorCode

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def server():
    """Start a test server on a random port."""
    srv = RpcServer(host="127.0.0.1", port=0, ping_interval=300)

    # Register test methods
    srv.register("echo", lambda params: params)
    srv.register("add", lambda params: {"sum": params["a"] + params["b"]})

    async def _fail(params):
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

        result = await client.call("echo", {"hello": "world"})
        assert result == {"hello": "world"}

        await client.disconnect()
        task.cancel()

    async def test_add(self, server):
        client = make_client(server.port)
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        result = await client.call("add", {"a": 10, "b": 20})
        assert result == {"sum": 30}

        await client.disconnect()
        task.cancel()

    async def test_method_not_found(self, server):
        client = make_client(server.port)
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        with pytest.raises(RpcError) as exc_info:
            await client.call("nonexistent")
        assert exc_info.value.code == ErrorCode.METHOD_NOT_FOUND

        await client.disconnect()
        task.cancel()

    async def test_rpc_error(self, server):
        client = make_client(server.port)
        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        with pytest.raises(RpcError) as exc_info:
            await client.call("fail")
        assert exc_info.value.code == -100

        await client.disconnect()
        task.cancel()


class TestBidirectionalRpc:
    async def test_server_calls_client(self, server):
        """Server can call methods registered on the client."""
        client = make_client(server.port)
        client.register("client.ping", lambda params: {"pong": True})

        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        # Get server-side connection and call client
        conns = server.get_connections()
        assert len(conns) == 1
        result = await conns[0].call("client.ping")
        assert result == {"pong": True}

        await client.disconnect()
        task.cancel()


class TestEvents:
    async def test_client_receives_event(self, server):
        client = make_client(server.port)
        received = []
        client.on("test.event", lambda data: received.append(data))

        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        # Server broadcasts event
        await server.broadcast_event("test.event", {"value": 42})
        await asyncio.sleep(0.1)

        assert len(received) == 1
        assert received[0] == {"value": 42}

        await client.disconnect()
        task.cancel()

    async def test_server_receives_event(self, server):
        client = make_client(server.port)
        received = []

        def on_connect(conn):
            conn.on("client.hello", lambda data: received.append(data))

        server.on_connect(on_connect)

        task = asyncio.create_task(client.connect())
        await client.wait_connected()

        await client.emit("client.hello", {"from": "test"})
        await asyncio.sleep(0.1)

        assert len(received) == 1
        assert received[0] == {"from": "test"}

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
            c.on("broadcast", lambda data, idx=i: received[idx].append(data))

        await server.broadcast_event("broadcast", {"msg": "hello all"}, role="web")
        await asyncio.sleep(0.1)

        for i in range(3):
            assert len(received[i]) == 1
            assert received[i][0] == {"msg": "hello all"}

        for c, t in zip(clients, tasks):
            await c.disconnect()
            t.cancel()
