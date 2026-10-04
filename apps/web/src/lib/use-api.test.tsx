import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { Family } from "@health/contracts";
import { FamilyList } from "@health/contracts/families";
import { setSessionToken } from "@/lib/session";
import { setupDom } from "@/lib/test/dom";

setupDom();
// Static imports load before `dom` registers `document` and mocks `@/env`, so these wait for it.
const { act, renderHook, waitFor } = await import("@testing-library/react");
const { FAMILY, json, serve, signIn } = await import("@/lib/test/app");
const { apiRequest, familyPath, useApi } = await import("./api");
const { queryClient } = await import("./query");

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

test("a second screen within staleTime shows the cached value without reading again", async () => {
	signIn();
	const calls = serve({ "GET /api/families": { families: [FAMILY] } });
	const first = renderHook(() => useApi(FamilyList, "/api/families"));
	await waitFor(() => expect(first.result.current.kind).toBe("ready"));
	first.unmount();
	const second = renderHook(() => useApi(FamilyList, "/api/families"));
	expect(second.result.current).toMatchObject({
		kind: "ready",
		value: { families: [FAMILY] },
	});
	await Bun.sleep(20);
	expect(calls).toHaveLength(1);
});

test("a kept write reads its resource and the family record again, and nothing else", async () => {
	signIn();
	const records = familyPath(FAMILY.id);
	const alerts = familyPath(FAMILY.id, "/alerts");
	const reports = familyPath(FAMILY.id, "/reports");
	const calls = serve({
		[`GET ${records}`]: { families: [FAMILY] },
		[`GET ${alerts}`]: { families: [FAMILY] },
		[`GET ${reports}`]: { families: [FAMILY] },
		[`POST ${alerts}/a-1/acknowledgements`]: json(204, null),
	});
	const { result } = renderHook(() => [
		useApi(FamilyList, records),
		useApi(FamilyList, alerts),
		useApi(FamilyList, reports),
	]);
	await waitFor(() =>
		expect(result.current.every((read) => read.kind === "ready")).toBe(true),
	);
	expect(calls).toHaveLength(3);
	await apiRequest(null, `${alerts}/a-1/acknowledgements`, { method: "POST" });
	await waitFor(() => expect(calls).toHaveLength(6));
	await Bun.sleep(20);
	expect(calls.slice(3).map((call) => `${call.method} ${call.path}`)).toEqual([
		`POST ${alerts}/a-1/acknowledgements`,
		`GET ${alerts}`,
		`GET ${records}`,
	]);
});

test("a failed write reads nothing again", async () => {
	signIn();
	const alerts = familyPath(FAMILY.id, "/alerts");
	const calls = serve({ [`GET ${alerts}`]: { families: [FAMILY] } });
	const { result } = renderHook(() => useApi(FamilyList, alerts));
	await waitFor(() => expect(result.current.kind).toBe("ready"));
	await apiRequest(null, `${alerts}/a-1/acknowledgements`, { method: "POST" });
	await Bun.sleep(20);
	expect(calls).toHaveLength(2);
});

test("signing out removes every cached reply", async () => {
	signIn();
	serve({ "GET /api/families": { families: [FAMILY] } });
	const { result, unmount } = renderHook(() =>
		useApi(FamilyList, "/api/families"),
	);
	await waitFor(() => expect(result.current.kind).toBe("ready"));
	unmount();
	expect(queryClient.getQueryData(["api", "families"])).toBeDefined();
	setSessionToken(null);
	expect(queryClient.getQueryCache().getAll()).toEqual([]);
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
	await waitFor(() => expect(calls).toHaveLength(2));
	expect(result.current.kind).toBe("ready");
});

test("coming back to the screen does not read a value that is not polled again", async () => {
	signIn();
	const calls = serve({ "GET /api/families": { families: [FAMILY] } });
	const { result } = renderHook(() => useApi(FamilyList, "/api/families"));
	await waitFor(() => expect(result.current.kind).toBe("ready"));
	setSystemTime(new Date(Date.now() + 10 * 60_000));
	act(() => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await Bun.sleep(20);
	expect(calls).toHaveLength(1);
	expect(result.current.kind).toBe("ready");
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
	await waitFor(() =>
		expect(result.current).toEqual({
			kind: "error",
			message: "These values are old. Checking for current values.",
		}),
	);
	await waitFor(() => expect(held).toHaveLength(1));
	act(() => held[0]?.answer(families(OTHER)));
	await waitFor(() =>
		expect(result.current).toMatchObject({
			kind: "ready",
			value: { families: [OTHER] },
		}),
	);
});
