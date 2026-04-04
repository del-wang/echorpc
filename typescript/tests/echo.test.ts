/**
 * Integration tests for EchoServer / EchoClient convenience classes.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EchoClient, EchoServer, ErrorCode, RpcError } from "../src/index.js";

const WS = WebSocket;

function createClient(port: number, role = "web"): EchoClient {
	return new EchoClient(`ws://127.0.0.1:${port}`, {
		token: "test-token",
		role,
		autoReconnect: false,
		pingInterval: 300_000,
		WebSocket: WS,
	});
}

// ── Basic RPC ──────────────────────────────────────────────────────────

describe("EchoServer/Client: Basic RPC", () => {
	let server: EchoServer;
	let serverPort: number;
	let client: EchoClient;

	beforeAll(async () => {
		server = new EchoServer({ port: 0 });
		server.register("echo", (params, conn) => params);
		server.register("add", (params: { a: number; b: number }, conn) => ({
			sum: params.a + params.b,
		}));
		await server.start();
		serverPort = server.address!.port;
	});

	afterAll(async () => {
		await server.stop();
	});
	afterEach(async () => {
		await client?.disconnect();
	});

	it("should connect and authenticate", async () => {
		client = createClient(serverPort);
		await client.connect();
		expect(client.connected).toBe(true);
	});

	it("should request echo", async () => {
		client = createClient(serverPort);
		await client.connect();
		const result = await client.request("echo", { msg: "hello" });
		expect(result).toEqual({ msg: "hello" });
	});

	it("should request add", async () => {
		client = createClient(serverPort);
		await client.connect();
		const result = await client.request("add", { a: 10, b: 20 });
		expect(result).toEqual({ sum: 30 });
	});

	it("should throw method not found", async () => {
		client = createClient(serverPort);
		await client.connect();
		await expect(client.request("nonexistent")).rejects.toThrow(RpcError);
		try {
			await client.request("nonexistent");
		} catch (e) {
			expect((e as RpcError).code).toBe(ErrorCode.METHOD_NOT_FOUND);
		}
	});
});

// ── Pub/Sub ────────────────────────────────────────────────────────────

describe("EchoServer/Client: Pub/Sub", () => {
	let server: EchoServer;
	let serverPort: number;

	beforeAll(async () => {
		server = new EchoServer({ port: 0 });
		server.subscribe("chat", (data, conn) => {
			server.broadcast("chat", data);
		});
		await server.start();
		serverPort = server.address!.port;
	});

	afterAll(async () => {
		await server.stop();
	});

	it("should broadcast notifications", async () => {
		const client1 = createClient(serverPort);
		const client2 = createClient(serverPort);
		await client1.connect();
		await client2.connect();

		const received = new Promise<unknown>((resolve) => {
			client2.subscribe("chat", (data) => resolve(data));
		});

		client1.publish("chat", { text: "hi" });
		const result = await received;
		expect(result).toEqual({ text: "hi" });

		await client1.disconnect();
		await client2.disconnect();
	});
});

// ── Batch Requests ─────────────────────────────────────────────────────

describe("EchoServer/Client: Batch Requests", () => {
	let server: EchoServer;
	let serverPort: number;
	let client: EchoClient;

	beforeAll(async () => {
		server = new EchoServer({ port: 0 });
		server.register("add", (params: { a: number; b: number }, conn) => ({
			sum: params.a + params.b,
		}));
		await server.start();
		serverPort = server.address!.port;
	});

	afterAll(async () => {
		await server.stop();
	});
	afterEach(async () => {
		await client?.disconnect();
	});

	it("should handle batch requests", async () => {
		client = createClient(serverPort);
		await client.connect();
		const results = await client.batchRequest([
			["add", { a: 1, b: 2 }],
			["add", { a: 3, b: 4 }],
		]);
		expect(results).toEqual([{ sum: 3 }, { sum: 7 }]);
	});
});

// ── Connection Management ──────────────────────────────────────────────

describe("EchoServer/Client: Connection Management", () => {
	let server: EchoServer;
	let serverPort: number;

	beforeAll(async () => {
		server = new EchoServer({ port: 0 });
		await server.start();
		serverPort = server.address!.port;
	});

	afterAll(async () => {
		await server.stop();
	});

	it("should fire onConnect/onDisconnect", async () => {
		const connected = new Promise<boolean>((resolve) => {
			server.onConnect(() => resolve(true));
		});

		const client = createClient(serverPort);
		await client.connect();
		expect(await connected).toBe(true);

		const disconnected = new Promise<boolean>((resolve) => {
			server.onDisconnect(() => resolve(true));
		});
		await client.disconnect();
		expect(await disconnected).toBe(true);
	});

	it("should filter connections by role", async () => {
		const c1 = createClient(serverPort, "admin");
		const c2 = createClient(serverPort, "web");
		await c1.connect();
		await c2.connect();
		await new Promise((r) => setTimeout(r, 100));

		expect(server.getConnections().length).toBe(2);
		expect(server.getConnections("admin").length).toBe(1);
		expect(server.getConnections("web").length).toBe(1);

		await c1.disconnect();
		await c2.disconnect();
	});
});

// ── Underlying access ──────────────────────────────────────────────────

describe("EchoServer/Client: Underlying access", () => {
	it("should expose ws and rpc", () => {
		const server = new EchoServer({ port: 0 });
		expect(server.ws).toBeDefined();
		expect(server.rpc).toBeDefined();

		const client = new EchoClient("ws://localhost:9999", {
			WebSocket: WS,
		});
		expect(client.ws).toBeDefined();
		expect(client.rpc).toBeDefined();
	});
});
