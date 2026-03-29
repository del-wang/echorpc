/**
 * RpcConnection — composes a MessageRouter with an ITransportConnection.
 * Used on the server side (one per connected peer) and as a standalone
 * bidirectional RPC channel.
 */

import type { EventCallback, RpcHandler } from "./core.js";
import { MessageRouter } from "./router.js";
import type { ITransportConnection } from "./transport.js";

export class RpcConnection {
	readonly router: MessageRouter;
	readonly transport: ITransportConnection;

	/** Arbitrary metadata (role, client_id, token, authenticated, etc.) */
	meta: Record<string, unknown> = {};

	constructor(transport: ITransportConnection, opts?: { timeout?: number }) {
		this.transport = transport;
		this.router = new MessageRouter(
			(raw) => this.transport.send(raw),
			opts?.timeout ?? 30_000,
		);

		// Wire pong callback to transport
		this.router.onPong = () => {
			if ("refreshPong" in this.transport) {
				(this.transport as { refreshPong(): void }).refreshPong();
			}
		};
	}

	get isOpen(): boolean {
		return this.transport.isOpen;
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	/**
	 * Start the message loop. Resolves when the connection closes.
	 * Used on the server side to await connection lifetime.
	 */
	serve(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.transport.onMessage = (raw) => this.router.dispatchMessage(raw);
			this.transport.onClose = () => {
				this.router.close();
				resolve();
			};

			// If the transport has a serve() method (e.g. WsConnection), call it
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const t = this.transport as any;
			if (typeof t.serve === "function") {
				t.serve().then(() => {
					this.router.close();
					resolve();
				});
			}
		});
	}

	close(): void {
		this.router.close();
		this.transport.close();
	}

	// ── RPC methods (delegate to router) ────────────────────────────────

	register(method: string, handler: RpcHandler): void {
		this.router.register(method, handler);
	}

	unregister(method: string): void {
		this.router.unregister(method);
	}

	request<T = unknown>(
		method: string,
		params?: unknown,
		timeoutMs?: number,
	): Promise<T> {
		return this.router.request<T>(method, params, timeoutMs);
	}

	batchRequest<T = unknown>(
		calls: Array<[method: string, params?: unknown]>,
		timeoutMs?: number,
	): Promise<T[]> {
		return this.router.batchRequest<T>(calls, timeoutMs);
	}

	// ── Pub/Sub (delegate to router) ────────────────────────────────────

	publish(method: string, params?: unknown): void {
		this.router.publish(method, params);
	}

	subscribe(method: string, callback: EventCallback): void {
		this.router.subscribe(method, callback);
	}

	unsubscribe(method: string, callback: EventCallback): void {
		this.router.unsubscribe(method, callback);
	}
}
