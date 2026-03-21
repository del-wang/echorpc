/**
 * Demo: Node.js JSON-RPC server (mirrors Python's demo_server.py).
 * Usage: npx tsx demo/node-server.ts
 */

import { RpcServer } from "../src/server.js";

const server = new RpcServer({ port: 9100 });

// Register methods — handler receives (params, conn)
server.register("echo", (params, conn) => params);
server.register(
  "add",
  (params: { a: number; b: number }, conn) => params.a + params.b,
);
server.register("server.time", (params, conn) => new Date().toISOString());

// Server-level notification subscriber — receives (data, conn)
server.subscribe("web.message", (data, conn) => {
  console.log(`[notification] web.message from ${conn.meta.role}:`, data);
});

server.onConnect((conn) => {
  const role = conn.meta.role ?? "unknown";
  const clientId = conn.meta.client_id ?? "";
  console.log(`[connect] role=${role} client_id=${clientId}`);
});

server.onDisconnect((conn) => {
  const role = conn.meta.role ?? "unknown";
  console.log(`[disconnect] role=${role}`);
});

// Broadcast heartbeat every 5s (like Python demo)
setInterval(() => {
  server.broadcast("server.heartbeat", { ts: Date.now() });
}, 5_000);

await server.start();
const addr = server.address;
console.log(`JSON-RPC server listening on ws://${addr?.host}:${addr?.port}`);
