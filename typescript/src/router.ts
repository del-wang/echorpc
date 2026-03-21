/**
 * MessageRouter — Pure RPC/event bus engine.
 * No transport knowledge: takes a `send(raw: string)` callback,
 * exposes `dispatchMessage(raw: string)` for incoming data.
 */

import {
  type RpcId,
  type RpcHandler,
  type EventCallback,
  RpcError,
  ErrorCode,
  nextId,
} from "./core.js";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MessageRouter {
  private _handlers = new Map<string, RpcHandler>();
  private _pending = new Map<RpcId, PendingCall>();
  private _subscribers = new Map<string, Set<EventCallback>>();
  private _closed = false;

  constructor(
    private readonly _send: (raw: string) => void,
    private readonly _timeout: number = 30_000,
  ) {}

  // ── Incoming message entry point ────────────────────────────────────

  /** Called by transport when a raw JSON message arrives. */
  dispatchMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);
      if (Array.isArray(msg)) {
        this._dispatchBatch(msg);
      } else {
        this._dispatch(msg);
      }
    } catch {
      // ignore non-JSON
    }
  }

  // ── RPC methods ─────────────────────────────────────────────────────

  /** Register an RPC method handler. */
  register(method: string, handler: RpcHandler): void {
    this._handlers.set(method, handler);
  }

  unregister(method: string): void {
    this._handlers.delete(method);
  }

  /** Send an RPC request and wait for response. */
  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    if (this._closed) {
      return Promise.reject(
        new RpcError(ErrorCode.NOT_CONNECTED, "not connected"),
      );
    }
    const id = nextId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new RpcError(ErrorCode.TIMEOUT, "timeout"));
      }, timeoutMs ?? this._timeout);
      this._pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this._rawSend({ jsonrpc: "2.0", id, method, params });
    });
  }

  /**
   * Send a batch of RPC requests. Returns results in request order.
   * If any individual call returns an error, the corresponding element
   * will be an RpcError instance.
   */
  batchRequest<T = unknown>(
    calls: Array<[method: string, params?: unknown]>,
    timeoutMs?: number,
  ): Promise<T[]> {
    if (this._closed) {
      return Promise.reject(
        new RpcError(ErrorCode.NOT_CONNECTED, "not connected"),
      );
    }
    if (calls.length === 0) return Promise.resolve([]);

    const requests: Record<string, unknown>[] = [];
    const promises: Promise<unknown>[] = [];

    for (const [method, params] of calls) {
      const id = nextId();
      const p = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pending.delete(id);
          reject(new RpcError(ErrorCode.TIMEOUT, "batch timeout"));
        }, timeoutMs ?? this._timeout);
        this._pending.set(id, { resolve, reject, timer });
      });
      promises.push(p.catch((err) => err));
      requests.push({ jsonrpc: "2.0", id, method, params });
    }

    this._rawSend(requests);
    return Promise.all(promises) as Promise<T[]>;
  }

  // ── Pub/Sub (notifications) ──────────────────────────────────────────

  /** Send a JSON-RPC notification (no response expected). */
  publish(method: string, params?: unknown): void {
    this._rawSend({ jsonrpc: "2.0", method, params });
  }

  /** Subscribe to incoming notifications with the given method name. */
  subscribe(method: string, callback: EventCallback): void {
    if (!this._subscribers.has(method))
      this._subscribers.set(method, new Set());
    this._subscribers.get(method)!.add(callback);
  }

  /** Remove a notification subscription. */
  unsubscribe(method: string, callback: EventCallback): void {
    this._subscribers.get(method)?.delete(callback);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Reject all pending calls and clean up. */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(new RpcError(ErrorCode.NOT_CONNECTED, "disconnected"));
    }
    this._pending.clear();
  }

  /** Reset closed state so the router can be reused after reconnect. */
  reopen(): void {
    this._closed = false;
  }

  get closed(): boolean {
    return this._closed;
  }

  // ── Internal dispatch ───────────────────────────────────────────────

  private _dispatch(msg: Record<string, unknown>): void {
    const method = msg.method as string | undefined;

    // Heartbeat
    if (method === "ping") {
      this._rawSend({ jsonrpc: "2.0", method: "pong" });
      return;
    }
    if (method === "pong") {
      return;
    }

    const id = msg.id as RpcId | undefined;

    // Response to our pending request
    if (id !== undefined && this._pending.has(id)) {
      const { resolve, reject, timer } = this._pending.get(id)!;
      clearTimeout(timer);
      this._pending.delete(id);
      const error = msg.error as
        | { code: number; message: string; data?: unknown }
        | undefined;
      if (error) reject(new RpcError(error.code, error.message, error.data));
      else resolve(msg.result);
      return;
    }

    // Notification (has method, no id) — fire subscribers
    if (typeof method === "string" && id === undefined) {
      const subs = this._subscribers.get(method);
      if (subs) for (const fn of subs) fn(msg.params);
      return;
    }

    // Incoming RPC call (has method + id)
    if (method && id !== undefined) {
      const handler = this._handlers.get(method);
      if (!handler) {
        this._rawSend({
          jsonrpc: "2.0",
          id,
          error: {
            code: ErrorCode.METHOD_NOT_FOUND,
            message: `method not found: ${method}`,
          },
        });
        return;
      }
      (async () => {
        try {
          const result = await handler(msg.params);
          this._rawSend({ jsonrpc: "2.0", id, result });
        } catch (err: unknown) {
          const rpcErr =
            err instanceof RpcError
              ? err
              : new RpcError(ErrorCode.INTERNAL_ERROR, String(err));
          this._rawSend({
            jsonrpc: "2.0",
            id,
            error: {
              code: rpcErr.code,
              message: rpcErr.message,
              ...(rpcErr.data !== undefined ? { data: rpcErr.data } : {}),
            },
          });
        }
      })();
    }
  }

  /**
   * Handle an incoming JSON-RPC batch (array of messages).
   * Per the spec:
   * - Empty array → single Invalid Request error
   * - Non-object elements → Invalid Request error per element
   * - Notifications produce no response
   * - If all are notifications, nothing is returned
   */
  private async _dispatchBatch(batch: unknown[]): Promise<void> {
    if (batch.length === 0) {
      this._rawSend({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: ErrorCode.INVALID_REQUEST,
          message: "Invalid Request",
        },
      });
      return;
    }

    const responses = await Promise.all(
      batch.map((item) => this._processBatchItem(item)),
    );

    const filtered = responses.filter(
      (r): r is Record<string, unknown> => r !== null,
    );

    if (filtered.length > 0) {
      this._rawSend(filtered);
    }
  }

  private async _processBatchItem(
    item: unknown,
  ): Promise<Record<string, unknown> | null> {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: ErrorCode.INVALID_REQUEST,
          message: "Invalid Request",
        },
      };
    }

    const msg = item as Record<string, unknown>;
    const method = msg.method as string | undefined;
    const id = msg.id as RpcId | undefined;

    // Heartbeat
    if (method === "ping") {
      return { jsonrpc: "2.0", method: "pong" };
    }
    if (method === "pong") {
      return null;
    }

    // Response to our pending request
    if (id !== undefined && this._pending.has(id)) {
      const { resolve, reject, timer } = this._pending.get(id)!;
      clearTimeout(timer);
      this._pending.delete(id);
      const error = msg.error as
        | { code: number; message: string; data?: unknown }
        | undefined;
      if (error) reject(new RpcError(error.code, error.message, error.data));
      else resolve(msg.result);
      return null;
    }

    // Notification (has method, no id) — fire subscribers
    if (typeof method === "string" && id === undefined) {
      const subs = this._subscribers.get(method);
      if (subs) for (const fn of subs) fn(msg.params);
      return null;
    }

    // RPC call (has method + id) — execute and return response
    if (method && id !== undefined) {
      const handler = this._handlers.get(method);
      if (!handler) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: ErrorCode.METHOD_NOT_FOUND,
            message: `method not found: ${method}`,
          },
        };
      }
      try {
        const result = await handler(msg.params);
        return { jsonrpc: "2.0", id, result };
      } catch (err: unknown) {
        const rpcErr =
          err instanceof RpcError
            ? err
            : new RpcError(ErrorCode.INTERNAL_ERROR, String(err));
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: rpcErr.code,
            message: rpcErr.message,
            ...(rpcErr.data !== undefined ? { data: rpcErr.data } : {}),
          },
        };
      }
    }

    // Invalid request (no method)
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      error: {
        code: ErrorCode.INVALID_REQUEST,
        message: "Invalid Request",
      },
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private _rawSend(
    msg: Record<string, unknown> | Record<string, unknown>[],
  ): void {
    if (!this._closed) {
      this._send(JSON.stringify(msg));
    }
  }
}
