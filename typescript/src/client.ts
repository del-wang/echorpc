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
  private eventListeners = new Map<string, Set<EventCallback>>();

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

  // ── Public API ────────────────────────────────────────────────────────

  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  unregister(method: string): void {
    this.handlers.delete(method);
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
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

  emit(event: string, data?: unknown): void {
    this._send({ jsonrpc: "2.0", method: `event:${event}`, params: data });
  }

  on(event: string, callback: EventCallback): void {
    if (!this.eventListeners.has(event))
      this.eventListeners.set(event, new Set());
    this.eventListeners.get(event)!.add(callback);
  }

  off(event: string, callback: EventCallback): void {
    this.eventListeners.get(event)?.delete(callback);
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
        this._dispatch(msg);
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
        await this.call("auth.login", {
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

    // Response to our call
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

    // Event
    if (typeof method === "string" && method.startsWith("event:")) {
      const evName = method.slice(6);
      this.eventListeners.get(evName)?.forEach((fn) => fn(msg.params));
      return;
    }

    // Incoming RPC call
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
            error: { code: rpcErr.code, message: rpcErr.message },
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

  private _send(msg: Record<string, unknown>): void {
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
