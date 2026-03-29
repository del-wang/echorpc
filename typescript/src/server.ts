/**
 * RpcServer — composes an ITransportServer with per-connection MessageRouters.
 * Manages connection lifecycle, global handler/subscriber registration,
 * and broadcasting.
 */

import { RpcConnection } from "./connection.js";
import { DEFAULT_REQUEST_TIMEOUT } from "./core.js";
import type { ITransportServer } from "./transport.js";

// ── Types ──────────────────────────────────────────────────────────────

/** Server-side RPC handler — receives the calling connection as first arg. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServerRpcHandler<T = any> = (
	conn: RpcConnection,
	params: T,
) => any | Promise<any>;

/** Server-side notification callback — receives the publishing connection as first arg. */
export type ServerEventCallback<T = unknown> = (
	conn: RpcConnection,
	data: T,
) => void | Promise<void>;

export type AuthHandler = (
	params: Record<string, unknown>,
) => unknown | Promise<unknown>;
export type OnConnectCallback = (conn: RpcConnection) => void | Promise<void>;
export type OnDisconnectCallback = (
	conn: RpcConnection,
) => void | Promise<void>;

export interface ServerOptions {
	/** RPC call timeout in ms (default: 30000). */
	timeout?: number;
}

// ── Server ─────────────────────────────────────────────────────────────

export class RpcServer {
	readonly transport: ITransportServer;

	private _timeout: number;
	private _connections = new Set<RpcConnection>();
	private _globalHandlers = new Map<string, ServerRpcHandler>();
	private _globalSubscribers = new Map<string, ServerEventCallback[]>();
	private _onConnectCbs: OnConnectCallback[] = [];
	private _onDisconnectCbs: OnDisconnectCallback[] = [];

	constructor(transport: ITransportServer, opts: ServerOptions = {}) {
		this.transport = transport;
		this._timeout = opts.timeout ?? DEFAULT_REQUEST_TIMEOUT;

		// Wire transport connection event
		this.transport.onConnection = (conn, meta) => {
			this._handleConnection(conn, meta);
		};
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	async start(): Promise<void> {
		await this.transport.start();
	}

	async stop(): Promise<void> {
		for (const conn of this._connections) {
			conn.close();
		}
		await this.transport.stop();
	}

	async serveForever(): Promise<void> {
		await this.start();
		await new Promise<void>(() => {});
	}

	get address(): { host: string; port: number } | null {
		return this.transport.address;
	}

	// ── RPC Registration ─────────────────────────────────────────────────

	register(method: string, handler: ServerRpcHandler): void {
		this._globalHandlers.set(method, handler);
	}

	unregister(method: string): void {
		this._globalHandlers.delete(method);
	}

	// ── Pub/Sub Registration ─────────────────────────────────────────────

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

	broadcast(method: string, params?: unknown, role?: string): void {
		const targets =
			role !== undefined ? this.getConnections(role) : [...this._connections];
		for (const conn of targets) {
			if (conn.isOpen) conn.publish(method, params);
		}
	}

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
		transportConn: import("./transport.js").ITransportConnection,
		meta: Record<string, unknown>,
	): Promise<void> {
		const conn = new RpcConnection(transportConn, {
			timeout: this._timeout,
		});
		conn.meta = { ...meta };

		// Register global handlers — wrap to inject conn as 1st arg
		for (const [method, handler] of this._globalHandlers) {
			conn.register(method, (params) => handler(conn, params));
		}

		// Register global subscribers — wrap to inject conn as 1st arg
		for (const [method, callbacks] of this._globalSubscribers) {
			for (const cb of callbacks) {
				conn.subscribe(method, (data) => cb(conn, data));
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
