/**
 * Server-side WebSocket JSON-RPC 2.0 connection handler.
 * Wraps a single WebSocket and provides bidirectional RPC + events.
 */

import {
  type RpcId,
  type IWebSocket,
  type RpcHandler,
  type EventCallback,
  RpcError,
  ErrorCode,
  nextId,
} from "./core.js";

const WS_OPEN = 1;
const WS_CLOSING = 2;

export class RpcConnection {
  private _handlers = new Map<string, RpcHandler>();
  private _pending = new Map<
    RpcId,
    {
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private _eventListeners = new Map<string, Set<EventCallback>>();
  private _closed = false;
  private _pingTimer: ReturnType<typeof setInterval> | null = null;

  /** Arbitrary metadata (role, client_id, token, authenticated, etc.) */
  public meta: Record<string, unknown> = {};

  constructor(
    public readonly ws: IWebSocket,
    private readonly timeout: number = 30_000,
    private readonly pingInterval: number = 30_000,
  ) {}

  get isOpen(): boolean {
    return !this._closed && this.ws.readyState === WS_OPEN;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Start listening for messages + heartbeat.
   * Returns a promise that resolves when the connection closes.
   */
  serve(): Promise<void> {
    return new Promise<void>((resolve) => {
      this._startPing();

      this.ws.onmessage = (ev: { data: unknown }) => {
        try {
          const msg = JSON.parse(String(ev.data));
          this._dispatch(msg);
        } catch {
          // ignore non-JSON
        }
      };

      this.ws.onclose = () => {
        this._onClosed();
        resolve();
      };

      this.ws.onerror = () => {
        // onerror is typically followed by onclose
      };
    });
  }

  async close(): Promise<void> {
    this._onClosed();
    if (this.ws.readyState === WS_OPEN || this.ws.readyState === WS_CLOSING) {
      this.ws.close();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────

  register(method: string, handler: RpcHandler): void {
    this._handlers.set(method, handler);
  }

  unregister(method: string): void {
    this._handlers.delete(method);
  }

  call<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.isOpen) {
      return Promise.reject(
        new RpcError(ErrorCode.NOT_CONNECTED, "not connected"),
      );
    }
    const id = nextId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new RpcError(ErrorCode.TIMEOUT, "timeout"));
      }, timeoutMs ?? this.timeout);
      this._pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  emit(event: string, data?: unknown): void {
    this._send({ jsonrpc: "2.0", method: `event:${event}`, params: data });
  }

  on(event: string, callback: EventCallback): void {
    if (!this._eventListeners.has(event))
      this._eventListeners.set(event, new Set());
    this._eventListeners.get(event)!.add(callback);
  }

  off(event: string, callback: EventCallback): void {
    this._eventListeners.get(event)?.delete(callback);
  }

  // ── Dispatch ───────────────────────────────────────────────────────

  private _dispatch(msg: Record<string, unknown>): void {
    const method = msg.method as string | undefined;

    // Heartbeat
    if (method === "ping") {
      this._send({ jsonrpc: "2.0", method: "pong" });
      return;
    }
    if (method === "pong") {
      return;
    }

    const id = msg.id as RpcId | undefined;

    // Response to our pending call
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

    // Event
    if (typeof method === "string" && method.startsWith("event:")) {
      const evName = method.slice(6);
      this._eventListeners.get(evName)?.forEach((fn) => fn(msg.params));
      return;
    }

    // Incoming RPC call
    if (method && id !== undefined) {
      const handler = this._handlers.get(method);
      if (!handler) {
        this._send({
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
          this._send({ jsonrpc: "2.0", id, result });
        } catch (err: unknown) {
          const rpcErr =
            err instanceof RpcError
              ? err
              : new RpcError(ErrorCode.INTERNAL_ERROR, String(err));
          this._send({
            jsonrpc: "2.0",
            id,
            error: { code: rpcErr.code, message: rpcErr.message },
          });
        }
      })();
    }
  }

  // ── Heartbeat ──────────────────────────────────────────────────────

  private _startPing(): void {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      this._send({ jsonrpc: "2.0", method: "ping" });
    }, this.pingInterval);
  }

  private _stopPing(): void {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private _onClosed(): void {
    if (this._closed) return;
    this._closed = true;
    this._stopPing();
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(new RpcError(ErrorCode.NOT_CONNECTED, "disconnected"));
    }
    this._pending.clear();
  }

  private _send(msg: Record<string, unknown>): void {
    if (this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
