import { afterEach, expect, mock, test } from "bun:test";

// See api.test.ts: the env mock must load before `./api`.
mock.module("@/env", () => ({
	ENV: { VITE_SERVER_URL: "http://server.test" },
}));
const { flushPending, submitAction } = await import("./pending");
const { setSessionToken } = await import("./session");

class MemoryStorage implements Storage {
	#items = new Map<string, string>();
	get length() {
		return this.#items.size;
	}
	clear() {
		this.#items.clear();
	}
	getItem(key: string) {
		return this.#items.get(key) ?? null;
	}
	key(index: number) {
		return [...this.#items.keys()][index] ?? null;
	}
	removeItem(key: string) {
		this.#items.delete(key);
	}
	setItem(key: string, value: string) {
		this.#items.set(key, value);
	}
}
globalThis.sessionStorage = new MemoryStorage();
globalThis.localStorage = new MemoryStorage();

const token = (sub: string) =>
	`h.${Buffer.from(JSON.stringify({ iss: "https://id.test", sub, exp: 4e9 })).toString("base64url")}.s`;

const realFetch = globalThis.fetch;
/** Every POST body sent; `status` null means the network is down. */
const serve = (status: number | null) => {
	const sent: unknown[] = [];
	globalThis.fetch = Object.assign(
		async (_url: string | URL | Request, init?: RequestInit) => {
			if (status === null) throw new TypeError("Failed to fetch");
			sent.push(JSON.parse(String(init?.body)));
			return new Response(
				status < 300
					? null
					: JSON.stringify({ error: "invalid_request", message: "refused" }),
				{ status },
			);
		},
		{ preconnect: realFetch.preconnect },
	);
	return sent;
};

afterEach(() => {
	globalThis.fetch = realFetch;
	localStorage.clear();
});

test("an action saved offline is sent once, with its first clientId, after reconnect", async () => {
	setSessionToken(token("alice"));
	serve(null);
	const path = "/api/families/1/messages";
	expect(await submitAction(path, { body: "On my way" })).toEqual({
		kind: "waiting",
	});
	// A second tap while offline reuses the saved action.
	expect(await submitAction(path, { body: "On my way" })).toEqual({
		kind: "waiting",
	});
	expect(
		JSON.parse(localStorage.getItem("telly.pending") ?? "[]"),
	).toHaveLength(1);
	const [saved] = JSON.parse(localStorage.getItem("telly.pending") ?? "[]");

	// A restart reloads the queue from storage; reconnecting sends it.
	const sent = serve(201);
	const outcomes = await flushPending();
	expect(outcomes.get(saved.clientId)).toEqual({ kind: "sent" });
	expect(sent).toEqual([{ body: "On my way", clientId: saved.clientId }]);
	expect(localStorage.getItem("telly.pending")).toBeNull();
});

test("only the person who saved an action sends it, and a refused action is not resent", async () => {
	setSessionToken(token("alice"));
	serve(null);
	await submitAction("/api/families/1/messages", { body: "hi" });

	setSessionToken(token("bob"));
	expect(serve(201)).toEqual([]);
	await flushPending();
	expect(localStorage.getItem("telly.pending")).not.toBeNull();

	setSessionToken(token("alice"));
	const refused = serve(400);
	const [outcome] = (await flushPending()).values();
	expect(outcome).toEqual({ kind: "rejected", message: "refused" });
	expect(refused).toHaveLength(1);
	expect(localStorage.getItem("telly.pending")).toBeNull();
});
