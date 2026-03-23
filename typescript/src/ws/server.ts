/**
 * WsServer — WebSocket server transport.
 * Implements ITransportServer. Dynamically imports `ws`.
 */

import { DEFAULT_PING_INTERVAL } from "../core.js";
import type { ITransportConnection, ITransportServer } from "../transport.js";
import { WsConnection } from "./connection.js";

export interface WsServerOptions {
  /** Host to bind (default: "0.0.0.0"). */
  host?: string;
  /** Port to listen on (default: 9100). */
  port?: number;
  /** Auth handler called during WebSocket upgrade handshake. */
  authHandler?: (
    params: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
  /** Server-side heartbeat interval in ms (default: 30000). */
  pingInterval?: number;
}

export class WsServer implements ITransportServer {
  onConnection:
    | ((conn: ITransportConnection, meta: Record<string, unknown>) => void)
    | null = null;

  private readonly host: string;
  private readonly port: number;
  private readonly authHandler?: (
    params: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
  private readonly pingInterval: number;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _wss: any = null;

  constructor(opts: WsServerOptions = {}) {
    this.host = opts.host ?? "0.0.0.0";
    this.port = opts.port ?? 9100;
    this.authHandler = opts.authHandler;
    this.pingInterval = opts.pingInterval ?? DEFAULT_PING_INTERVAL;
  }

  get address(): { host: string; port: number } | null {
    const addr = this._wss?.address();
    if (!addr || typeof addr === "string") return null;
    return { host: addr.address, port: addr.port };
  }

  async start(): Promise<void> {
    const { WebSocketServer } = await import("ws");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wssOpts: any = { host: this.host, port: this.port };

    if (this.authHandler) {
      wssOpts.verifyClient = (
        info: { req: import("http").IncomingMessage },
        done: (result: boolean, code?: number, message?: string) => void,
      ) => {
        const url = new URL(
          info.req.url ?? "/",
          `http://${info.req.headers.host}`,
        );
        const token = url.searchParams.get("token") ?? "";
        const role = url.searchParams.get("role") ?? "web";
        const clientId = url.searchParams.get("client_id") ?? "";
        const authParams = { token, role, client_id: clientId };

        Promise.resolve()
          .then(() => this.authHandler!(authParams))
          .then(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (info.req as any)._viberpcMeta = {
              token,
              role,
              client_id: clientId,
            };
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
    if (this._wss) {
      // Close all connected sockets
      for (const client of this._wss.clients) {
        client.close();
      }
      await new Promise<void>((resolve) => {
        this._wss.close(() => resolve());
      });
      this._wss = null;
    }
  }

  private _handleConnection(
    ws: import("ws").WebSocket,
    req: import("http").IncomingMessage,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = new WsConnection(ws as any, this.pingInterval);

    // Read metadata stashed by verifyClient, or parse from URL
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stashedMeta = (req as any)._viberpcMeta;
    let meta: Record<string, unknown>;
    if (stashedMeta) {
      meta = {
        token: stashedMeta.token,
        role: stashedMeta.role,
        client_id: stashedMeta.client_id,
        authenticated: true,
      };
    } else {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      meta = {
        token: url.searchParams.get("token") ?? "",
        role: url.searchParams.get("role") ?? "web",
        client_id: url.searchParams.get("client_id") ?? "",
        authenticated: true,
      };
    }

    this.onConnection?.(conn, meta);
  }
}
