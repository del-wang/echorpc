// Core

export { RpcClient } from "./client.js";
// RPC layer
export { RpcConnection } from "./connection.js";
export {
	type ClientOptions,
	ErrorCode,
	type EventCallback,
	type IWebSocket,
	RpcError,
	type RpcHandler,
	type RpcId,
	type RpcNotification,
	type RpcRequest,
	type RpcResponse,
	resolveWebSocket,
	type WebSocketConstructor,
} from "./core.js";
// Router
export { MessageRouter } from "./router.js";
export {
	type AuthHandler,
	type OnConnectCallback,
	type OnDisconnectCallback,
	RpcServer,
	type ServerEventCallback,
	type ServerOptions,
	type ServerRpcHandler,
} from "./server.js";
// Transport interfaces
export type {
	ITransportClient,
	ITransportConnection,
	ITransportServer,
} from "./transport.js";
export { WsClient, type WsClientOptions } from "./ws/client.js";
// WebSocket transport
export { WsConnection } from "./ws/connection.js";
export { WsServer, type WsServerOptions } from "./ws/server.js";
