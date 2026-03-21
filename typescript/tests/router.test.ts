/**
 * Unit tests for MessageRouter — pure RPC engine without transport.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageRouter } from "../src/router.js";
import { RpcError, ErrorCode, nextId } from "../src/core.js";

let sent: string[];
let router: MessageRouter;

function createRouter(timeout = 5000) {
  sent = [];
  router = new MessageRouter((raw) => sent.push(raw), timeout);
  return router;
}

function lastSent(): Record<string, unknown> {
  return JSON.parse(sent[sent.length - 1]);
}

// ── Heartbeat ──────────────────────────────────────────────────────────

describe("MessageRouter: Heartbeat", () => {
  beforeEach(() => createRouter());

  it("should respond to ping with pong", () => {
    router.dispatchMessage(JSON.stringify({ jsonrpc: "2.0", method: "ping" }));
    expect(lastSent()).toEqual({ jsonrpc: "2.0", method: "pong" });
  });

  it("should silently ignore pong", () => {
    router.dispatchMessage(JSON.stringify({ jsonrpc: "2.0", method: "pong" }));
    expect(sent).toHaveLength(0);
  });
});

// ── RPC handlers ───────────────────────────────────────────────────────

describe("MessageRouter: RPC handlers", () => {
  beforeEach(() => createRouter());

  it("should call registered handler and send result", async () => {
    router.register("echo", (params) => params);
    router.dispatchMessage(
      JSON.stringify({ jsonrpc: "2.0", id: "1", method: "echo", params: { x: 1 } }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(lastSent()).toEqual({ jsonrpc: "2.0", id: "1", result: { x: 1 } });
  });

  it("should send METHOD_NOT_FOUND for unknown method", () => {
    router.dispatchMessage(
      JSON.stringify({ jsonrpc: "2.0", id: "2", method: "unknown" }),
    );
    const resp = lastSent();
    expect(resp.id).toBe("2");
    expect((resp.error as { code: number }).code).toBe(ErrorCode.METHOD_NOT_FOUND);
  });

  it("should send error when handler throws RpcError", async () => {
    router.register("fail", () => {
      throw new RpcError(ErrorCode.INVALID_PARAMS, "bad");
    });
    router.dispatchMessage(
      JSON.stringify({ jsonrpc: "2.0", id: "3", method: "fail" }),
    );
    await new Promise((r) => setTimeout(r, 10));
    const resp = lastSent();
    expect((resp.error as { code: number }).code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("should send INTERNAL_ERROR for generic errors", async () => {
    router.register("crash", () => {
      throw new Error("oops");
    });
    router.dispatchMessage(
      JSON.stringify({ jsonrpc: "2.0", id: "4", method: "crash" }),
    );
    await new Promise((r) => setTimeout(r, 10));
    const resp = lastSent();
    expect((resp.error as { code: number }).code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it("should support unregister", () => {
    router.register("temp", () => "hi");
    router.unregister("temp");
    router.dispatchMessage(
      JSON.stringify({ jsonrpc: "2.0", id: "5", method: "temp" }),
    );
    const resp = lastSent();
    expect((resp.error as { code: number }).code).toBe(ErrorCode.METHOD_NOT_FOUND);
  });
});

// ── Pending requests ───────────────────────────────────────────────────

describe("MessageRouter: Pending requests", () => {
  beforeEach(() => createRouter());

  it("should resolve when response arrives", async () => {
    const p = router.request("echo", { x: 1 });
    const req = JSON.parse(sent[0]);
    router.dispatchMessage(
      JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { x: 1 } }),
    );
    expect(await p).toEqual({ x: 1 });
  });

  it("should reject when error response arrives", async () => {
    const p = router.request("fail");
    const req = JSON.parse(sent[0]);
    router.dispatchMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -100, message: "err" },
      }),
    );
    await expect(p).rejects.toThrow(RpcError);
  });

  it("should timeout", async () => {
    const r = createRouter(50);
    const p = r.request("slow");
    await expect(p).rejects.toThrow("timeout");
  });
});

// ── Pub/Sub ────────────────────────────────────────────────────────────

describe("MessageRouter: Pub/Sub", () => {
  beforeEach(() => createRouter());

  it("should fire subscribers on notification", () => {
    const received: unknown[] = [];
    router.subscribe("event", (data) => received.push(data));
    router.dispatchMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "event", params: { n: 1 } }),
    );
    expect(received).toEqual([{ n: 1 }]);
  });

  it("should support unsubscribe", () => {
    const received: unknown[] = [];
    const cb = (data: unknown) => received.push(data);
    router.subscribe("event", cb);
    router.unsubscribe("event", cb);
    router.dispatchMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "event", params: { n: 1 } }),
    );
    expect(received).toHaveLength(0);
  });

  it("publish should send notification", () => {
    router.publish("event", { n: 1 });
    expect(lastSent()).toEqual({ jsonrpc: "2.0", method: "event", params: { n: 1 } });
  });
});

// ── Batch ──────────────────────────────────────────────────────────────

describe("MessageRouter: Batch", () => {
  beforeEach(() => createRouter());

  it("should handle incoming empty batch with Invalid Request", () => {
    router.dispatchMessage(JSON.stringify([]));
    // Allow async processing
    return new Promise<void>((resolve) => setTimeout(() => {
      const resp = lastSent();
      expect((resp.error as { code: number }).code).toBe(ErrorCode.INVALID_REQUEST);
      resolve();
    }, 10));
  });

  it("should send batch request and resolve in order", async () => {
    const p = router.batchRequest<unknown>([
      ["echo", { x: 1 }],
      ["add", { a: 1, b: 2 }],
    ]);
    const batch = JSON.parse(sent[0]) as Array<{ id: string }>;
    expect(batch).toHaveLength(2);

    // Respond out of order
    router.dispatchMessage(
      JSON.stringify([
        { jsonrpc: "2.0", id: batch[1].id, result: { sum: 3 } },
        { jsonrpc: "2.0", id: batch[0].id, result: { x: 1 } },
      ]),
    );

    const results = await p;
    expect(results[0]).toEqual({ x: 1 });
    expect(results[1]).toEqual({ sum: 3 });
  });

  it("empty batch request returns empty array", async () => {
    const results = await router.batchRequest([]);
    expect(results).toEqual([]);
  });
});

// ── Close ──────────────────────────────────────────────────────────────

describe("MessageRouter: Close", () => {
  it("should reject all pending on close", async () => {
    createRouter();
    const p1 = router.request("a");
    const p2 = router.request("b");
    router.close();
    await expect(p1).rejects.toThrow("disconnected");
    await expect(p2).rejects.toThrow("disconnected");
  });

  it("should reject new requests after close", async () => {
    createRouter();
    router.close();
    await expect(router.request("x")).rejects.toThrow("not connected");
  });

  it("should not send after close", () => {
    createRouter();
    router.close();
    router.publish("event", { n: 1 });
    expect(sent).toHaveLength(0);
  });
});
