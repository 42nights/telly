import { afterEach, describe, expect, mock, test } from "bun:test";
import type { MedicineSighting } from "@health/contracts/medicine-memory";

// The generated env module needs varlock at runtime; tests only need the server URL.
mock.module("@/env", () => ({
	ENV: { VITE_SERVER_URL: "http://server.test" },
}));
const { pinInAr, showInAr } = await import("./ar-pin");
const { setSessionToken } = await import("@/lib/session");

const memoryStorage = new Map<string, string>();
globalThis.sessionStorage = {
	getItem: (key: string) => memoryStorage.get(key) ?? null,
	setItem: (key: string, value: string) => void memoryStorage.set(key, value),
	removeItem: (key: string) => void memoryStorage.delete(key),
} as Storage;

const sighting = {
	id: "7",
	container: "Lisinopril bottle",
} as MedicineSighting;
const pinUrl =
	"http://server.test/api/families/1/medicine-memory/containers/7/ar-pin";

type Call = { url: string; method: string; body: unknown };

/** A fake server: records each call and answers with `status` and `body`. */
const fakeServer = (status: number, body: unknown) => {
	const calls: Call[] = [];
	globalThis.fetch = Object.assign(
		async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url: String(url),
				method: init?.method ?? "GET",
				body:
					init?.body === undefined ? undefined : JSON.parse(String(init.body)),
			});
			return new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			});
		},
		{ preconnect: realFetch.preconnect },
	);
	return calls;
};

/** A fake iOS shell that answers every AR request with `reply` plus its requestId. */
const fakeShell = (reply: Record<string, unknown>) => {
	const sent: Record<string, unknown>[] = [];
	globalThis.ReactNativeWebView = {
		postMessage: (data) => {
			const request = JSON.parse(data) as { requestId: string };
			sent.push(request);
			queueMicrotask(() =>
				globalThis.dispatchEvent(
					new CustomEvent("telly-ar", {
						detail: { ...reply, requestId: request.requestId },
					}),
				),
			);
		},
	};
	return sent;
};

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	globalThis.ReactNativeWebView = undefined;
	setSessionToken(null);
});

const signIn = () =>
	setSessionToken(
		`x.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 3600 }))}.y`,
	);

describe("pin it in AR", () => {
	test("stores the shell's anchor and world map with PUT ar-pin", async () => {
		signIn();
		fakeShell({
			type: "ar.pinSaved",
			containerId: "7",
			anchorId: "telly-pin-7",
			worldMap: "bWFw",
			mapBytes: 3,
		});
		const calls = fakeServer(200, {
			familyId: "1",
			containerId: "7",
			anchorId: "telly-pin-7",
			mapBytes: 3,
			createdAt: "2026-10-04T12:00:00Z",
			updatedAt: "2026-10-04T12:00:00Z",
		});
		const outcome = await pinInAr("1", sighting);
		expect(outcome.kind).toBe("done");
		expect(calls).toEqual([
			{
				url: pinUrl,
				method: "PUT",
				body: { anchorId: "telly-pin-7", worldMap: "bWFw" },
			},
		]);
	});

	test("a cancelled AR screen stores nothing", async () => {
		signIn();
		fakeShell({ type: "ar.error", code: "cancelled", message: "closed" });
		const calls = fakeServer(200, {});
		expect(await pinInAr("1", sighting)).toMatchObject({
			kind: "failed",
			code: "cancelled",
			title: "AR closed",
		});
		expect(calls).toEqual([]);
	});

	test("a denied camera says how to allow it", async () => {
		signIn();
		fakeShell({ type: "ar.error", code: "camera-denied", message: "denied" });
		expect(await pinInAr("1", sighting)).toMatchObject({
			kind: "failed",
			code: "camera-denied",
			text: "Allow the camera for Telly in iPhone Settings, then try again.",
		});
	});
});

describe("show me in AR", () => {
	test("reads the stored pin and sends its world map to the shell", async () => {
		signIn();
		const sent = fakeShell({ type: "ar.pinFound", containerId: "7" });
		const calls = fakeServer(200, {
			familyId: "1",
			containerId: "7",
			anchorId: "telly-pin-7",
			mapBytes: 3,
			createdAt: "2026-10-04T12:00:00Z",
			updatedAt: "2026-10-04T12:00:00Z",
			worldMap: "bWFw",
		});
		expect((await showInAr("1", sighting)).kind).toBe("done");
		expect(calls).toEqual([{ url: pinUrl, method: "GET", body: undefined }]);
		expect(sent[0]).toMatchObject({
			type: "ar.findPin",
			containerId: "7",
			label: "Lisinopril bottle",
			anchorId: "telly-pin-7",
			worldMap: "bWFw",
		});
	});

	test("without a stored pin, asks to pin first and opens no AR", async () => {
		signIn();
		const sent = fakeShell({ type: "ar.pinFound", containerId: "7" });
		fakeServer(404, { error: "not_found", message: "No AR pin" });
		expect(await showInAr("1", sighting)).toMatchObject({
			kind: "failed",
			code: "no-pin",
		});
		expect(sent).toEqual([]);
	});

	test("a room that is not recognized says what to try", async () => {
		signIn();
		fakeShell({
			type: "ar.error",
			code: "relocalization-failed",
			message: "not relocalized",
		});
		fakeServer(200, { anchorId: "telly-pin-7", worldMap: "bWFw" });
		expect(await showInAr("1", sighting)).toMatchObject({
			kind: "failed",
			code: "relocalization-failed",
			title: "I could not recognize the room",
		});
	});
});
