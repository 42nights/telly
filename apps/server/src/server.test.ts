// Runs the server's layer in-process: the HTTP listener, the alert outbox (unconfigured here), and
// the iMessage agent with the Spectrum Cloud client replaced by an in-memory webhook stand-in.
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import type { Message, Space } from "@spectrum-ts/core";
import { Effect, Exit, Layer } from "effect";
import { serverConfig } from "./config";
import { unavailableReply } from "./imessage/agent";

const base = {
	CORS_ORIGIN: "http://localhost:3001",
	ELEVENLABS_VOICE_ID: "voice",
	ELEVENLABS_API_URL: "http://127.0.0.1:1",
	GEMINI_BASE_URL: "http://127.0.0.1:1",
	REPORT_EMAIL_FROM: "Telly <reports@example.com>",
};

// @hono/node-server swaps in its own global Request and Response when it serves; Bun runs every
// test file in one process, so put the runtime's back for the other files.
const { Request, Response } = globalThis;
afterEach(() => {
	Object.defineProperty(globalThis, "Request", { value: Request });
	Object.defineProperty(globalThis, "Response", { value: Response });
});

const freePort = async () => {
	const probe = createServer().listen(0, "127.0.0.1");
	await once(probe, "listening");
	const { port } = probe.address() as AddressInfo;
	probe.close();
	await once(probe, "close");
	return port;
};

// Spectrum Cloud stand-in: the webhook body is `{ text, sender }`; tests read the replies the agent sends.
const cloud = {
	replies: [] as string[],
	stopped: 0,
	replied: Promise.withResolvers<void>(),
};
const space = {
	send: async (text: string) => {
		cloud.replies.push(text);
		cloud.replied.resolve();
	},
} as unknown as Space;
mock.module("@spectrum-ts/imessage", () => ({
	imessage: { config: () => ({ name: "imessage" }) },
}));
mock.module("@spectrum-ts/core", () => ({
	Spectrum: async () => ({
		webhook: async (
			request: Request,
			handle: (space: Space, message: Message) => Promise<void>,
		) => {
			const { text, sender } = (await request.json()) as {
				text: string;
				sender: string;
			};
			void handle(space, {
				id: crypto.randomUUID(),
				direction: "inbound",
				sender: { id: sender },
				content: { type: "text", text },
			} as unknown as Message);
			return new Response(null, { status: 202 });
		},
		stop: async () => {
			cloud.stopped += 1;
		},
	}),
}));
// Imported after the mocks so the iMessage client never loads the real Spectrum Cloud provider.
const { serverLayer } = await import("./server");

const health = (port: number) =>
	fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());

describe("the server process", () => {
	test("serves on the configured host and port, and frees the port on shutdown", async () => {
		const port = await freePort();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* Layer.build(
						serverLayer(serverConfig(base), { HOST: "127.0.0.1", PORT: port }),
					);
					expect(yield* Effect.promise(() => health(port))).toEqual({
						status: "ok",
						service: "server",
					});
				}),
			),
		);
		await expect(health(port)).rejects.toThrow();
		// Freed: another listener can take the port at once.
		const next = createServer().listen(port, "127.0.0.1");
		await once(next, "listening");
		next.close();
	});

	test("fails startup, instead of hanging, when the port is taken", async () => {
		const taken = createServer().listen(0, "127.0.0.1");
		await once(taken, "listening");
		const { port } = taken.address() as AddressInfo;
		try {
			const exit = await Effect.runPromiseExit(
				Effect.scoped(
					Layer.build(
						serverLayer(serverConfig(base), { HOST: "127.0.0.1", PORT: port }),
					),
				),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			// Node says EADDRINUSE, Bun says "Is port N in use?"; both name the port.
			expect(String(exit)).toContain(String(port));
		} finally {
			taken.close();
		}
	});

	test("with NOOP ingest configured, an unreachable database fails startup before it listens", async () => {
		const port = await freePort();
		const exit = await Effect.runPromiseExit(
			Effect.scoped(
				Layer.build(
					serverLayer(
						serverConfig({
							...base,
							SPACETIMEDB_URI: "ws://127.0.0.1:1",
							SPACETIMEDB_DATABASE: "health",
							NOOP_INGEST_KEY: "relay-key",
							NOOP_FAMILY_ID: "9",
							NOOP_SPACETIMEDB_TOKEN: "noop-token",
						}),
						{ HOST: "127.0.0.1", PORT: port },
					),
				),
			),
		);
		expect(String(exit)).toContain("DbUnavailable");
		await expect(health(port)).rejects.toThrow();
	});

	test("answers allowlisted iMessage senders and closes the iMessage client on shutdown", async () => {
		const port = await freePort();
		const config = serverConfig({
			...base,
			SPECTRUM_PROJECT_ID: "project",
			SPECTRUM_PROJECT_SECRET: "secret",
			SPECTRUM_WEBHOOK_SECRET: "hook",
			TELLY_IMESSAGE_SENDERS: "+15550001111=7",
		});
		const inbound = (text: string, sender = "+15550001111") =>
			fetch(`http://127.0.0.1:${port}/api/imessage/webhook`, {
				method: "POST",
				body: JSON.stringify({ text, sender }),
			});
		const errors = spyOn(console, "error").mockImplementation(() => {});
		const nextReply = async () => {
			await cloud.replied.promise;
			cloud.replied = Promise.withResolvers<void>();
			return cloud.replies.at(-1);
		};
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* Layer.build(
							serverLayer(config, { HOST: "127.0.0.1", PORT: port }),
						);
						// Urgent help never waits on a model or a missing configuration.
						const accepted = yield* Effect.promise(() =>
							inbound("I've fallen"),
						);
						expect(accepted.status).toBe(202);
						expect(yield* Effect.promise(nextReply)).toBe(
							"This sounds urgent. Call your emergency number or a family member now.",
						);
						// Without the fetch bridge, a normal question gets the fallback reply, not silence.
						yield* Effect.promise(() => inbound("How did Mom sleep?"));
						expect(yield* Effect.promise(nextReply)).toBe(unavailableReply);
						expect(cloud.stopped).toBe(0);
					}),
				),
			);
			expect(cloud.stopped).toBe(1);
		} finally {
			errors.mockRestore();
		}
	});
});
