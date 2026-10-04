import { afterEach, describe, expect, mock, test } from "bun:test";
import { Health } from "@health/contracts";

// The generated env module needs varlock at runtime; tests only need the server URL. The mock must
// be in place before `./api` loads `@/env`, so these two imports cannot be static.
mock.module("@/env", () => ({
	ENV: { VITE_SERVER_URL: "http://server.test" },
}));
const { apiRequest, failureFor } = await import("./api");
const { getSessionToken, setSessionToken } = await import("./session");

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
		expect(failureFor(500, "not json")).toEqual({
			kind: "error",
			message: "HTTP 500",
		});
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

describe("session renewal (issue #222)", () => {
	// A JWT whose `exp` is `inSeconds` from now. Google ID tokens last one hour.
	const idToken = (name: string, inSeconds: number) =>
		`h.${Buffer.from(
			JSON.stringify({
				sub: name,
				exp: Math.floor(Date.now() / 1000) + inSeconds,
			}),
		).toString("base64url")}.s`;
	const renewed = idToken("renewed", 3600);
	// The server: `/api/sign-in/refresh` answers `renewal`. Each call is recorded as `refresh`, or as
	// the bearer token that a `/health` read sent.
	const server = (renewal: () => Response) => {
		const calls: string[] = [];
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).endsWith("/api/sign-in/refresh")) {
					calls.push("refresh");
					return renewal();
				}
				calls.push(new Headers(init?.headers).get("Authorization") ?? "none");
				return Response.json({ status: "ok", service: "server" });
			},
			{ preconnect: realFetch.preconnect },
		);
		return calls;
	};

	test("an ID token that expires soon is renewed once, before the requests that need it", async () => {
		setSessionToken(idToken("old", 60), "refresh-1");
		const calls = server(() => Response.json({ idToken: renewed }));
		await Promise.all([
			apiRequest(Health, "/health"),
			apiRequest(Health, "/health"),
		]);
		expect(calls).toEqual([
			"refresh",
			`Bearer ${renewed}`,
			`Bearer ${renewed}`,
		]);
		expect(getSessionToken()).toBe(renewed);
	});

	test("an expired ID token with a refresh token is still a session, and a fresh one is not renewed", async () => {
		setSessionToken(idToken("old", -60), "refresh-1");
		expect(getSessionToken()).not.toBeNull();
		const fresh = idToken("fresh", 3600);
		setSessionToken(fresh, "refresh-1");
		const calls = server(() => Response.json({ idToken: renewed }));
		await apiRequest(Health, "/health");
		expect(calls).toEqual([`Bearer ${fresh}`]);
	});

	test("a refused refresh token ends the session", async () => {
		setSessionToken(idToken("old", -60), "revoked");
		const calls = server(() =>
			Response.json(
				{ error: "unauthorized", message: "Sign in again." },
				{ status: 401 },
			),
		);
		expect(await apiRequest(Health, "/health")).toEqual({ kind: "signed_out" });
		expect(calls).toEqual(["refresh"]);
		expect(getSessionToken()).toBeNull();
	});

	test("when renewal fails, the session stays and the next request retries", async () => {
		const old = idToken("old", 60);
		setSessionToken(old, "refresh-1");
		const failed = server(() =>
			Response.json(
				{ error: "upstream_error", message: "down" },
				{ status: 502 },
			),
		);
		await apiRequest(Health, "/health");
		expect(failed).toEqual(["refresh", `Bearer ${old}`]);
		const calls = server(() => Response.json({ idToken: renewed }));
		await apiRequest(Health, "/health");
		expect(calls).toEqual(["refresh", `Bearer ${renewed}`]);
	});
});
