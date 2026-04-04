/**
 * WsClient — WebSocket client transport.
 * Implements ITransportClient with auto-reconnect, auth, and heartbeat.
 */

import {
	DEFAULT_CONNECT_TIMEOUT,
	DEFAULT_MAX_RECONNECT_DELAY,
	DEFAULT_PING_INTERVAL,
	DEFAULT_PONG_TIMEOUT,
	ErrorCode,
	INITIAL_RECONNECT_DELAY,
	RpcError,
	resolveWebSocket,
	type IWebSocket,
	type WebSocketConstructor,
} from "../core.js";
import type { ITransportClient } from "../transport.js";

const WS_OPEN = 1;

export interface WsClientOptions {
	/** Auth token sent as URL query param during WebSocket upgrade. */
	token?: string;
	/** Client role sent as URL query param (default: "web"). */
	role?: string;
	/** Arbitrary client ID. */
	clientId?: string;
	/** Heartbeat interval in ms (default: 30000). */
	pingInterval?: number;
	/** Pong timeout in ms (default: 5000). */
	pongTimeout?: number;
	/** Max reconnect delay in ms (default: 5000). */
	maxReconnectDelay?: number;
	/** Initial reconnect delay in ms (default: 1000). */
	initialReconnectDelay?: number;
	/** Enable auto-reconnect (default: true). */
	autoReconnect?: boolean;
	/** WebSocket constructor (browser: omit; Node.js: pass `ws`). */
	WebSocket?: WebSocketConstructor;
}

export class WsClient implements ITransportClient {
	onOpen: (() => void) | null = null;
	onClose: (() => void) | null = null;
	onMessage: ((raw: string) => void) | null = null;
	onAuthFailed: (() => void) | null = null;

	private ws: IWebSocket | null = null;
	private _connected = false;
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private pongTimer: ReturnType<typeof setTimeout> | null = null;
	private intentionalClose = false;

	private readonly token: string;
	private readonly role: string;
	private readonly clientId: string;
	private readonly pingInterval: number;
	private readonly pongTimeout: number;
	private readonly maxReconnectDelay: number;
	private readonly initialReconnectDelay: number;
	private readonly autoReconnect: boolean;
	private readonly WS: WebSocketConstructor | undefined;

	constructor(
		private readonly url: string,
		opts: WsClientOptions = {},
	) {
		this.token = opts.token ?? "";
		this.role = opts.role ?? "web";
		this.clientId = opts.clientId ?? "";
		this.pingInterval = opts.pingInterval ?? DEFAULT_PING_INTERVAL;
		this.pongTimeout = opts.pongTimeout ?? DEFAULT_PONG_TIMEOUT;
		this.maxReconnectDelay =
			opts.maxReconnectDelay ?? DEFAULT_MAX_RECONNECT_DELAY;
		this.initialReconnectDelay =
			opts.initialReconnectDelay ?? INITIAL_RECONNECT_DELAY;
		this.autoReconnect = opts.autoReconnect ?? true;
		this.WS = opts.WebSocket;
	}

	get connected(): boolean {
		return this._connected;
	}

	private _connectResolve: (() => void) | null = null;
	private _connectReject: ((err: Error) => void) | null = null;

	connect(timeoutMs = DEFAULT_CONNECT_TIMEOUT): Promise<void> {
		this.intentionalClose = false;
		this._everConnected = false;
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._connectResolve = null;
				this._connectReject = null;
				reject(new RpcError(ErrorCode.TIMEOUT, "connection timeout"));
			}, timeoutMs);
			this._connectResolve = () => {
				clearTimeout(timer);
				this._connectResolve = null;
				this._connectReject = null;
				resolve();
			};
			this._connectReject = (err) => {
				clearTimeout(timer);
				this._connectResolve = null;
				this._connectReject = null;
				reject(err);
			};
			this._doConnect();
		});
	}

	async disconnect(): Promise<void> {
		this.intentionalClose = true;
		this._cleanup();
		this.ws?.close();
		this.ws = null;
	}

	async send(raw: string): Promise<void> {
		if (this.ws?.readyState === WS_OPEN) {
			this.ws.send(raw);
		}
	}

	// ── Internal ─────────────────────────────────────────────────────────

	private _buildUrl(): string {
		const url = new URL(this.url);
		if (this.token) url.searchParams.set("token", this.token);
		if (this.role) url.searchParams.set("role", this.role);
		if (this.clientId) url.searchParams.set("client_id", this.clientId);
		return url.toString();
	}

	private _doConnect(): void {
		const WS = resolveWebSocket(this.WS);
		try {
			this.ws = new WS(this._buildUrl());
		} catch {
			this._scheduleReconnect();
			return;
		}

		this.ws.onopen = () => this._onOpen();
		this.ws.onclose = () => this._onClose();
		this.ws.onerror = () => {};
		this.ws.onmessage = (e: { data: unknown }) => {
			this.onMessage?.(String(e.data));
		};
	}

	private _onOpen(): void {
		this._connected = true;
		this._everConnected = true;
		this.reconnectAttempt = 0;
		this._startPing();
		this._connectResolve?.();
		this.onOpen?.();
	}

	private _everConnected = false;

	private _onClose(): void {
		const wasConnected = this._connected;
		this._connected = false;
		this._cleanup();

		// Auth failure: close before first open when token is set
		if (!wasConnected && !this._everConnected && this.token) {
			this._connectReject?.(new RpcError(ErrorCode.AUTH_FAILED, "auth failed"));
			this.onAuthFailed?.();
			return;
		}

		if (wasConnected) this.onClose?.();
		if (!this.intentionalClose && this.autoReconnect) {
			this._scheduleReconnect();
		} else {
			this._connectReject?.(
				new RpcError(ErrorCode.NOT_CONNECTED, "connection failed"),
			);
		}
	}

	private _startPing(): void {
		this._stopPing();
		this.pingTimer = setInterval(() => {
			if (this.ws?.readyState === WS_OPEN) {
				this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "ping" }));
			}
			this.pongTimer = setTimeout(() => {
				this.ws?.close();
			}, this.pongTimeout);
		}, this.pingInterval);
	}

	private _stopPing(): void {
		if (this.pingTimer) clearInterval(this.pingTimer);
		if (this.pongTimer) clearTimeout(this.pongTimer);
		this.pingTimer = null;
		this.pongTimer = null;
	}

	/** Clear pong timeout (called when pong is received via the router). */
	refreshPong(): void {
		if (this.pongTimer) {
			clearTimeout(this.pongTimer);
			this.pongTimer = null;
		}
	}

	private _scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		this.reconnectAttempt++;
		const delay = Math.min(
			this.initialReconnectDelay * 2 ** this.reconnectAttempt,
			this.maxReconnectDelay,
		);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this._doConnect();
		}, delay);
	}

	private _cleanup(): void {
		this._stopPing();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}
}
