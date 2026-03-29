# EchoRPC

Bidirectional JSON-RPC 2.0 for TypeScript and Python — request, batch, pub/sub, auth, auto-reconnect.

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

## Python

### Server

```python
from echorpc import RpcServer, WsServer

# Auth handler: return to accept, raise to reject
def auth(params):
    if params["token"] != "secret":
        raise Exception("denied")       # → client gets RpcError(AUTH_FAILED)
    pass             # → accept, return value ignored

ws = WsServer(port=9100, auth_handler=auth)
server = RpcServer(ws)

# Register methods — decorator or imperative
@server.method("add")
def add(conn, params):
    return {"sum": params["a"] + params["b"]}

@server.method()                         # name inferred from function: "multiply"
def multiply(conn, params):
    return {"result": params["a"] * params["b"]}

server.register("echo", lambda conn, p: p)

# Bidirectional: call client from server handler
@server.method("ask.client")
async def ask_client(conn, params):
    return await conn.request("client.compute", params)

# Pub/Sub
@server.subscription("chat")
async def on_chat(conn, data):
    await server.broadcast("chat", data)

await server.start()                     # server.address → ("0.0.0.0", 9100)
```

### Client

```python
from echorpc import RpcClient, WsClient

transport = WsClient("ws://localhost:9100", token="secret", role="node")
client = RpcClient(transport)

await client.connect()                   # raises RpcError(AUTH_FAILED) / RpcError(TIMEOUT)

result = await client.request("add", {"a": 1, "b": 2})

# Register methods the server can call back
client.register("client.compute", lambda p: p["x"] * 2)

# Pub/Sub
client.subscribe("chat", lambda data: print(data))
await client.publish("chat", {"text": "hello"})

# Batch
results = await client.batch_request([("add", {"a": 1, "b": 2}), ("add", {"a": 3, "b": 4})])

await client.disconnect()
```

## TypeScript

### Server

```ts
import { RpcServer, WsServer, RpcError, ErrorCode } from "echorpc";

// Auth handler: return to accept, throw to reject
const ws = new WsServer({
  port: 9100,
  authHandler: (params) => {
    if (params.token !== "secret")
      throw new RpcError(ErrorCode.AUTH_FAILED, "denied"); // → client gets RpcError(AUTH_FAILED)
    return; // → accept, return value ignored
  },
});
const server = new RpcServer(ws);

server.register("add", (conn, p: { a: number; b: number }) => ({
  sum: p.a + p.b,
}));

// Bidirectional: call client from server handler
server.register(
  "ask.client",
  async (conn, p) => await conn.request("client.compute", p),
);

// Pub/Sub
server.subscribe("chat", (conn, data) => server.broadcast("chat", data));

await server.start(); // server.address → { host, port }
```

### Client — Node.js

```ts
import WebSocket from "ws";
import { RpcClient, WsClient } from "echorpc";

const transport = new WsClient("ws://localhost:9100", {
  token: "secret",
  role: "node",
  WebSocket,
});
const client = new RpcClient(transport);

await client.connect(); // throws RpcError(AUTH_FAILED) / RpcError(TIMEOUT)

const result = await client.request("add", { a: 1, b: 2 });

// Register methods the server can call back
client.register("client.compute", (p: { x: number }) => p.x * 2);

// Pub/Sub
client.subscribe("chat", (data) => console.log(data));
client.publish("chat", { text: "hello" });

// Batch
const results = await client.batchRequest([
  ["add", { a: 1, b: 2 }],
  ["add", { a: 3, b: 4 }],
]);

await client.disconnect();
```

### Client — Browser

```ts
import { RpcClient, WsClient } from "echorpc";

// Browser has native WebSocket — no import needed
const transport = new WsClient("ws://localhost:9100", {
  token: "secret",
  role: "web",
});
const client = new RpcClient(transport);
await client.connect();
```

## Error Codes

| Code   | Name             | Meaning                 |
| ------ | ---------------- | ----------------------- |
| -32700 | Parse error      | Invalid JSON            |
| -32600 | Invalid Request  | Malformed JSON-RPC      |
| -32601 | Method not found | No such method          |
| -32602 | Invalid params   | Bad parameters          |
| -32603 | Internal error   | Handler threw           |
| -32001 | Not connected    | No active connection    |
| -32002 | Timeout          | Request timed out       |
| -32003 | Auth failed      | Authentication rejected |

## Tests

```bash
cd typescript && pnpm test
cd python && uv run task test
```

## License

MIT
