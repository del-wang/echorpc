/**
 * WsConnection — wraps an IWebSocket, implements ITransportConnection.
 * Handles ping/pong heartbeat on the server side.
 */

import type { IWebSocket } from "../core.js";
import { DEFAULT_PING_INTERVAL, DEFAULT_PONG_TIMEOUT } from "../core.js";
import type { ITransportConnection } from "../transport.js";

const WS_OPEN = 1;
const WS_CLOSING = 2;

export class WsConnection implements ITransportConnection {
	onMessage: ((raw: string) => void) | null = null;
	onClose: (() => void) | null = null;

	private _closed = false;
	private _pingTimer: ReturnType<typeof setInterval> | null = null;
	private _pongTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		public readonly ws: IWebSocket,
		private readonly pingInterval: number = DEFAULT_PING_INTERVAL,
	) {}

	get isOpen(): boolean {
		return !this._closed && this.ws.readyState === WS_OPEN;
	}

	send(raw: string): void {
		if (this.ws.readyState === WS_OPEN) {
			this.ws.send(raw);
		}
	}

	close(): void {
		this._closed = true;
		this._stopPing();
		if (this.ws.readyState === WS_OPEN || this.ws.readyState === WS_CLOSING) {
			this.ws.close();
		}
	}

	/**
	 * Start the message loop and heartbeat.
	 * Returns a promise that resolves when the connection closes.
	 * Used on the server side to await connection lifetime.
	 */
	serve(): Promise<void> {
		return new Promise<void>((resolve) => {
			this._startPing();

			this.ws.onmessage = (ev: { data: unknown }) => {
				this.onMessage?.(String(ev.data));
			};

			this.ws.onclose = () => {
				this._closed = true;
				this._stopPing();
				this.onClose?.();
				resolve();
			};

			this.ws.onerror = () => {};
		});
	}

	private _startPing(): void {
		this._stopPing();
		this._pingTimer = setInterval(() => {
			if (this.ws.readyState === WS_OPEN) {
				this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "ping" }));
				this._armPongTimeout();
			}
		}, this.pingInterval);
	}

	private _armPongTimeout(): void {
		if (this._pongTimer) return;
		this._pongTimer = setTimeout(() => {
			this._pongTimer = null;
			this.close();
		}, DEFAULT_PONG_TIMEOUT);
	}

	/** Clear pong timeout (called when pong is received via the router). */
	refreshPong(): void {
		if (this._pongTimer) {
			clearTimeout(this._pongTimer);
			this._pongTimer = null;
		}
	}

	private _stopPing(): void {
		if (this._pingTimer) {
			clearInterval(this._pingTimer);
			this._pingTimer = null;
		}
		if (this._pongTimer) {
			clearTimeout(this._pongTimer);
			this._pongTimer = null;
		}
	}
}
