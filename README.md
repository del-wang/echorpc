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

## TypeScript

### Server

```ts
import { EchoServer } from "echorpc";

const server = new EchoServer({
  port: 9100,
  authHandler: (p) => p.token === "secret",
});

// Register RPC handlers
server.register("add", (p: { a: number; b: number }) => ({
  sum: p.a + p.b,
}));
server.register("health", () => "ok");

// Use (conn, params) when you need the connection
server.register("ask.client", async (conn, p) => {
  return await conn.request("client.compute", p);
});

// Pub/Sub — broadcast incoming messages to all clients
server.subscribe("chat", async (conn, data) => {
  server.broadcast("chat", data);
});

await server.start();
```

### Client (Node.js)

```ts
import WebSocket from "ws";
import { EchoClient } from "echorpc";

const client = new EchoClient("ws://localhost:9100", {
  token: "secret",
  WebSocket,
});
await client.connect();

// RPC call
const result = await client.request("add", { a: 1, b: 2 });

// Batch
const results = await client.batchRequest([
  ["add", { a: 1, b: 2 }],
  ["add", { a: 3, b: 4 }],
]);

// Register a method the server can call back
client.register("client.compute", (p) => p.x * 2);

// Pub/Sub
client.subscribe("chat", (data) => console.log(data));
client.publish("chat", { text: "hello" });
```

### Client (Browser)

No `WebSocket` import needed — uses the native one.

```ts
import { EchoClient } from "echorpc";

const client = new EchoClient("ws://localhost:9100", { token: "secret" });
await client.connect();
```

## Python

### Server

```python
from echorpc import EchoServer

server = EchoServer(port=9100, auth_handler=lambda p: p["token"] == "secret")

# Handlers support flexible signatures: (conn, params), (params), or ()
@server.rpc("add")
def add(params):
    return {"sum": params["a"] + params["b"]}

@server.rpc("health")
def health():
    return "ok"

# Use (conn, params) when you need the connection
@server.rpc("ask.client")
async def ask_client(conn, params):
    return await conn.request("client.compute", params)

# Pub/Sub — broadcast incoming messages to all clients
@server.event("chat")
async def on_chat(conn, data):
    await server.broadcast("chat", data)

await server.start()
```

### Client

```python
from echorpc import EchoClient

client = EchoClient("ws://localhost:9100", token="secret")
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
