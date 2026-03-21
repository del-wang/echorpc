/**
 * Integration tests for the universal viberpc client.
 * Requires the Python server running on port 9100.
 *
 * Start: cd python && python examples/demo_server.py
 * Run:   cd typescript && npx vitest run tests/test_client.test.ts
 */

import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import {
  RpcClient,
  RpcError,
  ErrorCode,
  type WebSocketConstructor,
} from "../src/index.js";

const SERVER_URL = "ws://127.0.0.1:9100";
const WS = WebSocket as unknown as WebSocketConstructor;

function createClient(role = "web"): RpcClient {
  return new RpcClient(SERVER_URL, {
    token: "demo-token",
    role,
    autoReconnect: false,
    pingInterval: 300_000,
    WebSocket: WS,
  });
}

describe("Basic RPC", () => {
  let client: RpcClient;

  afterEach(() => {
    client?.disconnect();
  });

  it("should connect and authenticate", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);
    expect(client.connected).toBe(true);
  });

  it("should request echo", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);
    const result = await client.request("echo", { msg: "test" });
    expect(result).toEqual({ msg: "test" });
  });

  it("should request add", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);
    const result = await client.request<{ sum: number }>("add", {
      a: 5,
      b: 3,
    });
    expect(result.sum).toBe(8);
  });

  it("should request server.time", async () => {
    client = createClient();
    client.connect();
    await client.waitConnected(5000);
    const result = await client.request<{ time: number; iso: string }>(
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
      await client.request("nonexistent");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe(ErrorCode.METHOD_NOT_FOUND);
    }
  });

  it("should receive notifications", async () => {
    client = createClient();
    const events: unknown[] = [];
    client.subscribe("server.heartbeat", (data) => events.push(data));
    client.connect();
    await client.waitConnected(5000);
    // Wait for at least one heartbeat (server sends every 5s)
    await new Promise((r) => setTimeout(r, 6000));
    expect(events.length).toBeGreaterThanOrEqual(1);
  }, 10_000);
});
