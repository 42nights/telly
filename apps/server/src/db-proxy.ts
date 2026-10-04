// Test-only TCP proxy in front of a local SpacetimeDB, for real network failures in tests. The mode
// applies to each new socket when it opens:
// - "freeze": requests reach the database, but no reply comes back, like a hung host.
// - "refuse": the socket closes at once, like a database that is down.
// - "drop-call": a WebSocket closes when the client sends its first reducer call, before the call
//   reaches the database. Client frames arrive in a fixed order: the upgrade request, the
//   subscription, then calls. Empty control frames (6 bytes: header and mask) do not count.
// `drop()` destroys every open socket; the client sees a dropped connection.
import { connect, createServer, type Socket } from "node:net";

export const dbProxy = async (target: string) => {
	const { hostname, port } = new URL(target);
	const sockets = new Set<Socket>();
	let mode: "pass" | "freeze" | "refuse" | "drop-call" = "pass";
	let accepted = Promise.withResolvers<Socket>();
	const server = createServer((client) => {
		if (mode === "refuse") return client.destroy();
		const socketMode = mode;
		sockets.add(client);
		accepted.resolve(client);
		const upstream = connect(Number(port), hostname);
		const closeBoth = () => {
			sockets.delete(client);
			client.destroy();
			upstream.destroy();
		};
		for (const socket of [client, upstream]) {
			socket.on("error", closeBoth);
			socket.on("close", closeBoth);
		}
		let frames = 0;
		let upgrade = false;
		client.on("data", (chunk: Buffer) => {
			if (frames === 0) upgrade = chunk.toString("latin1").startsWith("GET ");
			if (chunk.length > 6) frames++;
			if (socketMode === "drop-call" && upgrade && frames === 3)
				return closeBoth();
			upstream.write(chunk);
		});
		if (socketMode !== "freeze")
			upstream.on("data", (chunk: Buffer) => client.write(chunk));
	});
	const { promise: listening, resolve } = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", resolve);
	await listening;
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("proxy has no TCP address");
	return {
		uri: `ws://127.0.0.1:${address.port}`,
		setMode: (next: typeof mode) => {
			mode = next;
		},
		/** Resolves with the client side of the next socket the proxy accepts. */
		nextSocket: () => {
			accepted = Promise.withResolvers<Socket>();
			return accepted.promise;
		},
		drop: () => {
			for (const socket of sockets) socket.destroy();
		},
		close: () => {
			for (const socket of sockets) socket.destroy();
			server.close();
		},
	};
};

/** Resolves when the socket closes; `events.once` would reject on the client's reset instead. */
export const closed = (socket: Socket) => {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (socket.destroyed) resolve();
	else socket.on("close", () => resolve());
	return promise;
};
