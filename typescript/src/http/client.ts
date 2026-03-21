/**
 * HttpClient — implements ITransportClient over HTTP POST.
 * Starts a local HTTP server to receive messages from the remote server.
 * send(raw) → POST to remote server's /rpc endpoint.
 * connect() → POST to /connect with callback URL.
 * disconnect() → POST to /disconnect.
 *
 * Node.js only (uses `http` module).
 */

import { RpcError, ErrorCode } from "../core.js";
import type { ITransportClient } from "../transport.js";

export interface HttpClientOptions {
  /** Auth token. */
  token?: string;
  /** Client role (default: "web"). */
  role?: string;
  /** Arbitrary client ID. */
  clientId?: string;
  /** Local host for callback server (default: "127.0.0.1"). */
  callbackHost?: string;
  /** Local port for callback server (default: 0 = OS-assigned). */
  callbackPort?: number;
}

export class HttpClient implements ITransportClient {
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;
  onMessage: ((raw: string) => void) | null = null;
  onAuthFailed: (() => void) | null = null;

  private _connected = false;
  private _connectionId: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _callbackServer: any = null;
  private _callbackUrl: string | null = null;

  private readonly token: string;
  private readonly role: string;
  private readonly clientId: string;
  private readonly callbackHost: string;
  private readonly callbackPort: number;

  constructor(
    private readonly serverUrl: string,
    opts: HttpClientOptions = {},
  ) {
    this.token = opts.token ?? "";
    this.role = opts.role ?? "web";
    this.clientId = opts.clientId ?? "";
    this.callbackHost = opts.callbackHost ?? "127.0.0.1";
    this.callbackPort = opts.callbackPort ?? 0;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(timeoutMs = 10_000): Promise<void> {
    const result = await Promise.race([
      this._doConnect(),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), timeoutMs),
      ),
    ]);
    if (result === "timeout" && !this._connected) {
      this._stopCallbackServer();
      throw new RpcError(ErrorCode.TIMEOUT, "connection timeout");
    }
  }

  disconnect(): void {
    this._doDisconnect();
  }

  async send(raw: string): Promise<void> {
    if (!this._connected || !this._connectionId) return;
    const url = `${this.serverUrl}/rpc?connection_id=${this._connectionId}`;
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      });
    } catch {
      this._markDisconnected();
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private async _doConnect(): Promise<void> {
    try {
      // Start local callback server
      const http = await import("http");
      this._callbackServer = http.createServer((req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          this.onMessage?.(body);
          res.writeHead(200).end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        this._callbackServer.listen(
          this.callbackPort,
          this.callbackHost,
          () => resolve(),
        );
      });

      const addr = this._callbackServer.address();
      this._callbackUrl = `http://${this.callbackHost}:${addr.port}/rpc`;

      // Register with server
      const response = await fetch(`${this.serverUrl}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_url: this._callbackUrl,
          token: this.token,
          role: this.role,
          client_id: this.clientId,
        }),
      });

      if (response.status === 401) {
        this.onAuthFailed?.();
        this._stopCallbackServer();
        return;
      }

      if (!response.ok) {
        this._stopCallbackServer();
        return;
      }

      const data = await response.json();
      this._connectionId = data.connection_id;
      this._connected = true;
      this.onOpen?.();
    } catch {
      this._stopCallbackServer();
    }
  }

  private async _doDisconnect(): Promise<void> {
    if (this._connectionId) {
      try {
        await fetch(`${this.serverUrl}/disconnect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connection_id: this._connectionId }),
        });
      } catch {
        // best effort
      }
    }
    this._markDisconnected();
    this._stopCallbackServer();
  }

  private _markDisconnected(): void {
    if (!this._connected) return;
    this._connected = false;
    this._connectionId = null;
    this.onClose?.();
  }

  private _stopCallbackServer(): void {
    if (this._callbackServer) {
      this._callbackServer.close();
      this._callbackServer = null;
    }
  }
}
