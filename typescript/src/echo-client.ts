/**
 * EchoClient — convenience class bundling WsClient + RpcClient.
 */

import { RpcClient } from "./client.js";
import type { EventCallback, RpcHandler } from "./core.js";
import type { WsClientOptions } from "./ws/client.js";
import { WsClient } from "./ws/client.js";

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
