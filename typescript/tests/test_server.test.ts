/**
 * Integration tests for the TypeScript JSON-RPC server.
 * Self-contained — spins up its own RpcServer per test suite.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import WebSocket from "ws";
import {
  RpcServer,
  RpcClient,
  RpcConnection,
  RpcError,
  ErrorCode,
  type WebSocketConstructor,
} from "../src/index.js";

const WS = WebSocket;

let server: RpcServer;
let serverPort: number;

function createClient(role = "web"): RpcClient {
  return new RpcClient(`ws://127.0.0.1:${serverPort}`, {
    token: "test-token",
    role,
    autoReconnect: false,
    pingInterval: 300_000,
    WebSocket: WS,
  });
}

// ── Basic RPC ──────────────────────────────────────────────────────────

describe("TS Server: Basic RPC", () => {
  let client: RpcClient;

  beforeAll(async () => {
    server = new RpcServer({ port: 0 });
    server.register("echo", (params) => params);
    server.register("add", (params: { a: number; b: number }) => ({
      sum: params.a + params.b,
    }));
    server.register("server.time", () => ({
      time: Date.now(),
      iso: new Date().toISOString(),
    }));
    server.register("throws", () => {
      throw new RpcError(ErrorCode.INVALID_PARAMS, "bad params");
    });
    server.register("throws.generic", () => {
      throw new Error("something broke");
    });
    await server.start();
    serverPort = server.address!.port;
  });

  afterAll(async () => {
    await server.stop();
  });
  afterEach(() => {
    client?.disconnect();
  });

  it("should connect and authenticate", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);
    expect(client.connected).toBe(true);
  });

  it("should call echo", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);
    const result = await client.call("echo", { msg: "hello" });
    expect(result).toEqual({ msg: "hello" });
  });

  it("should call add", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);
    const result = await client.call<{ sum: number }>("add", { a: 10, b: 20 });
    expect(result.sum).toBe(30);
  });

  it("should call server.time", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);
    const result = await client.call<{ time: number; iso: string }>(
      "server.time",
    );
    expect(result.time).toBeGreaterThan(0);
    expect(result.iso).toBeTruthy();
  });

  it("should handle method not found", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);
    try {
      await client.call("nonexistent");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe(ErrorCode.METHOD_NOT_FOUND);
    }
  });

  it("should handle RpcError thrown by handler", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);
    try {
      await client.call("throws");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe(ErrorCode.INVALID_PARAMS);
      expect((e as RpcError).message).toBe("bad params");
    }
  });

  it("should handle generic Error thrown by handler", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);
    try {
      await client.call("throws.generic");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe(ErrorCode.INTERNAL_ERROR);
    }
  });
});

// ── Bidirectional RPC (server calls client) ────────────────────────────

describe("TS Server: Bidirectional RPC", () => {
  let client: RpcClient;

  beforeAll(async () => {
    server = new RpcServer({ port: 0 });
    server.register("echo", (params) => params);
    await server.start();
    serverPort = server.address!.port;
  });

  afterAll(async () => {
    await server.stop();
  });
  afterEach(() => {
    client?.disconnect();
  });

  it("should call a method registered on the client from the server", async () => {
    client = createClient("node");
    client.register("client.ping", () => "pong");
    client.connect();
    await client.waitConnected(5000);

    const conn = server.getConnections("node")[0];
    expect(conn).toBeDefined();
    const result = await conn.call<string>("client.ping");
    expect(result).toBe("pong");
  });

  it("should call client with params and get result", async () => {
    client = createClient("node");
    client.register(
      "client.add",
      (params: { a: number; b: number }) => params.a + params.b,
    );
    client.connect();
    await client.waitConnected(5000);

    const conn = server.getConnections("node")[0];
    const result = await conn.call<number>("client.add", { a: 7, b: 8 });
    expect(result).toBe(15);
  });
});

// ── Events ─────────────────────────────────────────────────────────────

describe("TS Server: Events", () => {
  let client: RpcClient;

  beforeAll(async () => {
    server = new RpcServer({ port: 0 });
    await server.start();
    serverPort = server.address!.port;
  });

  afterAll(async () => {
    await server.stop();
  });
  afterEach(() => {
    client?.disconnect();
  });

  it("client should receive broadcast event from server", async () => {
    client = createClient();
    const events: unknown[] = [];
    client.on("test.event", (data) => events.push(data));
    client.connect();
    await client.waitConnected(5000);

    server.broadcastEvent("test.event", { x: 42 });
    await new Promise((r) => setTimeout(r, 200));
    expect(events).toEqual([{ x: 42 }]);
  });

  it("server should receive event emitted by client", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);

    const received: unknown[] = [];
    const conn = server.getConnections("web")[0];
    conn.on("client.hello", (data) => received.push(data));

    client.emit("client.hello", { from: "test" });
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toEqual([{ from: "test" }]);
  });

  it("broadcastEventExcept should skip the excluded connection", async () => {
    const client1 = createClient("web");
    const client2 = createClient("web");
    const events1: unknown[] = [];
    const events2: unknown[] = [];
    client1.on("selective", (d) => events1.push(d));
    client2.on("selective", (d) => events2.push(d));

    client1.connect();
    await client1.waitConnected(5000);
    client2.connect();
    await client2.waitConnected(5000);

    const conns = server.getConnections("web");
    // Exclude the first connection
    server.broadcastEventExcept("selective", { msg: "hi" }, conns[0]);
    await new Promise((r) => setTimeout(r, 200));

    // One should have received it, the other should not
    const totalReceived = events1.length + events2.length;
    expect(totalReceived).toBe(1);

    client1.disconnect();
    client2.disconnect();
  });
});

// ── Connection management ──────────────────────────────────────────────

describe("TS Server: Connection management", () => {
  beforeAll(async () => {
    server = new RpcServer({ port: 0 });
    await server.start();
    serverPort = server.address!.port;
  });

  afterAll(async () => {
    await server.stop();
  });

  it("onConnect and onDisconnect callbacks should fire", async () => {
    const connectCount: RpcConnection[] = [];
    const disconnectCount: RpcConnection[] = [];

    server.onConnect((conn) => {
      connectCount.push(conn);
    });
    server.onDisconnect((conn) => {
      disconnectCount.push(conn);
    });

    const client = createClient("node");
    client.connect();
    await client.waitConnected(5000);

    // After auth, role should be set
    expect(connectCount.length).toBeGreaterThanOrEqual(1);
    expect(server.getConnections().length).toBeGreaterThanOrEqual(1);

    client.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // onDisconnect fires after close, role is already set by auth
    expect(disconnectCount.length).toBeGreaterThanOrEqual(1);
    expect(disconnectCount.some((c) => c.meta.role === "node")).toBe(true);
  });

  it("getConnections should filter by role", async () => {
    // Use a fresh server to avoid leftover connections from other tests
    const freshServer = new RpcServer({ port: 0 });
    await freshServer.start();
    const port = freshServer.address!.port;

    const c1 = new RpcClient(`ws://127.0.0.1:${port}`, {
      token: "t",
      role: "web",
      autoReconnect: false,
      pingInterval: 300_000,
      WebSocket: WS,
    });
    const c2 = new RpcClient(`ws://127.0.0.1:${port}`, {
      token: "t",
      role: "node",
      autoReconnect: false,
      pingInterval: 300_000,
      WebSocket: WS,
    });
    c1.connect();
    await c1.waitConnected(5000);
    c2.connect();
    await c2.waitConnected(5000);
    // Small settle for server-side meta propagation
    await new Promise((r) => setTimeout(r, 50));

    expect(freshServer.getConnections("web").length).toBe(1);
    expect(freshServer.getConnections("node").length).toBe(1);
    expect(freshServer.getConnections().length).toBe(2);

    c1.disconnect();
    c2.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    await freshServer.stop();
  });

  it("should handle multiple web clients concurrently", async () => {
    const clients = [
      createClient("web"),
      createClient("web"),
      createClient("web"),
    ];
    const events: unknown[][] = [[], [], []];

    clients.forEach((c, i) => {
      c.on("multi.test", (d) => events[i].push(d));
      c.connect();
    });
    await Promise.all(clients.map((c) => c.waitConnected(5000)));

    server.broadcastEvent("multi.test", { n: 1 }, "web");
    await new Promise((r) => setTimeout(r, 200));

    for (const evList of events) {
      expect(evList).toEqual([{ n: 1 }]);
    }

    clients.forEach((c) => {
      c.disconnect();
    });
    await new Promise((r) => setTimeout(r, 200));
  });
});

// ── Auth ────────────────────────────────────────────────────────────────

describe("TS Server: Custom auth handler", () => {
  let authServer: RpcServer;
  let authPort: number;

  beforeAll(async () => {
    authServer = new RpcServer({
      port: 0,
      authHandler: (params) => {
        if (params.token !== "valid-token") {
          throw new RpcError(ErrorCode.AUTH_FAILED, "invalid token");
        }
        return { ok: true };
      },
    });
    authServer.register("echo", (p) => p);
    await authServer.start();
    authPort = authServer.address!.port;
  });

  afterAll(async () => {
    await authServer.stop();
  });

  it("should authenticate with valid token", async () => {
    const client = new RpcClient(`ws://127.0.0.1:${authPort}`, {
      token: "valid-token",
      autoReconnect: false,
      pingInterval: 300_000,
      WebSocket: WS,
    });
    client.connect();
    await client.waitConnected(5000);
    expect(client.connected).toBe(true);
    const result = await client.call("echo", "ok");
    expect(result).toBe("ok");
    client.disconnect();
  });

  it("should reject invalid token", async () => {
    let authFailed = false;
    const client = new RpcClient(`ws://127.0.0.1:${authPort}`, {
      token: "wrong-token",
      autoReconnect: false,
      pingInterval: 300_000,
      WebSocket: WS,
    });
    client.onAuthFailed = () => {
      authFailed = true;
    };
    client.connect();
    await new Promise((r) => setTimeout(r, 500));
    expect(authFailed).toBe(true);
    expect(client.connected).toBe(false);
    client.disconnect();
  });
});
