# EchoRPC

[![NPM Version](https://badgen.net/npm/v/echorpc)](https://www.npmjs.com/package/echorpc)
[![PyPI Version](https://img.shields.io/pypi/v/echorpc.svg)](https://pypi.python.org/pypi/echorpc)
[![License](https://img.shields.io/github/license/del-wang/echorpc)](https://github.com/del-wang/echorpc/blob/main/LICENSE)

Bidirectional JSON-RPC 2.0 over WebSocket — TypeScript & Python.

```bash
# TypeScript
npm install echorpc

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

## Python

### Server

```python
from echorpc import EchoServer

server = EchoServer(port=9100, auth_handler=lambda p: p["token"] == "secret")

# Define a command that clients can call
@server.command("add")
def add(params):
    return {"sum": params["a"] + params["b"]}

# Listen for events from clients
@server.event("chat")
async def on_chat(data):
    print("on_chat", data)

await server.start()
```

### Client

```python
from echorpc import EchoClient

client = EchoClient("ws://localhost:9100", token="secret")

# Let the server call you back
client.register("double", lambda p: p["x"] * 2)

# Subscribe to events
client.subscribe("chat", lambda data: print(data))

await client.connect()

# Call a server command
result = await client.request("add", {"a": 1, "b": 2})

# Publish event to the server
await client.publish("chat", {"text": "hello"})

# Send multiple calls at once
results = await client.batch_request([
    ("add", {"a": 1, "b": 2}),
    ("add", {"a": 3, "b": 4}),
])
```

## TypeScript

### Server

```ts
import { EchoServer } from "echorpc";

const server = new EchoServer({
  port: 9100,
  authHandler: (p) => p.token === "secret",
});

// Define a command that clients can call
server.register("add", (p: { a: number; b: number }) => ({
  sum: p.a + p.b,
}));

// Listen for events from clients
server.subscribe("chat", async (data) => {
  console.log("chat", data);
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

// Let the server call you back
client.register("double", (p) => p.x * 2);

// Subscribe to events
client.subscribe("chat", (data) => console.log(data));

await client.connect();

// Call a server command
const result = await client.request("add", { a: 1, b: 2 });

// Publish event to the server
client.publish("chat", { text: "hello" });

// Send multiple calls at once
const results = await client.batchRequest([
  ["add", { a: 1, b: 2 }],
  ["add", { a: 3, b: 4 }],
]);
```

### Client (Browser)

No `WebSocket` import needed — uses the native one.

```ts
import { EchoClient } from "echorpc";

const client = new EchoClient("ws://localhost:9100", { token: "secret" });
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
