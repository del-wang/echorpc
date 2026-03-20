# VibeRPC

基于 WebSocket 的 JSON-RPC 2.0 全栈实现，包含 Python (server) 和 TypeScript (universal client) 两端。

## Features

- JSON-RPC 2.0 strict compliance
- **Universal client** — 同一份代码在 Node.js / 浏览器运行
- Bidirectional RPC (server ↔ client)
- Bidirectional events (emit / on)
- **Server handlers receive `conn`** — the calling connection, for calling/emitting back
- **Python decorators** — `@server.method()` and `@server.event()` for clean registration
- Auto-reconnect with exponential backoff
- Heartbeat ping/pong
- Token + role authentication
- Broadcast to connection groups
- Request timeout
- Typed errors with error codes

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

# Listen for client events — callback receives (data, conn)
@server.event("chat.message")
async def on_chat(data, conn):
    # conn is the connection that emitted — use it to broadcast to others
    await server.broadcast_event_except("chat.message", data, exclude=conn)

# Or inline
server.on("user.typing", lambda data, conn: print(f"{conn.meta['role']} is typing"))

# Lifecycle hooks
server.on_connect(lambda conn: print(f"connected: {conn.meta}"))
server.on_disconnect(lambda conn: print(f"disconnected: {conn.meta}"))

await server.serve_forever()
```

**Server handler `conn`**: Every handler registered via `server.register()` or `@server.method()` receives the calling `RpcConnection` as the second argument. Use it to:

- Read caller info: `conn.meta['role']`, `conn.meta['client_id']`
- Call back: `await conn.call("client.method", params)`
- Emit to caller: `await conn.emit("event.name", data)`

### Python Client

```python
from viberpc import RpcClient

client = RpcClient("ws://localhost:9100", token="secret", role="node")
client.register("node.method", handler)   # no conn — only one server
client.on("event_name", callback)
await client.connect()
result = await client.call("echo", {"msg": "hi"})
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

// Handler can call back into the client via conn
server.register("ask.client", async (params, conn) => {
  const answer = await conn.call("client.compute", params);
  return { answer };
});

// Server-level event listener — receives (data, conn)
server.on("chat.message", (data, conn) => {
  server.broadcastEventExcept("chat.message", data, conn);
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
rpc.on("event_name", callback);
rpc.connect();
await rpc.waitConnected();

const result = await rpc.call("echo", { msg: "hi" });
rpc.emit("event_name", { key: "value" });
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

// Direct call to server
const result = await rpc.call("echo", { msg: "hi" });
```

## Handler Signature Summary

| Location                  | `register` handler         | `on` callback          |
| ------------------------- | -------------------------- | ---------------------- |
| **Server** (Python/TS)    | `(params, conn) => result` | `(data, conn) => void` |
| **Client** (Python/TS)    | `(params) => result`       | `(data) => void`       |
| **Connection** (per-conn) | `(params) => result`       | `(data) => void`       |

`conn` is always the `RpcConnection` — the specific client that made the call or emitted the event.
