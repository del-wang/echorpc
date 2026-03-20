# WS JSON-RPC 2.0 Demo

基于 WebSocket 的 JSON-RPC 2.0 全栈实现，包含 Python (server) 和 TypeScript (universal client) 两端。

## Architecture

```
┌──────────┐         ┌──────────────────┐         ┌──────────┐
│  Web UI  │◄──ws──►│  Python Server   │◄──ws──►│  Node.js │
│ (多个连接) │         │  (主服务端)        │         │ (单连接)   │
└──────────┘         └──────────────────┘         └──────────┘
```

- **Python** 是主服务端，管理所有连接
- **Node.js** 以 `role: "node"` 连接，有且仅有一个连接
- **Web** 以 `role: "web"` 连接，可以有多个
- **TypeScript client 是同一个包**，Node.js 和浏览器通过 `WebSocket` option 区分运行时

## Features

- JSON-RPC 2.0 strict compliance
- **Universal client** — 同一份代码在 Node.js / 浏览器运行
- Bidirectional RPC (server ↔ client)
- Bidirectional events (emit / on)
- Auto-reconnect with exponential backoff
- Heartbeat ping/pong
- Token + role authentication
- Broadcast to connection groups
- Request timeout
- Typed errors with error codes

## Package Structure

```
json-rpc-demo/
├── python/                    # Python server package
│   ├── viberpc/
│   │   ├── __init__.py
│   │   ├── core.py            # Types, error codes, constants
│   │   ├── connection.py      # Single WS connection handler
│   │   ├── server.py          # WS server
│   │   └── client.py          # Auto-reconnect client
│   ├── demo_server.py         # Demo server entry
│   ├── pyproject.toml
│   └── requirements.txt
├── ts/                        # Universal TypeScript client
│   ├── src/
│   │   ├── core.ts            # Types, error codes, WS abstraction
│   │   ├── client.ts          # Universal RpcClient
│   │   └── index.ts           # Exports
│   ├── demo/
│   │   ├── node-client.ts     # Node.js demo
│   │   └── web/index.html     # Browser demo UI
│   ├── test_client.test.ts    # Integration tests
│   ├── package.json
│   └── tsconfig.json
├── tests/
│   └── test_python.py         # Python unit tests
├── start.sh                   # Startup script
└── README.md
```

## API Reference

### Python Server

```python
from viberpc import RpcServer

server = RpcServer(host="0.0.0.0", port=9100)
server.register("echo", lambda params: params)
server.on_connect(lambda conn: print("connected"))
await server.serve_forever()
```

### Python Client

```python
from viberpc import RpcClient

client = RpcClient("ws://localhost:9100", token="secret", role="node")
client.register("node.method", handler)
client.on("event_name", callback)
await client.connect()
result = await client.call("echo", {"msg": "hi"})
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

rpc.register("node.method", handler);
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

// Direct call to Python server
const result = await rpc.call("echo", { msg: "hi" });
```
