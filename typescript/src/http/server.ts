/**
 * HttpServer — implements ITransportServer over HTTP POST.
 * Starts an HTTP server with endpoints:
 *   POST /rpc       — receive RPC messages from registered clients
 *   POST /connect   — register a client callback URL, emit new connection
 *   POST /disconnect — remove client connection
 *
 * Node.js only (uses `http` module).
 */

import type { ITransportServer, ITransportConnection } from "../transport.js";
import { HttpConnection } from "./connection.js";

export interface HttpServerOptions {
  /** Host to bind (default: "0.0.0.0"). */
  host?: string;
  /** Port to listen on (default: 9200). */
  port?: number;
  /** Auth handler for validating connect requests. */
  authHandler?: (
    params: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
}

export class HttpServer implements ITransportServer {
  onConnection:
    | ((conn: ITransportConnection, meta: Record<string, unknown>) => void)
    | null = null;

  private readonly host: string;
  private readonly port: number;
  private readonly authHandler?: (
    params: Record<string, unknown>,
  ) => unknown | Promise<unknown>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _server: any = null;
  private _connections = new Map<string, HttpConnection>();

  constructor(opts: HttpServerOptions = {}) {
    this.host = opts.host ?? "0.0.0.0";
    this.port = opts.port ?? 9200;
    this.authHandler = opts.authHandler;
  }

  get address(): { host: string; port: number } | null {
    const addr = this._server?.address();
    if (!addr || typeof addr === "string") return null;
    return { host: addr.address, port: addr.port };
  }

  async start(): Promise<void> {
    const http = await import("http");

    this._server = http.createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end("Method Not Allowed");
        return;
      }

      const body = await this._readBody(req);
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const path = url.pathname;

      try {
        if (path === "/connect") {
          await this._handleConnect(body, res);
        } else if (path === "/disconnect") {
          this._handleDisconnect(body, res);
        } else if (path === "/rpc") {
          this._handleRpc(body, url, res);
        } else {
          res.writeHead(404).end("Not Found");
        }
      } catch (err) {
        res.writeHead(500).end("Internal Server Error");
      }
    });

    return new Promise<void>((resolve) => {
      this._server.listen(this.port, this.host, () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Close all connections
    for (const [id, conn] of this._connections) {
      conn.close();
    }
    this._connections.clear();

    if (this._server) {
      await new Promise<void>((resolve) => {
        this._server.close(() => resolve());
      });
      this._server = null;
    }
  }

  // ── Internal handlers ────────────────────────────────────────────────

  private async _handleConnect(
    body: string,
    res: import("http").ServerResponse,
  ): Promise<void> {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400).end("Invalid JSON");
      return;
    }

    const callbackUrl = data.callback_url as string;
    if (!callbackUrl) {
      res.writeHead(400).end("Missing callback_url");
      return;
    }

    const meta: Record<string, unknown> = {
      token: data.token ?? "",
      role: data.role ?? "web",
      client_id: data.client_id ?? "",
      authenticated: true,
    };

    // Auth check
    if (this.authHandler) {
      try {
        await this.authHandler(meta);
      } catch {
        res.writeHead(401).end("Unauthorized");
        return;
      }
    }

    const conn = new HttpConnection(callbackUrl);
    this._connections.set(conn.id, conn);

    // When connection closes, remove it
    conn.onClose = () => {
      this._connections.delete(conn.id);
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ connection_id: conn.id }));

    this.onConnection?.(conn, meta);
  }

  private _handleDisconnect(
    body: string,
    res: import("http").ServerResponse,
  ): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400).end("Invalid JSON");
      return;
    }

    const connId = data.connection_id as string;
    const conn = this._connections.get(connId);
    if (conn) {
      conn.close();
      this._connections.delete(connId);
    }

    res.writeHead(200).end("OK");
  }

  private _handleRpc(
    body: string,
    url: URL,
    res: import("http").ServerResponse,
  ): void {
    const connId =
      url.searchParams.get("connection_id") ??
      (() => {
        try {
          return JSON.parse(body)?.connection_id;
        } catch {
          return undefined;
        }
      })();

    // If connection_id provided, route to that connection
    if (connId) {
      const conn = this._connections.get(connId);
      if (!conn) {
        res.writeHead(404).end("Connection not found");
        return;
      }
      conn.deliverMessage(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Without connection_id, broadcast to first connection (simple mode)
    res.writeHead(400).end("Missing connection_id");
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private _readBody(req: import("http").IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString()));
      req.on("error", reject);
    });
  }
}
