import { afterEach, describe, expect, test } from "bun:test";
import { Health } from "@health/contracts";
import { setupDom } from "@/lib/test/dom";

// `setupDom` mocks `@/env` and provides sessionStorage; `./api` must load after it.
setupDom();
const { apiBlob, apiRequest, failureFor, familyPath } = await import("./api");
const { getSessionToken, setSessionToken } = await import("./session");

const realFetch = globalThis.fetch;
type Sent = { url: string; init: RequestInit | undefined };
// Replaces fetch with one that records each request and answers with `respond`.
const fake = (respond: () => Response | Promise<Response>) => {
	const sent: Sent[] = [];
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			sent.push({ url: String(input), init });
			return respond();
		},
		{ preconnect: realFetch.preconnect },
	);
	return sent;
};
const reply = (status: number, body: unknown) =>
	fake(
		() =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
	);
const unreachable = () =>
	fake(() => {
		throw new TypeError("connection refused");
	});
// A fetch that rejects like the browser's when its signal is already aborted.
const honorAbort = () =>
	Object.assign(
		async (_input: RequestInfo | URL, init?: RequestInit) => {
			init?.signal?.throwIfAborted();
			return new Response("{}");
		},
		{ preconnect: realFetch.preconnect },
	);

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
		unreachable();
		expect(await apiRequest(Health, "/health")).toEqual({
			kind: "error",
			message: "The server is not reachable: TypeError: connection refused",
			unreachable: true,
		});
	});

	test("sends a JSON body with the token and the method", async () => {
		setSessionToken("token");
		const sent = reply(200, { status: "ok", service: "server" });
		await apiRequest(Health, "/api/x", { method: "PUT", body: { a: 1 } });
		expect(sent).toHaveLength(1);
		expect(sent[0]?.url).toBe("http://server.test/api/x");
		expect(sent[0]?.init?.method).toBe("PUT");
		expect(sent[0]?.init?.body).toBe('{"a":1}');
		expect(sent[0]?.init?.headers).toEqual({
			Authorization: "Bearer token",
			"Content-Type": "application/json",
		});
	});

	test("a GET without a body sends no body and no Content-Type", async () => {
		setSessionToken("token");
		const sent = reply(200, { status: "ok", service: "server" });
		await apiRequest(Health, "/health");
		expect(sent[0]?.init?.method).toBe("GET");
		expect(sent[0]?.init?.body).toBeUndefined();
		expect(sent[0]?.init?.headers).toEqual({ Authorization: "Bearer token" });
	});

	test("sends a raw body with its own Content-Type", async () => {
		setSessionToken("token");
		const sent = fake(() => new Response(null, { status: 204 }));
		const data = new Blob(["audio"], { type: "audio/webm" });
		expect(
			await apiRequest(null, "/api/voice", {
				method: "POST",
				rawBody: { data, type: "audio/webm" },
			}),
		).toEqual({ kind: "ready", value: undefined });
		expect(sent[0]?.init?.body).toBe(data);
		expect(sent[0]?.init?.headers).toEqual({
			Authorization: "Bearer token",
			"Content-Type": "audio/webm",
		});
	});

	test("a 401 reply means signed out", async () => {
		setSessionToken("token");
		reply(401, { error: "unauthorized", message: "expired" });
		expect(await apiRequest(Health, "/health")).toEqual({ kind: "signed_out" });
	});

	test("an error reply that is not JSON keeps its HTTP status", async () => {
		setSessionToken("token");
		// A gateway's 5xx page tells the user the server is having trouble.
		fake(() => new Response("<html>bad gateway</html>", { status: 502 }));
		expect(await apiRequest(Health, "/health")).toEqual({
			kind: "error",
			message:
				"The server is busy or had a problem (HTTP 502). Try again in a minute.",
		});
		fake(() => new Response("not found", { status: 404 }));
		expect(await apiRequest(Health, "/health")).toEqual({
			kind: "error",
			message: "HTTP 404",
		});
	});

	test("rejects when its own signal aborts", async () => {
		setSessionToken("token");
		globalThis.fetch = honorAbort();
		const controller = new AbortController();
		controller.abort();
		await expect(
			apiRequest(Health, "/health", { signal: controller.signal }),
		).rejects.toThrow();
	});

	test("a token the server rejects ends the session; a 403 does not", async () => {
		setSessionToken("token");
		reply(403, { error: "forbidden", message: "not a member" });
		await apiRequest(Health, "/health");
		expect(getSessionToken()).toBe("token");
		reply(401, { error: "unauthorized", message: "bad token" });
		expect(await apiRequest(Health, "/health")).toEqual({ kind: "signed_out" });
		expect(getSessionToken()).toBeNull();
	});
});

describe("apiBlob", () => {
	test("does not call the server without a session", async () => {
		const sent = reply(200, {});
		expect(await apiBlob("/api/speech")).toEqual({ kind: "signed_out" });
		expect(sent).toHaveLength(0);
	});

	test("POSTs the JSON body and returns the binary reply", async () => {
		setSessionToken("token");
		const sent = fake(
			() =>
				new Response("mp3-bytes", {
					headers: { "Content-Type": "audio/mpeg" },
				}),
		);
		const result = await apiBlob("/api/speech", { body: { text: "Hi" } });
		expect(result.kind).toBe("ready");
		if (result.kind !== "ready") return;
		expect(await result.value.text()).toBe("mp3-bytes");
		expect(sent[0]?.url).toBe("http://server.test/api/speech");
		expect(sent[0]?.init?.method).toBe("POST");
		expect(sent[0]?.init?.body).toBe('{"text":"Hi"}');
		expect(sent[0]?.init?.headers).toEqual({
			Authorization: "Bearer token",
			"Content-Type": "application/json",
		});
	});

	test("uses the given method", async () => {
		setSessionToken("token");
		const sent = fake(() => new Response("x"));
		await apiBlob("/api/speech", { method: "PUT" });
		expect(sent[0]?.init?.method).toBe("PUT");
	});

	test("maps an error reply like apiRequest", async () => {
		setSessionToken("token");
		reply(503, { error: "unavailable", message: "TTS is not configured" });
		expect(await apiBlob("/api/speech")).toEqual({
			kind: "unavailable",
			message: "TTS is not configured",
		});
		fake(() => new Response("oops", { status: 500 }));
		expect(await apiBlob("/api/speech")).toEqual({
			kind: "error",
			message:
				"The server is busy or had a problem (HTTP 500). Try again in a minute.",
		});
	});

	test("an unreachable server is an error with a reason", async () => {
		setSessionToken("token");
		unreachable();
		expect(await apiBlob("/api/speech")).toEqual({
			kind: "error",
			message: "The server is not reachable: TypeError: connection refused",
			unreachable: true,
		});
	});

	test("rejects when its own signal aborts", async () => {
		setSessionToken("token");
		globalThis.fetch = honorAbort();
		const controller = new AbortController();
		controller.abort();
		await expect(
			apiBlob("/api/speech", { signal: controller.signal }),
		).rejects.toThrow();
	});

	test("a 401 ends the session, unless a newer token replaced it during the request", async () => {
		setSessionToken("token");
		reply(401, { error: "unauthorized", message: "bad token" });
		expect(await apiBlob("/api/speech")).toEqual({ kind: "signed_out" });
		expect(getSessionToken()).toBeNull();
		setSessionToken("old");
		fake(() => {
			setSessionToken("newer");
			return new Response("{}", { status: 401 });
		});
		expect(await apiBlob("/api/speech")).toEqual({ kind: "signed_out" });
		expect(getSessionToken()).toBe("newer");
	});
});

test("familyPath encodes the family id", () => {
	expect(familyPath("a/b c", "/alerts")).toBe("/api/families/a%2Fb%20c/alerts");
	expect(familyPath("123")).toBe("/api/families/123");
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
