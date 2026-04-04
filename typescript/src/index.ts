// Bundled convenience classes

// Core
export { RpcClient } from "./client.js";
// RPC layer
export { RpcConnection } from "./connection.js";
export {
	ErrorCode,
	resolveWebSocket,
	RpcError,
	type ClientOptions,
	type EventCallback,
	type IWebSocket,
	type RpcHandler,
	type RpcId,
	type RpcNotification,
	type RpcRequest,
	type RpcResponse,
	type WebSocketConstructor,
} from "./core.js";
export { EchoClient, type EchoClientOptions } from "./echo-client.js";
export { EchoServer, type EchoServerOptions } from "./echo-server.js";
// Router
export { MessageRouter } from "./router.js";
export {
	RpcServer,
	type AuthHandler,
	type OnConnectCallback,
	type OnDisconnectCallback,
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
