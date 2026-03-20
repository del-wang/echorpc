#!/usr/bin/env python3
"""Demo: Python JSON-RPC server between web and node."""

import asyncio
import logging
import time

# Add python package to path
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from viberpc import RpcServer, RpcConnection

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
logger = logging.getLogger("demo")

server = RpcServer(
    host="0.0.0.0",
    port=9100,
    auth_handler=lambda params: {"ok": True},  # accept all tokens in demo
)


# ── Register server-side RPC methods ────────────────────────────────────────

def handle_echo(params):
    """Echo back params."""
    return params


def handle_add(params):
    """Add two numbers."""
    return {"sum": params["a"] + params["b"]}


def handle_server_time(params):
    """Return server timestamp."""
    return {"time": time.time(), "iso": time.strftime("%Y-%m-%dT%H:%M:%S")}


server.register("echo", handle_echo)
server.register("add", handle_add)
server.register("server.time", handle_server_time)

# -- Event handling ────────────────────────────────────────────────────────

async def on_web_message(params):
    """Handle web messages."""
    logger.info("web message: %s", params)

# ── Connection lifecycle logging ────────────────────────────────────────────

def on_connect(conn: RpcConnection):
    logger.info("new connection (total: %d)", len(server.get_connections()))
    conn.on("web.message", on_web_message)


def on_disconnect(conn: RpcConnection):
    role = conn._meta.get("role", "unknown")
    logger.info("%s disconnected (remaining: %d)", role, len(server.get_connections()) - 1)


server.on_connect(on_connect)
server.on_disconnect(on_disconnect)


# ── Periodic broadcast demo ─────────────────────────────────────────────────

async def heartbeat_broadcast():
    """Broadcast server heartbeat every 5 seconds."""
    while True:
        await asyncio.sleep(5)
        await server.broadcast_event("server.heartbeat", {
            "time": time.time(),
            "connections": len(server.get_connections()),
        })


async def main():
    logger.info("starting demo server on ws://localhost:9100")
    logger.info("  - built-in methods: echo, add, server.time")
    logger.info("  - broadcast event: server.heartbeat (every 5s)")
    await server.start()
    await heartbeat_broadcast()


if __name__ == "__main__":
    asyncio.run(main())
