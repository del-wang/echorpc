# EchoRPC

Bidirectional JSON-RPC 2.0 over WebSocket for Python.

## Install

```bash
pip install echorpc
```

## Quick Start

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
