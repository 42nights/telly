import { expect, spyOn, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: these modules read `@/env` and `document`, which `@/lib/test/dom` sets up first.
const { act, renderHook, waitFor } = await import("@testing-library/react");
const { renderToString } = await import("react-dom/server");
const { serve, signIn } = await import("@/lib/test/app");
const { setSessionToken } = await import("@/lib/session");
const { startPendingSync, submitAction, usePendingCount } = await import(
	"@/lib/pending"
);

const PATH = "/api/families/fam-1/messages";
const ROUTE = `POST ${PATH}`;
const offline = () => {
	throw new TypeError("Failed to fetch");
};

// `startPendingSync` installs its retry timer once per page. The test keeps the timer callback
// instead of scheduling it, so later tests run it by hand and nothing keeps running after this file.
let retry: (() => void) | undefined;
let stop: (() => void) | undefined;

const queued = () =>
	JSON.parse(localStorage.getItem("telly.pending") ?? "[]") as unknown[];

test("the count shows only the signed-in person's waiting actions and follows each change", async () => {
	signIn({ sub: "user-2" });
	serve({ [ROUTE]: offline });
	await submitAction(PATH, { body: "from user-2" });

	signIn();
	const { result } = renderHook(() => usePendingCount());
	expect(result.current).toBe(0);

	await act(() => submitAction(PATH, { body: "from user-1" }));
	expect(result.current).toBe(1);

	serve({ [ROUTE]: { id: "m-1" } });
	await act(() => submitAction(PATH, { body: "from user-1" }));
	expect(result.current).toBe(0);
	// The other person's action stays on this device.
	expect(queued()).toHaveLength(1);
});

test("a server render shows no waiting actions, because the queue lives on the device", async () => {
	signIn();
	serve({ [ROUTE]: offline });
	await submitAction(PATH, { body: "waits on this device" });
	const Count = () => <output>{usePendingCount()}</output>;
	expect(renderToString(<Count />)).toBe("<output>0</output>");
});

// The remaining tests share the one `startPendingSync` call made here, as the app makes it once.
test("starting the sync sends the actions that waited before the page loaded", async () => {
	signIn();
	serve({ [ROUTE]: offline });
	await submitAction(PATH, { body: "saved before reload" });

	const calls = serve({ [ROUTE]: { id: "m-1" } });
	// Only this call is caught: testing-library's `waitFor` needs the real `setInterval`.
	const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((
		callback: () => void,
	) => {
		retry = callback;
		return 0;
	}) as unknown as typeof setInterval);
	stop = startPendingSync();
	setIntervalSpy.mockRestore();
	await waitFor(() => expect(queued()).toEqual([]));
	expect(calls.map((call) => [call.method, call.path])).toEqual([
		["POST", PATH],
	]);
	expect(calls[0]?.body).toEqual({
		body: "saved before reload",
		clientId: expect.any(String),
	});
	expect(retry).toBeFunction();
});

test("reconnecting the network sends the waiting actions", async () => {
	signIn();
	serve({ [ROUTE]: offline });
	await submitAction(PATH, { body: "sent on reconnect" });

	const calls = serve({ [ROUTE]: { id: "m-1" } });
	window.dispatchEvent(new Event("online"));
	await waitFor(() => expect(queued()).toEqual([]));
	expect(calls).toHaveLength(1);
});

test("a change to the queue in another tab updates the count", async () => {
	signIn();
	const { result } = renderHook(() => usePendingCount());
	expect(result.current).toBe(0);

	const action = {
		clientId: "c-1",
		owner: "https://issuer.test user-1",
		path: PATH,
		payload: { body: "from another tab" },
		queuedAt: 0,
	};
	localStorage.setItem("telly.pending", JSON.stringify([action]));
	act(() => {
		window.dispatchEvent(new StorageEvent("storage", { key: "telly.other" }));
	});
	expect(result.current).toBe(0);
	act(() => {
		window.dispatchEvent(new StorageEvent("storage", { key: "telly.pending" }));
	});
	expect(result.current).toBe(1);
});

test("signing in as the owner shows the owner's count and sends the waiting actions", async () => {
	signIn();
	serve({ [ROUTE]: offline });
	await submitAction(PATH, { body: "sent after sign-in" });

	setSessionToken(null);
	const { result } = renderHook(() => usePendingCount());
	expect(result.current).toBe(0);

	const calls = serve({ [ROUTE]: { id: "m-1" } });
	act(() => signIn());
	expect(result.current).toBe(1);
	await waitFor(() => expect(result.current).toBe(0));
	expect(calls).toHaveLength(1);
	expect(calls[0]?.body).toEqual({
		body: "sent after sign-in",
		clientId: expect.any(String),
	});
});

test("the retry timer sends only when the signed-in person has actions waiting", async () => {
	const tick = retry;
	if (tick === undefined) throw new Error("startPendingSync set no timer");
	signIn({ sub: "user-2" });
	serve({ [ROUTE]: offline });
	await submitAction(PATH, { body: "user-2 waits" });

	// Only another person's action waits: nothing is sent.
	signIn();
	const idle = serve({ [ROUTE]: { id: "m-1" } });
	tick();
	await Bun.sleep(0);
	expect(idle).toEqual([]);

	serve({ [ROUTE]: offline });
	await submitAction(PATH, { body: "user-1 waits" });
	const calls = serve({ [ROUTE]: { id: "m-1" } });
	tick();
	await waitFor(() => expect(calls).toHaveLength(1));
	expect(calls[0]?.body).toEqual({
		body: "user-1 waits",
		clientId: expect.any(String),
	});
	expect(queued()).toHaveLength(1);
});

test("a stopped sync no longer sends on reconnect or sign-in", async () => {
	stop?.();
	signIn();
	serve({ [ROUTE]: offline });
	await submitAction(PATH, { body: "waits after stop" });
	const calls = serve({ [ROUTE]: { id: "m-1" } });
	window.dispatchEvent(new Event("online"));
	signIn();
	await Bun.sleep(10);
	expect(calls).toEqual([]);
	expect(queued()).toHaveLength(1);
});
