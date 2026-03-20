/**
 * Demo: Node.js JSON-RPC server (mirrors Python's demo_server.py).
 * Usage: npx tsx demo/node-server.ts
 */

import { RpcServer } from "../src/server.js";

const server = new RpcServer({ port: 9100 });

// Register the same methods as Python demo_server.py
server.register("echo", (params) => params);
server.register(
  "add",
  (params: { a: number; b: number }) => params.a + params.b,
);
server.register("server.time", () => new Date().toISOString());

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
  server.broadcastEvent("server.heartbeat", { ts: Date.now() });
}, 5_000);

await server.start();
const addr = server.address;
console.log(`JSON-RPC server listening on ws://${addr?.host}:${addr?.port}`);
