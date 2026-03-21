/**
 * RpcClient — composes a MessageRouter with an ITransportClient.
 * Provides the user-facing API for connecting to an RPC server.
 */

import type { RpcHandler, EventCallback } from "./core.js";
import { RpcError, ErrorCode } from "./core.js";
import { MessageRouter } from "./router.js";
import type { ITransportClient } from "./transport.js";

export class RpcClient {
  readonly router: MessageRouter;
  readonly transport: ITransportClient;

  onConnect?: () => void;
  onDisconnect?: () => void;
  onAuthFailed?: () => void;

  private _handlers = new Map<string, RpcHandler>();
  private _subscribers = new Map<string, Set<EventCallback>>();

  constructor(transport: ITransportClient, opts?: { timeout?: number }) {
    this.transport = transport;
    this.router = new MessageRouter(
      (raw) => this.transport.send(raw),
      opts?.timeout ?? 30_000,
    );

    // Wire transport events
    this.transport.onMessage = (raw) => this.router.dispatchMessage(raw);

    this.transport.onOpen = () => {
      // Reset router closed state on reconnect (handlers/subscribers persist)
      this.router.reopen();
      this.onConnect?.();
    };

    this.transport.onClose = () => {
      this.onDisconnect?.();
    };

    this.transport.onAuthFailed = () => {
      this.onAuthFailed?.();
    };
  }

  get connected(): boolean {
    return this.transport.connected;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  connect(timeoutMs?: number): Promise<void> {
    return this.transport.connect(timeoutMs);
  }

  disconnect(): Promise<void> {
    this.router.close();
    return this.transport.disconnect();
  }

  // ── RPC methods (delegate to router) ────────────────────────────────

  register(method: string, handler: RpcHandler): void {
    this._handlers.set(method, handler);
    this.router.register(method, handler);
  }

  unregister(method: string): void {
    this._handlers.delete(method);
    this.router.unregister(method);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.connected) {
      return Promise.reject(
        new RpcError(ErrorCode.NOT_CONNECTED, "not connected"),
      );
    }
    return this.router.request<T>(method, params);
  }

  batchRequest<T = unknown>(
    calls: Array<[method: string, params?: unknown]>,
  ): Promise<T[]> {
    if (!this.connected) {
      return Promise.reject(
        new RpcError(ErrorCode.NOT_CONNECTED, "not connected"),
      );
    }
    return this.router.batchRequest<T>(calls);
  }

  // ── Pub/Sub (delegate to router) ────────────────────────────────────

  publish(method: string, params?: unknown): void {
    if (!this.connected) {
      throw new RpcError(ErrorCode.NOT_CONNECTED, "not connected");
    }
    this.router.publish(method, params);
  }

  subscribe(method: string, callback: EventCallback): void {
    if (!this._subscribers.has(method))
      this._subscribers.set(method, new Set());
    this._subscribers.get(method)!.add(callback);
    this.router.subscribe(method, callback);
  }

  unsubscribe(method: string, callback: EventCallback): void {
    this._subscribers.get(method)?.delete(callback);
    this.router.unsubscribe(method, callback);
  }
}
