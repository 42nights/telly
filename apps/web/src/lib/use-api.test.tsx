import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { Family } from "@health/contracts";
import { FamilyList } from "@health/contracts/families";
import { setSessionToken } from "@/lib/session";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Static imports load before `dom` registers `document` and mocks `@/env`, so these wait for it.
const { act, renderHook, waitFor } = await import("@testing-library/react");
const { FAMILY, json, serve, signIn } = await import("@/lib/test/app");
const { useApi } = await import("./api");

const OTHER = { ...FAMILY, id: "fam-2", name: "Grandpa Joe" };

type Held = {
	readonly path: string;
	readonly signal: AbortSignal | null | undefined;
	readonly answer: (response: Response) => void;
};

// A server that answers only when the test says so. With `ignoreAbort` it keeps answering after
// the client gives up, like a reply already on its way.
const hold = ({ ignoreAbort = false } = {}) => {
	const held: Held[] = [];
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const { promise, resolve, reject } = Promise.withResolvers<Response>();
			const signal = init?.signal;
			held.push({
				path: new URL(String(input)).pathname,
				signal,
				answer: resolve,
			});
			if (!ignoreAbort)
				signal?.addEventListener("abort", () => reject(signal.reason));
			return promise;
		},
		{ preconnect: () => {} },
	) as typeof fetch;
	return held;
};

const families = (...list: Family[]) => json(200, { families: list });

afterEach(() => {
	setSystemTime();
	Reflect.deleteProperty(document, "visibilityState");
});

test("a null path stays loading and calls nothing", async () => {
	signIn();
	const calls = serve({});
	const { result } = renderHook(() => useApi(FamilyList, null));
	await Bun.sleep(20);
	expect(result.current).toEqual({ kind: "loading" });
	expect(calls).toEqual([]);
});

test("without a session the read is signed out and nothing is sent", async () => {
	const calls = serve({ "GET /api/families": { families: [FAMILY] } });
	const { result } = renderHook(() => useApi(FamilyList, "/api/families"));
	await waitFor(() => expect(result.current).toEqual({ kind: "signed_out" }));
	expect(calls).toEqual([]);
});

test("shows loading, then the decoded reply with the time it arrived", async () => {
	signIn();
	const calls = serve({ "GET /api/families": { families: [FAMILY] } });
	const before = Date.now();
	const { result } = renderHook(() => useApi(FamilyList, "/api/families"));
	expect(result.current).toEqual({ kind: "loading" });
	await waitFor(() => expect(result.current.kind).toBe("ready"));
	if (result.current.kind !== "ready") throw new Error("not ready");
	expect(result.current.value).toEqual({ families: [FAMILY] });
	expect(result.current.at).toBeGreaterThanOrEqual(before);
	expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"GET /api/families",
	]);
	expect(calls[0]?.headers.get("Authorization")).toStartWith("Bearer h.");
});

test("a 503 reply shows unavailable with the server's message", async () => {
	signIn();
	serve({
		"GET /api/families": json(503, {
			error: "unavailable",
			message: "DB down",
		}),
	});
	const { result } = renderHook(() => useApi(FamilyList, "/api/families"));
	await waitFor(() =>
		expect(result.current).toEqual({ kind: "unavailable", message: "DB down" }),
	);
});

test("a reply that breaks the contract is an error, never data", async () => {
	signIn();
	serve({ "GET /api/families": { families: "none" } });
	const { result } = renderHook(() => useApi(FamilyList, "/api/families"));
	await waitFor(() => expect(result.current.kind).toBe("error"));
});

test("a network failure is an unreachable error", async () => {
	signIn();
	serve({
		"GET /api/families": () => {
			throw new TypeError("Failed to fetch");
		},
	});
	const { result } = renderHook(() => useApi(FamilyList, "/api/families"));
	await waitFor(() =>
		expect(result.current).toEqual({
			kind: "error",
			message: "The server is not reachable: TypeError: Failed to fetch",
			unreachable: true,
		}),
	);
});

test("a new path shows loading until its own reply and cancels the old read", async () => {
	signIn();
	const held = hold();
	const { result, rerender } = renderHook(
		({ path }: { path: string }) => useApi(FamilyList, path),
		{ initialProps: { path: "/api/a" } },
	);
	await waitFor(() => expect(held).toHaveLength(1));
	act(() => held[0]?.answer(families(FAMILY)));
	await waitFor(() => expect(result.current.kind).toBe("ready"));

	rerender({ path: "/api/b" });
	expect(result.current).toEqual({ kind: "loading" });
	await waitFor(() => expect(held).toHaveLength(2));
	expect(held[1]?.path).toBe("/api/b");
	act(() => held[1]?.answer(families(OTHER)));
	await waitFor(() =>
		expect(result.current).toMatchObject({
			kind: "ready",
			value: { families: [OTHER] },
		}),
	);
});

test("a reply to a replaced read is dropped, so one person's data never shows as another's", async () => {
	signIn();
	const held = hold({ ignoreAbort: true });
	const { result, rerender } = renderHook(
		({ path }: { path: string }) => useApi(FamilyList, path),
		{ initialProps: { path: "/api/a" } },
	);
	await waitFor(() => expect(held).toHaveLength(1));
	rerender({ path: "/api/b" });
	await waitFor(() => expect(held).toHaveLength(2));
	expect(held[0]?.signal?.aborted).toBe(true);
	act(() => held[1]?.answer(families(OTHER)));
	await waitFor(() => expect(result.current.kind).toBe("ready"));
	await act(async () => {
		held[0]?.answer(families(FAMILY));
		await Bun.sleep(20);
	});
	expect(result.current).toMatchObject({ value: { families: [OTHER] } });
});

test("unmounting cancels the read in flight", async () => {
	signIn();
	const held = hold();
	const { unmount } = renderHook(() => useApi(FamilyList, "/api/families"));
	await waitFor(() => expect(held).toHaveLength(1));
	expect(held[0]?.signal?.aborted).toBe(false);
	unmount();
	expect(held[0]?.signal?.aborted).toBe(true);
});

test("a new refreshKey reads again", async () => {
	signIn();
	const calls = serve({ "GET /api/families": { families: [FAMILY] } });
	const { result, rerender } = renderHook(
		({ refreshKey }: { refreshKey: number }) =>
			useApi(FamilyList, "/api/families", { refreshKey }),
		{ initialProps: { refreshKey: 1 } },
	);
	await waitFor(() => expect(result.current.kind).toBe("ready"));
	expect(calls).toHaveLength(1);
	rerender({ refreshKey: 1 });
	rerender({ refreshKey: 2 });
	await waitFor(() => expect(calls).toHaveLength(2));
});

test("a session change reads again, and signing out shows signed out", async () => {
	signIn();
	const calls = serve({ "GET /api/families": { families: [FAMILY] } });
	const { result } = renderHook(() => useApi(FamilyList, "/api/families"));
	await waitFor(() => expect(result.current.kind).toBe("ready"));
	act(() => signIn({ sub: "user-2" }));
	await waitFor(() => expect(calls).toHaveLength(2));
	act(() => setSessionToken(null));
	await waitFor(() => expect(result.current).toEqual({ kind: "signed_out" }));
	expect(calls).toHaveLength(2);
});

test("polls every pollMs and stops after unmount", async () => {
	signIn();
	const calls = serve({ "GET /api/families": { families: [FAMILY] } });
	const { result, unmount } = renderHook(() =>
		useApi(FamilyList, "/api/families", { pollMs: 50 }),
	);
	await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
	expect(result.current.kind).toBe("ready");
	unmount();
	const count = calls.length;
	await Bun.sleep(150);
	expect(calls).toHaveLength(count);
});

test("a polled read with no answer in pollMs fails, and the next poll recovers", async () => {
	signIn();
	const held = hold();
	const { result } = renderHook(() =>
		useApi(FamilyList, "/api/families", { pollMs: 50 }),
	);
	await waitFor(() =>
		expect(result.current).toEqual({
			kind: "error",
			message: "The server did not answer in time.",
			unreachable: true,
		}),
	);
	expect(held[0]?.signal?.aborted).toBe(true);
	// The server answers again; a later poll shows its value.
	serve({ "GET /api/families": { families: [FAMILY] } });
	await waitFor(() => expect(result.current.kind).toBe("ready"));
});

test("losing the network fails at once, and getting it back reads again", async () => {
	signIn();
	const calls = serve({ "GET /api/families": { families: [FAMILY] } });
	const { result } = renderHook(() => useApi(FamilyList, "/api/families"));
	await waitFor(() => expect(result.current.kind).toBe("ready"));
	act(() => {
		window.dispatchEvent(new Event("offline"));
	});
	expect(result.current).toEqual({
		kind: "error",
		message:
			"This phone has no network connection, so the last values may not be current.",
		unreachable: true,
	});
	act(() => {
		window.dispatchEvent(new Event("online"));
	});
	await waitFor(() => expect(result.current.kind).toBe("ready"));
	expect(calls).toHaveLength(2);
});

test("coming back to the screen reads again; hiding it does not", async () => {
	signIn();
	const calls = serve({ "GET /api/families": { families: [FAMILY] } });
	const { result } = renderHook(() => useApi(FamilyList, "/api/families"));
	await waitFor(() => expect(result.current.kind).toBe("ready"));
	Object.defineProperty(document, "visibilityState", {
		value: "hidden",
		configurable: true,
	});
	document.dispatchEvent(new Event("visibilitychange"));
	await Bun.sleep(20);
	expect(calls).toHaveLength(1);
	Object.defineProperty(document, "visibilityState", {
		value: "visible",
		configurable: true,
	});
	act(() => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
	// Without polling the last value stays while the new read runs.
	expect(result.current.kind).toBe("ready");
	await waitFor(() => expect(calls).toHaveLength(2));
});

test("a value older than two polls is not shown after coming back", async () => {
	signIn();
	serve({ "GET /api/families": { families: [FAMILY] } });
	const { result } = renderHook(() =>
		useApi(FamilyList, "/api/families", { pollMs: 1000 }),
	);
	await waitFor(() => expect(result.current.kind).toBe("ready"));
	const held = hold();
	setSystemTime(new Date(Date.now() + 5000));
	act(() => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
	expect(result.current).toEqual({
		kind: "error",
		message: "The app was in the background. Checking for current values.",
	});
	await waitFor(() => expect(held).toHaveLength(1));
	act(() => held[0]?.answer(families(OTHER)));
	await waitFor(() =>
		expect(result.current).toMatchObject({
			kind: "ready",
			value: { families: [OTHER] },
		}),
	);
});
