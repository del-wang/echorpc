/**
 * Transport layer interfaces — protocol-agnostic contracts.
 * Implementations: WsTransport, HttpTransport, etc.
 */

/** Single bidirectional message channel (one per connected peer). */
export interface ITransportConnection {
  send(raw: string): void | Promise<void>;
  close(): void;
  readonly isOpen: boolean;
  onMessage: ((raw: string) => void) | null;
  onClose: (() => void) | null;
}

/** Client-side transport — manages outgoing connection lifecycle. */
export interface ITransportClient {
  connect(timeoutMs?: number): Promise<void>;
  disconnect(): Promise<void>;
  send(raw: string): Promise<void>;
  readonly connected: boolean;
  onOpen: (() => void) | null;
  onClose: (() => void) | null;
  onMessage: ((raw: string) => void) | null;
  onAuthFailed: (() => void) | null;
}

/** Server-side transport — accepts incoming connections. */
export interface ITransportServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly address: { host: string; port: number } | null;
  onConnection:
    | ((conn: ITransportConnection, meta: Record<string, unknown>) => void)
    | null;
}
