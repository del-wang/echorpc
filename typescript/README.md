# EchoRPC

Bidirectional JSON-RPC 2.0 over WebSocket for Node.js and browser.

## Install

```bash
npm install echorpc
```

## Quick Start

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
