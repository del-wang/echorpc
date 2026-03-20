/**
 * WebSocket JSON-RPC 2.0 server for Node.js.
 * Mirrors Python's RpcServer API.
 *
 * Requires the `ws` package.
 *
 * @example
 * import { RpcServer } from "viberpc/server";
 * const server = new RpcServer({ port: 9100 });
 * server.register("echo", (params) => params);
 * await server.start();
 */

import {
  type RpcHandler,
  type EventCallback,
  RpcError,
  ErrorCode,
} from "./core.js";
import { RpcConnection } from "./connection.js";

// ── Types ──────────────────────────────────────────────────────────────

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
  private _globalHandlers = new Map<string, RpcHandler>();
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

  register(method: string, handler: RpcHandler): void {
    this._globalHandlers.set(method, handler);
  }

  unregister(method: string): void {
    this._globalHandlers.delete(method);
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

    // Register global handlers
    for (const [method, handler] of this._globalHandlers) {
      conn.register(method, handler);
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
