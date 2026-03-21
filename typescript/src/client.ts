/**
 * Universal WebSocket JSON-RPC 2.0 client.
 * Works in Node.js (with `ws`) and browsers (native WebSocket).
 *
 * @example
 * // Browser — zero deps, uses native WebSocket
 * const rpc = new RpcClient("ws://localhost:9100", { token: "secret" });
 *
 * // Node.js — pass `ws` package
 * import WebSocket from "ws";
 * const rpc = new RpcClient("ws://localhost:9100", { token: "secret", WebSocket });
 */

import {
  type RpcId,
  type IWebSocket,
  type WebSocketConstructor,
  type ClientOptions,
  type RpcHandler,
  type EventCallback,
  RpcError,
  ErrorCode,
  DEFAULT_OPTIONS,
  nextId,
  resolveWebSocket,
} from "./core.js";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

// readyState constants (same across all WebSocket implementations)
const WS_OPEN = 1;

export class RpcClient {
  private ws: IWebSocket | null = null;
  private opts: Required<Omit<ClientOptions, "WebSocket">> & {
    WebSocket: WebSocketConstructor | undefined;
  };
  private url: string;

  private handlers = new Map<string, RpcHandler>();
  private pending = new Map<RpcId, PendingCall>();
  private subscribers = new Map<string, Set<EventCallback>>();

  private _connected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  public onConnect?: () => void;
  public onDisconnect?: () => void;
  public onAuthFailed?: () => void;

  constructor(url: string, opts: ClientOptions = {}) {
    this.url = url;
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  get connected(): boolean {
    return this._connected;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  connect(): void {
    this.intentionalClose = false;
    this._doConnect();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this._cleanup();
    this.ws?.close();
    this.ws = null;
  }

  /** Returns a promise that resolves once connected and authenticated. */
  waitConnected(timeoutMs = 10_000): Promise<void> {
    if (this._connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RpcError(ErrorCode.TIMEOUT, "connection timeout"));
      }, timeoutMs);
      const origOnConnect = this.onConnect;
      this.onConnect = () => {
        clearTimeout(timer);
        this.onConnect = origOnConnect;
        origOnConnect?.();
        resolve();
      };
    });
  }

  // ── RPC methods ────────────────────────────────────────────────────

  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  unregister(method: string): void {
    this.handlers.delete(method);
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this._connected || !this.ws) {
      throw new RpcError(ErrorCode.NOT_CONNECTED, "not connected");
    }
    const id = nextId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(ErrorCode.TIMEOUT, "timeout"));
      }, this.opts.timeout);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /**
   * Send a batch of RPC requests. Returns results in request order.
   * If any individual call returns an error, the corresponding element
   * will be an RpcError instance.
   */
  async batchRequest<T = unknown>(
    calls: Array<[method: string, params?: unknown]>,
  ): Promise<T[]> {
    if (!this._connected || !this.ws) {
      throw new RpcError(ErrorCode.NOT_CONNECTED, "not connected");
    }
    if (calls.length === 0) return [];

    const requests: Record<string, unknown>[] = [];
    const promises: Promise<unknown>[] = [];

    for (const [method, params] of calls) {
      const id = nextId();
      const p = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(ErrorCode.TIMEOUT, "batch timeout"));
        }, this.opts.timeout);
        this.pending.set(id, {
          resolve,
          reject,
          timer,
        });
      });
      // Wrap so errors become values
      promises.push(p.catch((err) => err));
      requests.push({ jsonrpc: "2.0", id, method, params });
    }

    this._send(requests);
    return Promise.all(promises) as Promise<T[]>;
  }

  // ── Pub/Sub ─────────────────────────────────────────────────────────

  /** Send a JSON-RPC notification (no response expected). */
  publish(method: string, params?: unknown): void {
    this._send({ jsonrpc: "2.0", method, params });
  }

  /** Subscribe to incoming notifications with the given method name. */
  subscribe(method: string, callback: EventCallback): void {
    if (!this.subscribers.has(method))
      this.subscribers.set(method, new Set());
    this.subscribers.get(method)!.add(callback);
  }

  /** Remove a notification subscription. */
  unsubscribe(method: string, callback: EventCallback): void {
    this.subscribers.get(method)?.delete(callback);
  }

  // ── Internal connect ──────────────────────────────────────────────────

  private _doConnect(): void {
    const WS = resolveWebSocket(this.opts.WebSocket);
    try {
      this.ws = new WS(this.url);
    } catch {
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => this._onOpen();
    this.ws.onclose = () => this._onClose();
    this.ws.onerror = () => {};
    this.ws.onmessage = (e: { data: unknown }) => {
      try {
        const msg = JSON.parse(String(e.data));
        if (Array.isArray(msg)) {
          // Batch response — dispatch each individually
          for (const item of msg) {
            this._dispatch(item);
          }
        } else {
          this._dispatch(msg);
        }
      } catch {
        // ignore non-JSON
      }
    };
  }

  private async _onOpen(): Promise<void> {
    this._connected = true;
    this.reconnectAttempt = 0;
    this._startPing();

    if (this.opts.token) {
      try {
        await this.request("auth.login", {
          token: this.opts.token,
          role: this.opts.role,
          client_id: this.opts.clientId,
        });
      } catch {
        this.onAuthFailed?.();
        this.disconnect();
        return;
      }
    }
    this.onConnect?.();
  }

  private _onClose(): void {
    const wasConnected = this._connected;
    this._connected = false;
    this._cleanup();
    this._rejectAllPending(
      new RpcError(ErrorCode.NOT_CONNECTED, "disconnected"),
    );
    if (wasConnected) this.onDisconnect?.();
    if (!this.intentionalClose && this.opts.autoReconnect) {
      this._scheduleReconnect();
    }
  }

  // ── Dispatch ──────────────────────────────────────────────────────────

  private _dispatch(msg: Record<string, unknown>): void {
    const method = msg.method as string | undefined;

    // Heartbeat
    if (method === "ping") {
      this._send({ jsonrpc: "2.0", method: "pong" });
      return;
    }
    if (method === "pong") {
      this._refreshPong();
      return;
    }

    const id = msg.id as RpcId | undefined;

    // Response to our request
    if (id !== undefined && this.pending.has(id)) {
      const { resolve, reject, timer } = this.pending.get(id)!;
      clearTimeout(timer);
      this.pending.delete(id);
      const error = msg.error as
        | { code: number; message: string; data?: unknown }
        | undefined;
      if (error) reject(new RpcError(error.code, error.message, error.data));
      else resolve(msg.result);
      return;
    }

    // Notification (has method, no id) — fire subscribers
    if (typeof method === "string" && id === undefined) {
      const subs = this.subscribers.get(method);
      if (subs) for (const fn of subs) fn(msg.params);
      return;
    }

    // Incoming RPC call (has method + id)
    if (method && id !== undefined) {
      const handler = this.handlers.get(method);
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

  // ── Heartbeat ─────────────────────────────────────────────────────────

  private _startPing(): void {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      this._send({ jsonrpc: "2.0", method: "ping" });
      this.pongTimer = setTimeout(() => {
        this.ws?.close();
      }, 5_000);
    }, this.opts.pingInterval);
  }

  private _stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  private _refreshPong(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  // ── Reconnect ─────────────────────────────────────────────────────────

  private _scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempt++;
    const delay = Math.min(
      100 * Math.pow(2, this.reconnectAttempt),
      this.opts.maxReconnectDelay,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._doConnect();
    }, delay);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private _send(msg: Record<string, unknown> | Record<string, unknown>[]): void {
    if (this.ws?.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private _rejectAllPending(err: RpcError): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  private _cleanup(): void {
    this._stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
