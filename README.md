# VibeRPC

基于 WebSocket 的 JSON-RPC 2.0 全栈实现，包含 Python (server) 和 TypeScript (universal client) 两端。

## Features

- JSON-RPC 2.0 strict compliance
- **Universal client** — 同一份代码在 Node.js / 浏览器运行
- Bidirectional RPC (`register` / `request`)
- Bidirectional notifications (`subscribe` / `publish`)
- **Batch requests** — `batchRequest` 批量调用，结果按请求顺序返回
- **Server handlers receive `conn`** — the calling connection, for requesting/publishing back
- **Python decorators** — `@server.method()` and `@server.subscription()` for clean registration
- Auto-reconnect with exponential backoff
- Heartbeat ping/pong
- Token + role authentication
- Broadcast to connection groups
- Request timeout
- Typed errors with JSON-RPC 2.0 standard error codes

## Package Structure

```
viberpc/
├── python/                    # Python server + client
│   ├── viberpc/
│   │   ├── __init__.py
│   │   ├── core.py            # Types, error codes, constants
│   │   ├── connection.py      # Single WS connection handler
│   │   ├── server.py          # WS server
│   │   └── client.py          # Auto-reconnect client
│   ├── pyproject.toml
│   └── requirements.txt
├── typescript/                # Universal TypeScript client + server
│   ├── src/
│   │   ├── core.ts            # Types, error codes, WS abstraction
│   │   ├── connection.ts      # Server-side per-connection handler
│   │   ├── server.ts          # WS server
│   │   ├── client.ts          # Universal RpcClient
│   │   └── index.ts           # Exports
│   ├── package.json
│   └── tsconfig.json
└── README.md
```

## API Reference

### Python Server

```python
from viberpc import RpcServer

server = RpcServer(host="0.0.0.0", port=9100)

# Register with decorator — handler receives (params, conn)
@server.method("echo")
def echo(params, conn):
    return params

@server.method("add")
def add(params, conn):
    return {"sum": params["a"] + params["b"]}

# Or register inline
server.register("greet", lambda params, conn: f"hello {conn.meta['role']}")

# Subscribe to client notifications — callback receives (data, conn)
@server.subscription("chat.message")
async def on_chat(data, conn):
    # conn is the connection that published — broadcast to others
    await server.broadcast_except("chat.message", data, exclude=conn)

# Or inline
server.subscribe("user.typing", lambda data, conn: print(f"{conn.meta['role']} is typing"))

# Lifecycle hooks
server.on_connect(lambda conn: print(f"connected: {conn.meta}"))
server.on_disconnect(lambda conn: print(f"disconnected: {conn.meta}"))

await server.serve_forever()
```

**Server handler `conn`**: Every handler registered via `server.register()` or `@server.method()` receives the calling `RpcConnection` as the second argument. Use it to:

- Read caller info: `conn.meta['role']`, `conn.meta['client_id']`
- Request back: `await conn.request("client.method", params)`
- Publish to caller: `await conn.publish("notification.name", data)`

### Python Client

```python
from viberpc import RpcClient

client = RpcClient("ws://localhost:9100", token="secret", role="node")
client.register("node.method", handler)   # no conn — only one server
client.subscribe("notification_name", callback)
await client.connect()
result = await client.request("echo", {"msg": "hi"})

# Batch requests — results in request order
results = await client.batch_request([
    ("echo", {"msg": "hi"}),
    ("add", {"a": 1, "b": 2}),
])
```

### TypeScript Server (Node.js)

```typescript
import { RpcServer } from "viberpc/server";

const server = new RpcServer({ port: 9100 });

// Handler receives (params, conn) — conn is the calling RpcConnection
server.register("echo", (params, conn) => params);

server.register("greet", (params, conn) => {
  return `hello ${conn.meta.role}`;
});

// Handler can request back into the client via conn
server.register("ask.client", async (params, conn) => {
  const answer = await conn.request("client.compute", params);
  return { answer };
});

// Server-level notification subscriber — receives (data, conn)
server.subscribe("chat.message", (data, conn) => {
  server.broadcastExcept("chat.message", data, conn);
});

server.onConnect((conn) => console.log("connected:", conn.meta.role));

await server.start();
```

### TypeScript Client (Node.js)

```typescript
import WebSocket from "ws";
import { RpcClient } from "viberpc";

const rpc = new RpcClient("ws://localhost:9100", {
  token: "secret",
  role: "node",
  WebSocket: WebSocket as any, // pass ws implementation
});

rpc.register("node.method", handler); // no conn — only one server
rpc.subscribe("notification_name", callback);
rpc.connect();
await rpc.waitConnected();

const result = await rpc.request("echo", { msg: "hi" });
rpc.publish("notification_name", { key: "value" });

// Batch requests — results in request order
const results = await rpc.batchRequest([
  ["echo", { msg: "hi" }],
  ["add", { a: 1, b: 2 }],
]);
```

### TypeScript Client (Browser)

```typescript
import { RpcClient } from "viberpc";

// Browser: no WebSocket option needed, uses native WebSocket
const rpc = new RpcClient("ws://localhost:9100", {
  token: "secret",
  role: "web",
});

rpc.connect();
await rpc.waitConnected();

// Direct request to server
const result = await rpc.request("echo", { msg: "hi" });
```

## Handler Signature Summary

| Location                  | `register` handler         | `subscribe` callback   |
| ------------------------- | -------------------------- | ---------------------- |
| **Server** (Python/TS)    | `(params, conn) => result` | `(data, conn) => void` |
| **Client** (Python/TS)    | `(params) => result`       | `(data) => void`       |
| **Connection** (per-conn) | `(params) => result`       | `(data) => void`       |

`conn` is always the `RpcConnection` — the specific client that made the call or published the notification.

## Error Codes

| Code     | Name             | Description                             |
| -------- | ---------------- | --------------------------------------- |
| -32700   | Parse error      | Invalid JSON                            |
| -32600   | Invalid Request  | Not a valid JSON-RPC 2.0 request        |
| -32601   | Method not found | Method does not exist                   |
| -32602   | Invalid params   | Invalid method parameters               |
| -32603   | Internal error   | Internal JSON-RPC error                 |
| -32001   | Not connected    | WebSocket not connected                 |
| -32002   | Timeout          | Request timed out                       |
| -32003   | Auth failed      | Authentication failed                   |

Custom error codes use the JSON-RPC 2.0 server-reserved range (-32000 to -32099).

## JSON-RPC 2.0 Compliance

- All messages include `"jsonrpc": "2.0"`
- Requests have `id` + `method` + optional `params`
- Responses have `id` + either `result` or `error` (never both)
- Notifications are requests without `id` (used for pub/sub)
- Batch requests/responses follow the spec (array of messages)
- Error objects contain `code` (integer) + `message` (string) + optional `data`
