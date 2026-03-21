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
  WsServer,
  WsClient,
} from "../src/index.js";

const WS = WebSocket;

let server: RpcServer;
let wsServer: WsServer;
let serverPort: number;

function createClient(role = "web"): RpcClient {
  const transport = new WsClient(`ws://127.0.0.1:${serverPort}`, {
    token: "test-token",
    role,
    autoReconnect: false,
    pingInterval: 300_000,
    WebSocket: WS,
  });
  return new RpcClient(transport);
}

// ── Basic RPC ──────────────────────────────────────────────────────────

describe("TS Server: Basic RPC", () => {
  let client: RpcClient;

  beforeAll(async () => {
    wsServer = new WsServer({ port: 0 });
    server = new RpcServer(wsServer);
    server.register("echo", (conn, params) => params);
    server.register("add", (conn, params: { a: number; b: number }) => ({
      sum: params.a + params.b,
    }));
    server.register("server.time", (conn, params) => ({
      time: Date.now(),
      iso: new Date().toISOString(),
    }));
    server.register("throws", (conn, params) => {
      throw new RpcError(ErrorCode.INVALID_PARAMS, "bad params");
    });
    server.register("throws.generic", (conn, params) => {
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
    await client.connect();
    expect(client.connected).toBe(true);
  });

  it("should request echo", async () => {
    client = createClient();
    await client.connect();
    const result = await client.request("echo", { msg: "hello" });
    expect(result).toEqual({ msg: "hello" });
  });

  it("should request add", async () => {
    client = createClient();
    await client.connect();
    const result = await client.request<{ sum: number }>("add", {
      a: 10,
      b: 20,
    });
    expect(result.sum).toBe(30);
  });

  it("should request server.time", async () => {
    client = createClient();
    await client.connect();
    const result = await client.request<{ time: number; iso: string }>(
      "server.time",
    );
    expect(result.time).toBeGreaterThan(0);
    expect(result.iso).toBeTruthy();
  });

  it("should handle method not found", async () => {
    client = createClient();
    await client.connect();
    try {
      await client.request("nonexistent");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe(ErrorCode.METHOD_NOT_FOUND);
    }
  });

  it("should handle RpcError thrown by handler", async () => {
    client = createClient();
    await client.connect();
    try {
      await client.request("throws");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe(ErrorCode.INVALID_PARAMS);
      expect((e as RpcError).message).toBe("bad params");
    }
  });

  it("should handle generic Error thrown by handler", async () => {
    client = createClient();
    await client.connect();
    try {
      await client.request("throws.generic");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe(ErrorCode.INTERNAL_ERROR);
    }
  });
});

// ── Server handler receives conn ─────────────────────────────────────────

describe("TS Server: Handler conn", () => {
  let client: RpcClient;

  beforeAll(async () => {
    wsServer = new WsServer({ port: 0 });
    server = new RpcServer(wsServer);
    server.register("whoami", (conn, params) => ({
      role: conn.meta.role,
      authenticated: conn.meta.authenticated,
    }));
    server.register("ask.client", async (conn, params) => {
      const answer = await conn.request<string>("client.answer");
      return { answer };
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

  it("handler should receive conn with meta", async () => {
    client = createClient("node");
    await client.connect();
    const result = await client.request<{
      role: string;
      authenticated: boolean;
    }>("whoami");
    expect(result.role).toBe("node");
    expect(result.authenticated).toBe(true);
  });

  it("handler should use conn to request back into client", async () => {
    client = createClient("node");
    client.register("client.answer", () => "42");
    await client.connect();
    const result = await client.request<{ answer: string }>("ask.client");
    expect(result.answer).toBe("42");
  });
});

// ── Bidirectional RPC (server requests client) ────────────────────────

describe("TS Server: Bidirectional RPC", () => {
  let client: RpcClient;

  beforeAll(async () => {
    wsServer = new WsServer({ port: 0 });
    server = new RpcServer(wsServer);
    server.register("echo", (conn, params) => params);
    await server.start();
    serverPort = server.address!.port;
  });

  afterAll(async () => {
    await server.stop();
  });
  afterEach(() => {
    client?.disconnect();
  });

  it("should request a method registered on the client from the server", async () => {
    client = createClient("node");
    client.register("client.ping", () => "pong");
    await client.connect();

    const conn = server.getConnections("node")[0];
    expect(conn).toBeDefined();
    const result = await conn.request<string>("client.ping");
    expect(result).toBe("pong");
  });

  it("should request client with params and get result", async () => {
    await new Promise((r) => setTimeout(r, 50));
    client = createClient("node");
    client.register(
      "client.add",
      (params: { a: number; b: number }) => params.a + params.b,
    );
    await client.connect();

    const conns = server.getConnections("node");
    const conn = conns[conns.length - 1];
    const result = await conn.request<number>("client.add", { a: 7, b: 8 });
    expect(result).toBe(15);
  });
});

// ── Pub/Sub (notifications) ─────────────────────────────────────────

describe("TS Server: Pub/Sub", () => {
  let client: RpcClient;

  beforeAll(async () => {
    wsServer = new WsServer({ port: 0 });
    server = new RpcServer(wsServer);
    await server.start();
    serverPort = server.address!.port;
  });

  afterAll(async () => {
    await server.stop();
  });
  afterEach(() => {
    client?.disconnect();
  });

  it("client should receive broadcast notification from server", async () => {
    client = createClient();
    const events: unknown[] = [];
    client.subscribe("test.event", (data) => events.push(data));
    await client.connect();

    server.broadcast("test.event", { x: 42 });
    await new Promise((r) => setTimeout(r, 200));
    expect(events).toEqual([{ x: 42 }]);
  });

  it("server should receive notification published by client via server.subscribe()", async () => {
    const freshWsServer = new WsServer({ port: 0 });
    const freshServer = new RpcServer(freshWsServer);
    const received: Array<{ data: unknown; role: unknown }> = [];
    freshServer.subscribe("client.hello", (conn, data) => {
      received.push({ data, role: conn.meta.role });
    });
    await freshServer.start();
    const port = freshServer.address!.port;

    const transport = new WsClient(`ws://127.0.0.1:${port}`, {
      token: "t",
      role: "web",
      autoReconnect: false,
      pingInterval: 300_000,
      WebSocket: WS,
    });
    const c = new RpcClient(transport);
    await c.connect();

    c.publish("client.hello", { from: "test" });
    await new Promise((r) => setTimeout(r, 200));

    expect(received).toEqual([{ data: { from: "test" }, role: "web" }]);

    c.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    await freshServer.stop();
  });

  it("server should receive notification via conn.subscribe()", async () => {
    client = createClient();
    await client.connect();

    const received: unknown[] = [];
    const conn = server.getConnections("web")[0];
    conn.subscribe("client.hello", (data) => received.push(data));

    client.publish("client.hello", { from: "test" });
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toEqual([{ from: "test" }]);
  });

  it("broadcastExcept should skip the excluded connection", async () => {
    const client1 = createClient("web");
    const client2 = createClient("web");
    const events1: unknown[] = [];
    const events2: unknown[] = [];
    client1.subscribe("selective", (d) => events1.push(d));
    client2.subscribe("selective", (d) => events2.push(d));

    await client1.connect();
    await client2.connect();

    const conns = server.getConnections("web");
    server.broadcastExcept("selective", { msg: "hi" }, conns[0]);
    await new Promise((r) => setTimeout(r, 200));

    const totalReceived = events1.length + events2.length;
    expect(totalReceived).toBe(1);

    client1.disconnect();
    client2.disconnect();
  });
});

// ── Batch requests ──────────────────────────────────────────────────

describe("TS Server: Batch requests", () => {
  let client: RpcClient;

  beforeAll(async () => {
    wsServer = new WsServer({ port: 0 });
    server = new RpcServer(wsServer);
    server.register("echo", (conn, params) => params);
    server.register("add", (conn, params: { a: number; b: number }) => ({
      sum: params.a + params.b,
    }));
    server.register("fail", (conn, params) => {
      throw new RpcError(-100, "intentional error");
    });
    server.register("slow_echo", async (conn, params) => {
      await new Promise((r) => setTimeout(r, Math.random() * 50 + 10));
      return params;
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

  it("should handle basic batch request", async () => {
    client = createClient();
    await client.connect();

    const results = await client.batchRequest([
      ["echo", { x: 1 }],
      ["add", { a: 10, b: 20 }],
      ["echo", { x: 2 }],
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ x: 1 });
    expect(results[1]).toEqual({ sum: 30 });
    expect(results[2]).toEqual({ x: 2 });
  });

  it("should handle batch with errors", async () => {
    client = createClient();
    await client.connect();

    const results = await client.batchRequest([
      ["echo", { ok: true }],
      ["fail", null],
      ["add", { a: 1, b: 2 }],
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ ok: true });
    expect(results[1]).toBeInstanceOf(RpcError);
    expect((results[1] as unknown as RpcError).code).toBe(-100);
    expect(results[2]).toEqual({ sum: 3 });
  });

  it("should handle empty batch", async () => {
    client = createClient();
    await client.connect();

    const results = await client.batchRequest([]);
    expect(results).toEqual([]);
  });

  it("should preserve order regardless of response timing", async () => {
    client = createClient();
    await client.connect();

    const calls: Array<[string, unknown]> = Array.from(
      { length: 10 },
      (_, i) => ["slow_echo", { i }],
    );
    const results = await client.batchRequest(calls);

    for (let i = 0; i < results.length; i++) {
      expect(results[i]).toEqual({ i });
    }
  });
});

// ── Connection management ──────────────────────────────────────────────

describe("TS Server: Connection management", () => {
  beforeAll(async () => {
    wsServer = new WsServer({ port: 0 });
    server = new RpcServer(wsServer);
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
    await client.connect();

    expect(connectCount.length).toBeGreaterThanOrEqual(1);
    expect(server.getConnections().length).toBeGreaterThanOrEqual(1);

    client.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    expect(disconnectCount.length).toBeGreaterThanOrEqual(1);
    expect(disconnectCount.some((c) => c.meta.role === "node")).toBe(true);
  });

  it("getConnections should filter by role", async () => {
    const freshWsServer = new WsServer({ port: 0 });
    const freshServer = new RpcServer(freshWsServer);
    await freshServer.start();
    const port = freshServer.address!.port;

    const t1 = new WsClient(`ws://127.0.0.1:${port}`, {
      token: "t",
      role: "web",
      autoReconnect: false,
      pingInterval: 300_000,
      WebSocket: WS,
    });
    const t2 = new WsClient(`ws://127.0.0.1:${port}`, {
      token: "t",
      role: "node",
      autoReconnect: false,
      pingInterval: 300_000,
      WebSocket: WS,
    });
    const c1 = new RpcClient(t1);
    const c2 = new RpcClient(t2);
    await c1.connect();
    await c2.connect();
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

    for (let i = 0; i < clients.length; i++) {
      clients[i].subscribe("multi.test", (d) => events[i].push(d));
    }
    await Promise.all(clients.map((c) => c.connect()));

    server.broadcast("multi.test", { n: 1 }, "web");
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
    const authWsServer = new WsServer({
      port: 0,
      authHandler: (params) => {
        if (params.token !== "valid-token") {
          throw new RpcError(ErrorCode.AUTH_FAILED, "invalid token");
        }
        return { ok: true };
      },
    });
    authServer = new RpcServer(authWsServer);
    authServer.register("echo", (conn, p) => p);
    await authServer.start();
    authPort = authServer.address!.port;
  });

  afterAll(async () => {
    await authServer.stop();
  });

  it("should authenticate with valid token", async () => {
    const transport = new WsClient(`ws://127.0.0.1:${authPort}`, {
      token: "valid-token",
      autoReconnect: false,
      pingInterval: 300_000,
      WebSocket: WS,
    });
    const client = new RpcClient(transport);
    await client.connect();
    expect(client.connected).toBe(true);
    const result = await client.request("echo", "ok");
    expect(result).toBe("ok");
    client.disconnect();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("should reject invalid token (HTTP 401, no WS connection)", async () => {
    let authFailed = false;
    const transport = new WsClient(`ws://127.0.0.1:${authPort}`, {
      token: "wrong-token",
      autoReconnect: false,
      pingInterval: 300_000,
      WebSocket: WS,
    });
    const client = new RpcClient(transport);
    client.onAuthFailed = () => {
      authFailed = true;
    };
    await client.connect();
    expect(authFailed).toBe(true);
    expect(client.connected).toBe(false);
    expect(authServer.getConnections().length).toBe(0);
    client.disconnect();
  });

  it("should accept all connections when no auth handler", async () => {
    const noAuthWsServer = new WsServer({ port: 0 });
    const noAuthServer = new RpcServer(noAuthWsServer);
    noAuthServer.register("echo", (conn, p) => p);
    await noAuthServer.start();
    const port = noAuthServer.address!.port;

    const transport = new WsClient(`ws://127.0.0.1:${port}`, {
      token: "anything",
      autoReconnect: false,
      pingInterval: 300_000,
      WebSocket: WS,
    });
    const client = new RpcClient(transport);
    await client.connect();
    expect(client.connected).toBe(true);
    const result = await client.request("echo", "ok");
    expect(result).toBe("ok");
    client.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    await noAuthServer.stop();
  });

  it("unauthenticated client cannot call methods", async () => {
    const transport = new WsClient(`ws://127.0.0.1:${authPort}`, {
      token: "wrong-token",
      autoReconnect: false,
      pingInterval: 300_000,
      WebSocket: WS,
    });
    const client = new RpcClient(transport);
    await client.connect();
    expect(client.connected).toBe(false);
    expect(authServer.getConnections().length).toBe(0);
    client.disconnect();
  });
});
