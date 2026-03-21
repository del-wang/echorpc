/**
 * Integration tests for the HTTP transport layer.
 * Tests bidirectional RPC over HTTP POST.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  RpcServer,
  RpcClient,
  RpcError,
  ErrorCode,
  HttpServer,
  HttpClient,
} from "../src/index.js";

let httpServer: HttpServer;
let server: RpcServer;
let serverPort: number;

function createClient(role = "web"): RpcClient {
  const transport = new HttpClient(`http://127.0.0.1:${serverPort}`, {
    token: "test-token",
    role,
    callbackHost: "127.0.0.1",
  });
  return new RpcClient(transport);
}

// ── Basic HTTP RPC ────────────────────────────────────────────────────

describe("HTTP Transport: Basic RPC", () => {
  let client: RpcClient;

  beforeAll(async () => {
    httpServer = new HttpServer({ port: 0, host: "127.0.0.1" });
    server = new RpcServer(httpServer);
    server.register("echo", (conn, params) => params);
    server.register("add", (conn, params: { a: number; b: number }) => ({
      sum: params.a + params.b,
    }));
    server.register("throws", () => {
      throw new RpcError(ErrorCode.INVALID_PARAMS, "bad params");
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

  it("should connect via HTTP", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);
    expect(client.connected).toBe(true);
  });

  it("should request echo", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);
    const result = await client.request("echo", { msg: "hello" });
    expect(result).toEqual({ msg: "hello" });
  });

  it("should request add", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);
    const result = await client.request<{ sum: number }>("add", {
      a: 10,
      b: 20,
    });
    expect(result.sum).toBe(30);
  });

  it("should handle RpcError from handler", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);
    try {
      await client.request("throws");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe(ErrorCode.INVALID_PARAMS);
    }
  });

  it("should handle method not found", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);
    try {
      await client.request("nonexistent");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe(ErrorCode.METHOD_NOT_FOUND);
    }
  });
});

// ── HTTP Auth ──────────────────────────────────────────────────────────

describe("HTTP Transport: Auth", () => {
  let authHttpServer: HttpServer;
  let authServer: RpcServer;
  let authPort: number;

  beforeAll(async () => {
    authHttpServer = new HttpServer({
      port: 0,
      host: "127.0.0.1",
      authHandler: (params) => {
        if (params.token !== "valid-token") {
          throw new Error("invalid token");
        }
      },
    });
    authServer = new RpcServer(authHttpServer);
    authServer.register("echo", (conn, p) => p);
    await authServer.start();
    authPort = authServer.address!.port;
  });

  afterAll(async () => {
    await authServer.stop();
  });

  it("should authenticate with valid token", async () => {
    const transport = new HttpClient(`http://127.0.0.1:${authPort}`, {
      token: "valid-token",
      callbackHost: "127.0.0.1",
    });
    const client = new RpcClient(transport);
    client.connect();
    await client.waitConnected(5000);
    expect(client.connected).toBe(true);
    const result = await client.request("echo", "ok");
    expect(result).toBe("ok");
    client.disconnect();
  });

  it("should reject invalid token", async () => {
    let authFailed = false;
    const transport = new HttpClient(`http://127.0.0.1:${authPort}`, {
      token: "wrong-token",
      callbackHost: "127.0.0.1",
    });
    const client = new RpcClient(transport);
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

// ── Bidirectional HTTP RPC ──────────────────────────────────────────────

describe("HTTP Transport: Bidirectional RPC", () => {
  let biHttpServer: HttpServer;
  let biServer: RpcServer;
  let biPort: number;

  beforeAll(async () => {
    biHttpServer = new HttpServer({ port: 0, host: "127.0.0.1" });
    biServer = new RpcServer(biHttpServer);
    biServer.register("echo", (conn, params) => params);
    await biServer.start();
    biPort = biServer.address!.port;
  });

  afterAll(async () => {
    await biServer.stop();
  });

  it("server should call back into client via HTTP callback", async () => {
    const transport = new HttpClient(`http://127.0.0.1:${biPort}`, {
      token: "t",
      role: "node",
      callbackHost: "127.0.0.1",
    });
    const client = new RpcClient(transport);
    client.register("client.ping", () => "pong");
    client.connect();
    await client.waitConnected(5000);

    // Wait for server to register connection
    await new Promise((r) => setTimeout(r, 100));

    const conns = biServer.getConnections("node");
    expect(conns.length).toBeGreaterThanOrEqual(1);
    const result = await conns[0].request<string>("client.ping");
    expect(result).toBe("pong");

    client.disconnect();
  });
});
