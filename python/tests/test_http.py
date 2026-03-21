"""Integration tests for the HTTP transport layer.

Mirrors typescript/tests/http.test.ts
"""

import asyncio

import pytest

from viberpc import RpcServer, RpcClient, RpcError, ErrorCode
from viberpc.http import HttpServer, HttpClient

pytestmark = pytest.mark.asyncio


# ── Basic HTTP RPC ────────────────────────────────────────────────────


class TestBasicRpc:
    @pytest.fixture(autouse=True)
    async def setup(self):
        http_server = HttpServer(host="127.0.0.1", port=0)
        self.server = RpcServer(http_server)
        self.server.register("echo", lambda conn, params: params)
        self.server.register("add", lambda conn, params: {"sum": params["a"] + params["b"]})

        async def throws(conn, params):
            raise RpcError(ErrorCode.INVALID_PARAMS, "bad params")

        self.server.register("throws", throws)

        await self.server.start()
        self.port = self.server.address[1]
        yield
        await self.server.stop()

    async def test_connect_via_http(self):
        transport = HttpClient(
            f"http://127.0.0.1:{self.port}",
            token="test-token", role="web", callback_host="127.0.0.1",
        )
        client = RpcClient(transport)
        await client.connect()
        assert client.connected
        await client.disconnect()

    async def test_request_echo(self):
        transport = HttpClient(
            f"http://127.0.0.1:{self.port}",
            token="test-token", role="web", callback_host="127.0.0.1",
        )
        client = RpcClient(transport)
        await client.connect()
        result = await client.request("echo", {"msg": "hello"})
        assert result == {"msg": "hello"}
        await client.disconnect()

    async def test_request_add(self):
        transport = HttpClient(
            f"http://127.0.0.1:{self.port}",
            token="test-token", role="web", callback_host="127.0.0.1",
        )
        client = RpcClient(transport)
        await client.connect()
        result = await client.request("add", {"a": 10, "b": 20})
        assert result == {"sum": 30}
        await client.disconnect()

    async def test_rpc_error_from_handler(self):
        transport = HttpClient(
            f"http://127.0.0.1:{self.port}",
            token="test-token", callback_host="127.0.0.1",
        )
        client = RpcClient(transport)
        await client.connect()
        with pytest.raises(RpcError) as exc_info:
            await client.request("throws")
        assert exc_info.value.code == ErrorCode.INVALID_PARAMS
        await client.disconnect()

    async def test_method_not_found(self):
        transport = HttpClient(
            f"http://127.0.0.1:{self.port}",
            callback_host="127.0.0.1",
        )
        client = RpcClient(transport)
        await client.connect()
        with pytest.raises(RpcError) as exc_info:
            await client.request("nonexistent")
        assert exc_info.value.code == ErrorCode.METHOD_NOT_FOUND
        await client.disconnect()


# ── HTTP Auth ──────────────────────────────────────────────────────────


class TestAuth:
    async def test_valid_token(self):
        def auth(params):
            if params["token"] != "valid-token":
                raise Exception("invalid token")

        http_server = HttpServer(host="127.0.0.1", port=0, auth_handler=auth)
        server = RpcServer(http_server)
        server.register("echo", lambda conn, p: p)
        await server.start()
        port = server.address[1]

        transport = HttpClient(
            f"http://127.0.0.1:{port}",
            token="valid-token", callback_host="127.0.0.1",
        )
        client = RpcClient(transport)
        await client.connect()
        assert client.connected

        result = await client.request("echo", "ok")
        assert result == "ok"

        await client.disconnect()
        await server.stop()

    async def test_invalid_token(self):
        def auth(params):
            if params["token"] != "valid-token":
                raise Exception("invalid token")

        http_server = HttpServer(host="127.0.0.1", port=0, auth_handler=auth)
        server = RpcServer(http_server)
        await server.start()
        port = server.address[1]

        auth_failed = False
        transport = HttpClient(
            f"http://127.0.0.1:{port}",
            token="wrong-token", callback_host="127.0.0.1",
        )

        def on_auth_failed():
            nonlocal auth_failed
            auth_failed = True

        transport.on_auth_failed = on_auth_failed

        client = RpcClient(transport)
        await client.connect()
        assert not client.connected
        assert auth_failed

        await server.stop()


# ── Bidirectional HTTP RPC ──────────────────────────────────────────────


class TestBidirectionalRpc:
    async def test_server_calls_client_via_callback(self):
        http_server = HttpServer(host="127.0.0.1", port=0)
        server = RpcServer(http_server)
        server.register("echo", lambda conn, params: params)
        await server.start()
        port = server.address[1]

        transport = HttpClient(
            f"http://127.0.0.1:{port}",
            token="t", role="node", callback_host="127.0.0.1",
        )
        client = RpcClient(transport)
        client.register("client.ping", lambda params: "pong")
        await client.connect()
        assert client.connected

        await asyncio.sleep(0.1)

        conns = server.get_connections("node")
        assert len(conns) >= 1
        result = await conns[0].request("client.ping")
        assert result == "pong"

        await client.disconnect()
        await server.stop()
