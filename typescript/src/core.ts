/**
 * JSON-RPC 2.0 core types and utilities.
 * Universal — works in Node.js and browsers.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type RpcId = string | number;

export interface RpcRequest {
	jsonrpc: "2.0";
	id: RpcId;
	method: string;
	params?: unknown;
}

export interface RpcResponse {
	jsonrpc: "2.0";
	id: RpcId;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface RpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

// ── Error codes ─────────────────────────────────────────────────────────────

export enum ErrorCode {
	// Standard JSON-RPC 2.0 error codes
	PARSE_ERROR = -32700,
	INVALID_REQUEST = -32600,
	METHOD_NOT_FOUND = -32601,
	INVALID_PARAMS = -32602,
	INTERNAL_ERROR = -32603,
	// Implementation-defined server errors (-32000 to -32099)
	NOT_CONNECTED = -32001,
	TIMEOUT = -32002,
	AUTH_FAILED = -32003,
}

export class RpcError extends Error {
	constructor(
		public code: number,
		message: string,
		public data?: unknown,
	) {
		super(message);
		this.name = "RpcError";
	}
}

// ── WebSocket abstraction ───────────────────────────────────────────────────

/** Minimal WebSocket interface that both native WebSocket and `ws` satisfy. */
export interface IWebSocket {
	readonly readyState: number;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	onopen: ((ev: any) => void) | null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	onclose: ((ev: any) => void) | null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	onerror: ((ev: any) => void) | null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	onmessage: ((ev: any) => void) | null;
	send(data: string): void;
	close(): void;
}

/**
 * Constructor signature for WebSocket implementations.
 * Both `ws` and native `WebSocket` satisfy this.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WebSocketConstructor = new (
	url: string,
	...args: any[]
) => IWebSocket;

// ── Default constants (ms, aligned with Python) ────────────────────────────

export const DEFAULT_CONNECT_TIMEOUT = 10_000;
export const DEFAULT_REQUEST_TIMEOUT = 30_000;
export const DEFAULT_PING_INTERVAL = 30_000;
export const DEFAULT_PONG_TIMEOUT = 5_000;
export const INITIAL_RECONNECT_DELAY = 1_000;
export const DEFAULT_MAX_RECONNECT_DELAY = 5_000;

// ── Options ─────────────────────────────────────────────────────────────────

export interface ClientOptions {
	/** Auth token sent as URL query param during WebSocket upgrade */
	token?: string;
	/** Client role sent as URL query param (default: "web") */
	role?: string;
	/** Arbitrary client ID */
	clientId?: string;
	/** RPC call timeout in ms (default: 30000) */
	timeout?: number;
	/** Heartbeat interval in ms (default: 30000) */
	pingInterval?: number;
	/** Max reconnect delay in ms (default: 5000) */
	maxReconnectDelay?: number;
	/** Initial reconnect delay in ms (default: 1000) */
	initialReconnectDelay?: number;
	/** Pong timeout in ms (default: 5000) */
	pongTimeout?: number;
	/** Enable auto-reconnect (default: true) */
	autoReconnect?: boolean;
	/**
	 * WebSocket constructor to use.
	 * - Browser: omit (uses native `WebSocket`)
	 * - Node.js: pass `WebSocket` from the `ws` package
	 */
	WebSocket?: WebSocketConstructor;
}

// ── Handler types ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RpcHandler<T = any> = (params: T) => any | Promise<any>;
export type EventCallback<T = unknown> = (data: T) => void;

// ── Helpers ─────────────────────────────────────────────────────────────────

let idCounter = 0;
export function nextId(): string {
	return `${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
}

/** Resolve the WebSocket constructor: explicit option > globalThis > throw. */
export function resolveWebSocket(
	explicit?: WebSocketConstructor,
): WebSocketConstructor {
	if (explicit) return explicit;
	if (
		typeof globalThis !== "undefined" &&
		(globalThis as Record<string, unknown>).WebSocket
	) {
		return (globalThis as Record<string, unknown>)
			.WebSocket as WebSocketConstructor;
	}
	throw new Error(
		"No WebSocket implementation found. " +
			"In Node.js, pass the `ws` package: new RpcClient(url, { WebSocket: require('ws') })",
	);
}
