import { RpcClient } from "./client.js";
import type { RpcConnection } from "./connection.js";
import type { EventCallback, RpcHandler } from "./core.js";
import type {
	OnConnectCallback,
	OnDisconnectCallback,
	ServerEventCallback,
	ServerRpcHandler,
} from "./server.js";
import { RpcServer } from "./server.js";
import type { WsClientOptions } from "./ws/client.js";
import { WsClient } from "./ws/client.js";
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

export interface EchoClientOptions extends WsClientOptions {
	/** RPC call timeout in ms (default: 30000). */
	timeout?: number;
}

export class EchoClient {
	readonly ws: WsClient;
	readonly rpc: RpcClient;

	constructor(url: string, opts: EchoClientOptions = {}) {
		const { timeout, ...wsOpts } = opts;
		this.ws = new WsClient(url, wsOpts);
		this.rpc = new RpcClient(this.ws, { timeout });
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	get connected(): boolean {
		return this.rpc.connected;
	}

	get onConnect(): (() => void) | undefined {
		return this.rpc.onConnect;
	}
	set onConnect(cb: (() => void) | undefined) {
		this.rpc.onConnect = cb;
	}

	get onDisconnect(): (() => void) | undefined {
		return this.rpc.onDisconnect;
	}
	set onDisconnect(cb: (() => void) | undefined) {
		this.rpc.onDisconnect = cb;
	}

	get onAuthFailed(): (() => void) | undefined {
		return this.rpc.onAuthFailed;
	}
	set onAuthFailed(cb: (() => void) | undefined) {
		this.rpc.onAuthFailed = cb;
	}

	connect(timeoutMs?: number): Promise<void> {
		return this.rpc.connect(timeoutMs);
	}

	disconnect(): Promise<void> {
		return this.rpc.disconnect();
	}

	// ── RPC methods ──────────────────────────────────────────────────────

	register(method: string, handler: RpcHandler): void {
		this.rpc.register(method, handler);
	}

	unregister(method: string): void {
		this.rpc.unregister(method);
	}

	request<T = unknown>(method: string, params?: unknown): Promise<T> {
		return this.rpc.request<T>(method, params);
	}

	batchRequest<T = unknown>(
		calls: Array<[method: string, params?: unknown]>,
	): Promise<T[]> {
		return this.rpc.batchRequest<T>(calls);
	}

	// ── Pub/Sub ──────────────────────────────────────────────────────────

	publish(method: string, params?: unknown): void {
		this.rpc.publish(method, params);
	}

	subscribe(method: string, callback: EventCallback): void {
		this.rpc.subscribe(method, callback);
	}

	unsubscribe(method: string, callback: EventCallback): void {
		this.rpc.unsubscribe(method, callback);
	}
}
