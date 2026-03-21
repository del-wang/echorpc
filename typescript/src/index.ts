// Core
export {
  RpcError,
  ErrorCode,
  resolveWebSocket,
  type ClientOptions,
  type RpcHandler,
  type EventCallback,
  type IWebSocket,
  type WebSocketConstructor,
  type RpcId,
  type RpcRequest,
  type RpcResponse,
  type RpcNotification,
} from "./core.js";

// Router
export { MessageRouter } from "./router.js";

// Transport interfaces
export type {
  ITransportConnection,
  ITransportClient,
  ITransportServer,
} from "./transport.js";

// RPC layer
export { RpcConnection } from "./connection.js";
export { RpcClient } from "./client.js";
export {
  RpcServer,
  type ServerOptions,
  type AuthHandler,
  type ServerRpcHandler,
  type ServerEventCallback,
  type OnConnectCallback,
  type OnDisconnectCallback,
} from "./server.js";

// WebSocket transport
export { WsConnection } from "./ws/connection.js";
export { WsClient, type WsClientOptions } from "./ws/client.js";
export { WsServer, type WsServerOptions } from "./ws/server.js";