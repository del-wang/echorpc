/**
 * WebSocket JSON-RPC 2.0 server for Node.js.
 * Mirrors Python's RpcServer API.
 *
 * @example
 * import { RpcServer } from "viberpc/server";
 * const server = new RpcServer({ port: 9100 });
 * server.register("echo", (params, conn) => params);
 * await server.start();
 */

import { RpcConnection } from "./connection.js";

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Server-side RPC handler — receives the calling connection as `conn`.
 * Use `conn` to call/emit back to the specific client.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServerRpcHandler<T = any> = (
  params: T,
  conn: RpcConnection,
) => any | Promise<any>;

/**
 * Server-side event callback — receives the emitting connection as `conn`.
 */
export type ServerEventCallback<T = unknown> = (
  data: T,
  conn: RpcConnection,
) => void | Promise<void>;

export type AuthHandler = (
  params: Record<string, unknown>,
) => unknown | Promise<unknown>;
export type OnConnectCallback = (conn: RpcConnection) => void | Promise<void>;
export type OnDisconnectCallback = (
  conn: RpcConnection,
) => void | Promise<void>;

export interface ServerOptions {
  /** Host to bind (default: "0.0.0.0") */
  host?: string;
  /** Port to listen on (default: 9100) */
  port?: number;
  /** Auth handler called on auth.login */
  authHandler?: AuthHandler;
  /** RPC call timeout in ms (default: 30000) */
  timeout?: number;
  /** Heartbeat interval in ms (default: 30000) */
  pingInterval?: number;
}

// ── Server ─────────────────────────────────────────────────────────────

export class RpcServer {
  private host: string;
  private port: number;
  private authHandler?: AuthHandler;
  private timeout: number;
  private pingInterval: number;

  private _connections = new Set<RpcConnection>();
  private _globalHandlers = new Map<string, ServerRpcHandler>();
  private _globalEventListeners = new Map<string, ServerEventCallback[]>();
  private _onConnectCbs: OnConnectCallback[] = [];
  private _onDisconnectCbs: OnDisconnectCallback[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _wss: any = null;

  constructor(opts: ServerOptions = {}) {
    this.host = opts.host ?? "0.0.0.0";
    this.port = opts.port ?? 9100;
    this.authHandler = opts.authHandler;
    this.timeout = opts.timeout ?? 30_000;
    this.pingInterval = opts.pingInterval ?? 30_000;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Dynamic import so the module stays loadable in environments without `ws`
    const { WebSocketServer } = await import("ws");
    this._wss = new WebSocketServer({ host: this.host, port: this.port });

    return new Promise<void>((resolve) => {
      this._wss.on("listening", () => {
        resolve();
      });

      this._wss.on("connection", (ws: import("ws").WebSocket) => {
        this._handleConnection(ws);
      });
    });
  }

  async stop(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const conn of this._connections) {
      closePromises.push(conn.close());
    }
    await Promise.all(closePromises);

    if (this._wss) {
      await new Promise<void>((resolve) => {
        this._wss.close(() => resolve());
      });
      this._wss = null;
    }
  }

  async serveForever(): Promise<void> {
    await this.start();
    // Block forever
    await new Promise<void>(() => {});
  }

  /** The actual port the server is listening on (useful when port=0). */
  get address(): { host: string; port: number } | null {
    const addr = this._wss?.address();
    if (!addr || typeof addr === "string") return null;
    return { host: addr.address, port: addr.port };
  }

  // ── Registration ─────────────────────────────────────────────────────

  /**
   * Register a global RPC method. The handler receives `(params, conn)` where
   * `conn` is the `RpcConnection` that made the call.
   *
   * @example
   * server.register("echo", (params, conn) => {
   *   console.log("called by", conn.meta.role);
   *   return params;
   * });
   */
  register(method: string, handler: ServerRpcHandler): void {
    this._globalHandlers.set(method, handler);
  }

  unregister(method: string): void {
    this._globalHandlers.delete(method);
  }

  /**
   * Listen for events emitted by clients. The callback receives `(data, conn)`
   * where `conn` is the `RpcConnection` that emitted the event.
   *
   * @example
   * server.on("chat.message", (data, conn) => {
   *   server.broadcastEventExcept("chat.message", data, conn);
   * });
   */
  on(event: string, callback: ServerEventCallback): void {
    if (!this._globalEventListeners.has(event)) {
      this._globalEventListeners.set(event, []);
    }
    this._globalEventListeners.get(event)!.push(callback);
  }

  off(event: string, callback: ServerEventCallback): void {
    const cbs = this._globalEventListeners.get(event);
    if (cbs) {
      const idx = cbs.indexOf(callback);
      if (idx !== -1) cbs.splice(idx, 1);
    }
  }

  onConnect(cb: OnConnectCallback): void {
    this._onConnectCbs.push(cb);
  }

  onDisconnect(cb: OnDisconnectCallback): void {
    this._onDisconnectCbs.push(cb);
  }

  // ── Connection access ────────────────────────────────────────────────

  getConnections(role?: string): RpcConnection[] {
    if (role === undefined) return [...this._connections];
    return [...this._connections].filter((c) => c.meta.role === role);
  }

  // ── Broadcast ────────────────────────────────────────────────────────

  broadcastEvent(event: string, data?: unknown, role?: string): void {
    const targets =
      role !== undefined ? this.getConnections(role) : [...this._connections];
    for (const conn of targets) {
      if (conn.isOpen) conn.emit(event, data);
    }
  }

  broadcastEventExcept(
    event: string,
    data?: unknown,
    exclude?: RpcConnection,
  ): void {
    for (const conn of this._connections) {
      if (conn !== exclude && conn.isOpen) conn.emit(event, data);
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private async _handleConnection(ws: import("ws").WebSocket): Promise<void> {
    // ws package's WebSocket satisfies IWebSocket via duck typing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = new RpcConnection(ws as any, this.timeout, this.pingInterval);

    // Register global handlers — wrap to inject conn
    for (const [method, handler] of this._globalHandlers) {
      conn.register(method, (params) => handler(params, conn));
    }

    // Register global event listeners — wrap to inject conn
    for (const [event, callbacks] of this._globalEventListeners) {
      for (const cb of callbacks) {
        conn.on(event, (data) => cb(data, conn));
      }
    }

    // Built-in auth
    conn.register("auth.login", (params) =>
      this._doAuth(conn, params as Record<string, unknown>),
    );

    this._connections.add(conn);

    // Fire onConnect callbacks
    for (const cb of this._onConnectCbs) {
      try {
        await cb(conn);
      } catch {
        /* ignore */
      }
    }

    try {
      await conn.serve();
    } finally {
      this._connections.delete(conn);
      for (const cb of this._onDisconnectCbs) {
        try {
          await cb(conn);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private async _doAuth(
    conn: RpcConnection,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    let result: unknown = { ok: true };
    if (this.authHandler) {
      result = await this.authHandler(params);
    }

    conn.meta.token = params.token ?? "";
    conn.meta.role = params.role ?? "web";
    conn.meta.client_id = params.client_id ?? "";
    conn.meta.authenticated = true;

    return result;
  }
}
