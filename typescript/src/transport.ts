/**
 * Transport layer interfaces — protocol-agnostic contracts.
 * Implementations: WsTransport, HttpTransport, etc.
 */

/** Single bidirectional message channel (one per connected peer). */
export interface ITransportConnection {
  send(raw: string): void;
  close(): void;
  readonly isOpen: boolean;
  onMessage: ((raw: string) => void) | null;
  onClose: (() => void) | null;
}

/** Client-side transport — manages outgoing connection lifecycle. */
export interface ITransportClient {
  connect(): void;
  disconnect(): void;
  send(raw: string): void;
  readonly connected: boolean;
  waitConnected(timeoutMs?: number): Promise<void>;
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
