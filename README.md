# VibeRPC

Bidirectional WebSocket JSON-RPC 2.0 for Python and TypeScript. One protocol, both directions, batch support, pub/sub — works in Node.js and browsers.

## Features

- **JSON-RPC 2.0** compliant (requests, notifications, batch, error codes)
- **Bidirectional RPC** — server can call client methods and vice versa
- **Pub/Sub** — `publish` / `subscribe` notifications in both directions
- **Batch requests** — send multiple calls in one frame, results in order
- **Upgrade-level auth** — token validated during HTTP handshake, rejected connections never open
- **Universal TS client** — same code runs in Node.js and browsers
- **Auto-reconnect** with exponential backoff
- **Heartbeat** ping/pong
- **Broadcast** to all or role-filtered connections

## Install

```bash
# Python
cd python && pip install -e .

# TypeScript
cd typescript && npm install
```

## Quick Start

### Python Server

```python
from viberpc import RpcServer

server = RpcServer(port=9100, auth_handler=lambda p: True)

@server.method("echo")
def echo(conn, params):
    return params

@server.method("add")
def add(conn, params):
    return params["a"] + params["b"]

await server.start()
```

### Python Client

```python
from viberpc import RpcClient

client = RpcClient("ws://localhost:9100", token="secret", role="node")
await client.connect()

result = await client.request("echo", {"msg": "hi"})
results = await client.batch_request([
    ("echo", {"x": 1}),
    ("add", {"a": 1, "b": 2}),
])
```

### TypeScript Server (Node.js)

```ts
import { RpcServer } from "viberpc/server";

const server = new RpcServer({ port: 9100 });
server.register("echo", (conn, params) => params);
await server.start();
```

### TypeScript Client (Node.js)

```ts
import WebSocket from "ws";
import { RpcClient } from "viberpc";

const rpc = new RpcClient("ws://localhost:9100", {
  token: "secret",
  role: "node",
  WebSocket: WebSocket as any,
});

rpc.connect();
await rpc.waitConnected();
const result = await rpc.request("echo", { msg: "hi" });
```

### TypeScript Client (Browser)

```ts
import { RpcClient } from "viberpc";

const rpc = new RpcClient("ws://localhost:9100", {
  token: "secret",
  role: "web",
});
rpc.connect();
```

## Authentication

Auth happens at the **WebSocket upgrade handshake** — not after connection. Credentials are sent as URL query parameters (`?token=...&role=...&client_id=...`).

On the server side, provide an `authHandler` / `auth_handler`:

```python
# Python — throw to reject
server = RpcServer(
    port=9100,
    auth_handler=lambda p: verify_token(p["token"]),
)
```

```ts
// TypeScript — throw to reject
const server = new RpcServer({
  port: 9100,
  authHandler: (params) => {
    if (params.token !== "valid") throw new Error("unauthorized");
  },
});
```

If the handler throws, the server responds with **HTTP 401** and the WebSocket is never established. No `authHandler` means all connections are accepted.

## Bidirectional RPC

Server handlers receive `(conn, params)`. Use `conn` to call back into the client:

```python
@server.method("ask.client")
async def ask(conn, params):
    answer = await conn.request("client.compute", params)
    return {"answer": answer}
```

Clients register methods the server can call:

```ts
rpc.register("client.compute", (params) => params.a * params.b);
```

## Pub/Sub

```python
# Server — subscribe to client notifications (receives conn)
@server.subscription("chat.message")
async def on_chat(conn, data):
    await server.broadcast_except("chat.message", data, exclude=conn)

# Client — subscribe to server notifications
client.subscribe("chat.message", lambda data: print(data))

# Publish from either side
await client.publish("chat.message", {"text": "hello"})
server.broadcast("chat.message", {"text": "hello"}, role="web")
```

## Batch Requests

```python
results = await client.batch_request([
    ("echo", {"x": 1}),
    ("add", {"a": 1, "b": 2}),
    ("fail", None),
])
# results[2] is an RpcError instance
```

```ts
const results = await rpc.batchRequest([
  ["echo", { x: 1 }],
  ["add", { a: 1, b: 2 }],
]);
```

## Handler Signatures

| Location | `register` handler | `subscribe` callback |
| --- | --- | --- |
| **Server** | `(conn, params) → result` | `(conn, data) → void` |
| **Client** | `(params) → result` | `(data) → void` |

`conn` is the `RpcConnection` of the caller — use it to read `conn.meta.role`, request back, or publish to that specific client.

## Error Codes

| Code | Name | Description |
| --- | --- | --- |
| -32700 | Parse error | Invalid JSON |
| -32600 | Invalid Request | Not a valid JSON-RPC 2.0 request |
| -32601 | Method not found | Method does not exist |
| -32602 | Invalid params | Invalid method parameters |
| -32603 | Internal error | Internal JSON-RPC error |
| -32001 | Not connected | WebSocket not connected |
| -32002 | Timeout | Request timed out |
| -32003 | Auth failed | Authentication failed |


## Development

```bash
# Python tests
cd python && python -m pytest tests/ -v

# TypeScript tests
cd typescript && npm run vitest run
```

## License

MIT
