#!/usr/bin/env tsx
/**
 * Demo: Node.js client connecting to Python server.
 * Registers methods that can be called from Python.
 */

import WebSocket from "ws";
import { RpcClient, type WebSocketConstructor } from "../src/index.js";

const rpc = new RpcClient("ws://localhost:9100", {
  token: "demo-token",
  role: "node",
  clientId: "node-demo-1",
  WebSocket: WebSocket as unknown as WebSocketConstructor,
});

// ── Register methods callable from server ────────────────

rpc.register("node.greet", (params: unknown) => {
  const p = params as { name?: string };
  console.log(`[node] greet called with: ${p?.name}`);
  return { greeting: `Hello from Node.js, ${p?.name ?? "stranger"}!` };
});

rpc.register("node.compute", (params: unknown) => {
  const p = params as { expression?: string };
  console.log(`[node] compute called with: ${p?.expression}`);
  const result = Function(`"use strict"; return (${p?.expression})`)();
  return { expression: p?.expression, result };
});

rpc.register("node.info", () => {
  return {
    platform: process.platform,
    nodeVersion: process.version,
    pid: process.pid,
    uptime: process.uptime(),
  };
});

// ── Listen for events ───────────────────────────────────────────────────────

rpc.on("server.heartbeat", (data) => {
  console.log("[node] heartbeat:", data);
});

rpc.on("web.message", (data) => {
  console.log("[node] message from web:", data);
});

// ── Connect and demo ────────────────────────────────────────────────────────

rpc.onConnect = () => console.log("[node] connected to server");
rpc.onDisconnect = () => console.log("[node] disconnected");

rpc.connect();

rpc.waitConnected().then(async () => {
  const echo = await rpc.call("echo", { msg: "hello from node" });
  console.log("[node] echo result:", echo);

  const sum = await rpc.call("add", { a: 10, b: 20 });
  console.log("[node] add result:", sum);

  const time = await rpc.call("server.time");
  console.log("[node] server time:", time);

  rpc.emit("node.status", { status: "ready", timestamp: Date.now() });
  console.log("[node] demo ready, listening for incoming calls...");
});
