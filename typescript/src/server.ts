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
 * Use `conn` to request/publish back to the specific client.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServerRpcHandler<T = any> = (
  params: T,
  conn: RpcConnection,
) => any | Promise<any>;

/**
 * Server-side notification callback — receives the publishing connection as `conn`.
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
  /** Auth handler called during WebSocket upgrade handshake (validates URL query params) */
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
  private _globalSubscribers = new Map<string, ServerEventCallback[]>();
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wssOpts: any = { host: this.host, port: this.port };

    if (this.authHandler) {
      wssOpts.verifyClient = (
        info: { req: import("http").IncomingMessage },
        done: (
          result: boolean,
          code?: number,
          message?: string,
        ) => void,
      ) => {
        const url = new URL(info.req.url ?? "/", `http://${info.req.headers.host}`);
        const token = url.searchParams.get("token") ?? "";
        const role = url.searchParams.get("role") ?? "web";
        const clientId = url.searchParams.get("client_id") ?? "";
        const authParams = { token, role, client_id: clientId };

        Promise.resolve()
          .then(() => this.authHandler!(authParams))
          .then(() => {
            // Stash metadata on the request for _handleConnection
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (info.req as any)._viberpcMeta = { token, role, client_id: clientId };
            done(true);
          })
          .catch(() => {
            done(false, 401, "Unauthorized");
          });
      };
    }

    this._wss = new WebSocketServer(wssOpts);

    return new Promise<void>((resolve) => {
      this._wss.on("listening", () => {
        resolve();
      });

      this._wss.on(
        "connection",
        (ws: import("ws").WebSocket, req: import("http").IncomingMessage) => {
          this._handleConnection(ws, req);
        },
      );
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

  // ── RPC Registration ─────────────────────────────────────────────────

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

  // ── Pub/Sub Registration ─────────────────────────────────────────────

  /**
   * Subscribe to notifications published by clients. The callback receives
   * `(data, conn)` where `conn` is the `RpcConnection` that published.
   *
   * @example
   * server.subscribe("chat.message", (data, conn) => {
   *   server.broadcastExcept("chat.message", data, conn);
   * });
   */
  subscribe(method: string, callback: ServerEventCallback): void {
    if (!this._globalSubscribers.has(method)) {
      this._globalSubscribers.set(method, []);
    }
    this._globalSubscribers.get(method)!.push(callback);
  }

  unsubscribe(method: string, callback: ServerEventCallback): void {
    const cbs = this._globalSubscribers.get(method);
    if (cbs) {
      const idx = cbs.indexOf(callback);
      if (idx !== -1) cbs.splice(idx, 1);
    }
  }

  // ── Lifecycle hooks ──────────────────────────────────────────────────

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

  /** Publish a notification to all (or role-filtered) connections. */
  broadcast(method: string, params?: unknown, role?: string): void {
    const targets =
      role !== undefined ? this.getConnections(role) : [...this._connections];
    for (const conn of targets) {
      if (conn.isOpen) conn.publish(method, params);
    }
  }

  /** Publish a notification to all connections except *exclude*. */
  broadcastExcept(
    method: string,
    params?: unknown,
    exclude?: RpcConnection,
  ): void {
    for (const conn of this._connections) {
      if (conn !== exclude && conn.isOpen) conn.publish(method, params);
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private async _handleConnection(
    ws: import("ws").WebSocket,
    req: import("http").IncomingMessage,
  ): Promise<void> {
    // ws package's WebSocket satisfies IWebSocket via duck typing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = new RpcConnection(ws as any, this.timeout, this.pingInterval);

    // Read metadata stashed by verifyClient, or parse from URL
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stashedMeta = (req as any)._viberpcMeta;
    if (stashedMeta) {
      conn.meta.token = stashedMeta.token;
      conn.meta.role = stashedMeta.role;
      conn.meta.client_id = stashedMeta.client_id;
    } else {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      conn.meta.token = url.searchParams.get("token") ?? "";
      conn.meta.role = url.searchParams.get("role") ?? "web";
      conn.meta.client_id = url.searchParams.get("client_id") ?? "";
    }
    conn.meta.authenticated = true;

    // Register global handlers — wrap to inject conn
    for (const [method, handler] of this._globalHandlers) {
      conn.register(method, (params) => handler(params, conn));
    }

    // Register global subscribers — wrap to inject conn
    for (const [method, callbacks] of this._globalSubscribers) {
      for (const cb of callbacks) {
        conn.subscribe(method, (data) => cb(data, conn));
      }
    }

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
}
