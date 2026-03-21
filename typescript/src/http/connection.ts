/**
 * HttpConnection — implements ITransportConnection over HTTP POST.
 * Wraps a callback URL (the peer's HTTP endpoint).
 * send(raw) → POST to peer's callback URL.
 */

import type { ITransportConnection } from "../transport.js";

export class HttpConnection implements ITransportConnection {
  onMessage: ((raw: string) => void) | null = null;
  onClose: (() => void) | null = null;

  private _open = true;

  constructor(
    /** The peer's callback URL to POST messages to. */
    public readonly callbackUrl: string,
    /** Optional metadata associated with this connection. */
    public readonly id: string = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2),
  ) {}

  get isOpen(): boolean {
    return this._open;
  }

  send(raw: string): void {
    if (!this._open) return;
    fetch(this.callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    }).catch(() => {
      // If POST fails, mark connection as closed
      this._markClosed();
    });
  }

  close(): void {
    this._markClosed();
  }

  /** Deliver a message from the peer (called by HttpServer when it receives a POST). */
  deliverMessage(raw: string): void {
    this.onMessage?.(raw);
  }

  private _markClosed(): void {
    if (!this._open) return;
    this._open = false;
    this.onClose?.();
  }
}
