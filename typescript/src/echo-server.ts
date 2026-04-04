/**
 * EchoServer — convenience class bundling WsServer + RpcServer.
 */

import type { RpcConnection } from "./connection.js";
import type {
	OnConnectCallback,
	OnDisconnectCallback,
	ServerEventCallback,
	ServerRpcHandler,
} from "./server.js";
import { RpcServer } from "./server.js";
import type { WsServerOptions } from "./ws/server.js";
import { WsServer } from "./ws/server.js";

export interface EchoServerOptions extends WsServerOptions {
	/** RPC call timeout in ms (default: 30000). */
	timeout?: number;
}

export class EchoServer {
	readonly ws: WsServer;
	readonly rpc: RpcServer;

	constructor(opts: EchoServerOptions = {}) {
		const { timeout, ...wsOpts } = opts;
		this.ws = new WsServer(wsOpts);
		this.rpc = new RpcServer(this.ws, { timeout });
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	start(): Promise<void> {
		return this.rpc.start();
	}

	stop(): Promise<void> {
		return this.rpc.stop();
	}

	serveForever(): Promise<void> {
		return this.rpc.serveForever();
	}

	get address(): { host: string; port: number } | null {
		return this.rpc.address;
	}

	// ── RPC Registration ─────────────────────────────────────────────────

	register(method: string, handler: ServerRpcHandler): void {
		this.rpc.register(method, handler);
	}

	unregister(method: string): void {
		this.rpc.unregister(method);
	}

	// ── Pub/Sub Registration ─────────────────────────────────────────────

	subscribe(method: string, callback: ServerEventCallback): void {
		this.rpc.subscribe(method, callback);
	}

	unsubscribe(method: string, callback: ServerEventCallback): void {
		this.rpc.unsubscribe(method, callback);
	}

	// ── Lifecycle hooks ──────────────────────────────────────────────────

	onConnect(cb: OnConnectCallback): void {
		this.rpc.onConnect(cb);
	}

	onDisconnect(cb: OnDisconnectCallback): void {
		this.rpc.onDisconnect(cb);
	}

	// ── Connection access ────────────────────────────────────────────────

	getConnections(role?: string): RpcConnection[] {
		return this.rpc.getConnections(role);
	}

	// ── Broadcast ────────────────────────────────────────────────────────

	broadcast(method: string, params?: unknown, role?: string): void {
		this.rpc.broadcast(method, params, role);
	}

	broadcastExcept(
		method: string,
		params?: unknown,
		exclude?: RpcConnection,
	): void {
		this.rpc.broadcastExcept(method, params, exclude);
	}
}
