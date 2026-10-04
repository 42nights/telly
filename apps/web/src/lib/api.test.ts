import { afterEach, describe, expect, mock, test } from "bun:test";
import { Health } from "@health/contracts";

// The generated env module needs varlock at runtime; tests only need the server URL. The mock must
// be in place before `./api` loads `@/env`, so these two imports cannot be static.
mock.module("@/env", () => ({
	ENV: { VITE_SERVER_URL: "http://server.test" },
}));
const { apiRequest, failureFor } = await import("./api");
const { setSessionToken } = await import("./session");

// Bun has no sessionStorage; the session module reads it lazily, so a small in-memory one works.
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

const realFetch = globalThis.fetch;
const reply = (status: number, body: unknown) => {
	globalThis.fetch = Object.assign(
		async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		{ preconnect: realFetch.preconnect },
	);
};

afterEach(() => {
	globalThis.fetch = realFetch;
	setSessionToken(null);
});

describe("failureFor", () => {
	test("keeps the meaning of each status, with the server's message", () => {
		const body = { error: "unavailable", message: "Gemini is not configured" };
		expect(failureFor(401, body)).toEqual({ kind: "signed_out" });
		expect(failureFor(403, { error: "forbidden", message: "no" })).toEqual({
			kind: "forbidden",
			message: "no",
		});
		expect(failureFor(503, body)).toEqual({
			kind: "unavailable",
			message: "Gemini is not configured",
		});
		expect(failureFor(500, "not json").kind).toBe("error");
	});
});

describe("apiRequest", () => {
	test("does not call the server without a session", async () => {
		let called = false;
		globalThis.fetch = Object.assign(
			async () => {
				called = true;
				return new Response("{}");
			},
			{ preconnect: realFetch.preconnect },
		);
		expect(await apiRequest(Health, "/health")).toEqual({ kind: "signed_out" });
		expect(called).toBe(false);
	});

	test("a reply that breaks the contract is an error, never data", async () => {
		setSessionToken("token");
		reply(200, { status: "fine" });
		const result = await apiRequest(Health, "/health");
		expect(result.kind).toBe("error");
	});

	test("decodes a valid reply", async () => {
		setSessionToken("token");
		reply(200, { status: "ok", service: "server" });
		expect(await apiRequest(Health, "/health")).toEqual({
			kind: "ready",
			value: { status: "ok", service: "server" },
		});
	});

	test("an unreachable server is an error with a reason", async () => {
		setSessionToken("token");
		globalThis.fetch = Object.assign(
			async () => {
				throw new TypeError("connection refused");
			},
			{ preconnect: realFetch.preconnect },
		);
		const result = await apiRequest(Health, "/health");
		expect(result.kind).toBe("error");
	});
});
