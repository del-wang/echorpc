# EchoRPC

Bidirectional JSON-RPC 2.0 over WebSocket — TypeScript & Python.

> **Note:** This project is under active development. APIs may change before v1.0.

```bash
# TypeScript
pnpm add echorpc

# Python
pip install echorpc
```

## Features

- **Bidirectional RPC** — server and client can call each other's methods
- **Pub/Sub** — fire-and-forget notifications via `publish` / `subscribe`
- **Batch requests** — multiple calls per frame, results returned in order
- **Auth** — token validated during HTTP upgrade
- **Heartbeat** — ping/pong with auto-disconnect on timeout
- **Auto-reconnect** — exponential backoff, handlers and subscriptions preserved
- **Broadcast** — send to all connections, filter by role, or exclude specific peers

## Server

**Python**

```python
from echorpc import RpcServer, WsServer

def auth(params):
    if params["token"] != "secret":
        return False
    # Return True to allow, or a dict to merge into conn.meta:
    return {"user_id": "u1", "role": params["role"]}

ws = WsServer(port=9100, auth_handler=auth)
server = RpcServer(ws)

@server.method("add")
def add(conn, params):
    return {"sum": params["a"] + params["b"]}

# Server can call client methods
@server.method("ask.client")
async def ask_client(conn, params):
    return await conn.request("client.compute", params)

# Pub/Sub — broadcast incoming messages to all clients
@server.subscription("chat")
async def on_chat(conn, data):
    await server.broadcast("chat", data)

await server.start()
```

**TypeScript**

```ts
import { RpcServer, WsServer } from "echorpc";

const ws = new WsServer({
  port: 9100,
  authHandler: (params) => {
    if (params.token !== "secret") return false;
    // Return true to allow, or an object to merge into conn.meta:
    return { userId: "u1", role: params.role };
  },
});
const server = new RpcServer(ws);

server.register("add", (conn, p: { a: number; b: number }) => ({
  sum: p.a + p.b,
}));

await server.start();
```

## Client

**Python**

```python
from echorpc import RpcClient, WsClient

client = RpcClient(WsClient("ws://localhost:9100", token="secret"))
await client.connect()

# RPC call
result = await client.request("add", {"a": 1, "b": 2})

# Batch
results = await client.batch_request([
    ("add", {"a": 1, "b": 2}),
    ("add", {"a": 3, "b": 4}),
])

# Register a method the server can call back
client.register("client.compute", lambda p: p["x"] * 2)

# Pub/Sub
client.subscribe("chat", lambda data: print(data))
await client.publish("chat", {"text": "hello"})
```

**TypeScript (Node.js)**

```ts
import WebSocket from "ws";
import { RpcClient, WsClient } from "echorpc";

const transport = new WsClient("ws://localhost:9100", {
  token: "secret",
  WebSocket,
});
const client = new RpcClient(transport);
await client.connect();

const result = await client.request("add", { a: 1, b: 2 });
```

**TypeScript (Browser)** — no `WebSocket` import needed, uses the native one.

```ts
import { RpcClient, WsClient } from "echorpc";

const transport = new WsClient("ws://localhost:9100", { token: "secret" });
const client = new RpcClient(transport);
await client.connect();
```

## Error Codes

| Code   | Name             | Meaning                 |
| ------ | ---------------- | ----------------------- |
| -32700 | Parse error      | Invalid JSON            |
| -32601 | Method not found | No such method          |
| -32603 | Internal error   | Handler threw           |
| -32001 | Not connected    | No active connection    |
| -32002 | Timeout          | Request timed out       |
| -32003 | Auth failed      | Authentication rejected |

## License

MIT License © 2026-PRESENT [Del Wang](https://del.wang)
