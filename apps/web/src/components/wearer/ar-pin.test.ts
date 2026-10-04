import { afterEach, describe, expect, mock, test } from "bun:test";
import type {
	MedicineMemory,
	MedicineSighting,
} from "@health/contracts/medicine-memory";
import type { ObjectDetection } from "@health/contracts/vision";

import type { MedicineMemoryChange } from "@/lib/medicine-memory";

// The generated env module needs varlock at runtime; tests only need the server URL.
mock.module("@/env", () => ({
	ENV: { VITE_SERVER_URL: "http://server.test" },
}));
const { movedPlace, objectFor, pinInAr, showInAr } = await import("./ar-pin");
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
	"http://server.test/api/families/1/medicine-memory/objects/7/ar-pin";

type Call = { url: string; method: string; body: unknown };

/** The member's things and a `change` that records each call. */
const memberOf = (sightings: readonly MedicineSighting[]) => {
	const changes: { method: string; path: string; body: unknown }[] = [];
	const change: MedicineMemoryChange = async (method, path, body) => {
		changes.push({ method, path, body });
		return { kind: "ready", value: {} as MedicineMemory };
	};
	return { member: { sightings, change }, changes };
};
const alone = memberOf([sighting]).member;
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
			objectId: "7",
			anchorId: "telly-pin-7",
			worldMap: "bWFw",
			mapBytes: 3,
		});
		const calls = fakeServer(200, {
			familyId: "1",
			objectId: "7",
			anchorId: "telly-pin-7",
			mapBytes: 3,
			createdAt: "2026-10-04T12:00:00Z",
			updatedAt: "2026-10-04T12:00:00Z",
		});
		const outcome = await pinInAr("1", sighting, alone);
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
		expect(await pinInAr("1", sighting, alone)).toMatchObject({
			kind: "failed",
			code: "cancelled",
			title: "AR closed",
		});
		expect(calls).toEqual([]);
	});

	test("a denied camera says how to allow it", async () => {
		signIn();
		fakeShell({ type: "ar.error", code: "camera-denied", message: "denied" });
		expect(await pinInAr("1", sighting, alone)).toMatchObject({
			kind: "failed",
			code: "camera-denied",
			text: "Allow the camera for Telly in iPhone Settings, then try again.",
		});
	});
});

describe("show me in AR", () => {
	test("reads the stored pin and sends its world map to the shell", async () => {
		signIn();
		const sent = fakeShell({ type: "ar.pinFound", objectId: "7" });
		const calls = fakeServer(200, {
			familyId: "1",
			objectId: "7",
			anchorId: "telly-pin-7",
			mapBytes: 3,
			createdAt: "2026-10-04T12:00:00Z",
			updatedAt: "2026-10-04T12:00:00Z",
			worldMap: "bWFw",
		});
		expect((await showInAr("1", sighting, alone)).kind).toBe("done");
		expect(calls).toEqual([{ url: pinUrl, method: "GET", body: undefined }]);
		expect(sent[0]).toMatchObject({
			type: "ar.findPin",
			objectId: "7",
			label: "Lisinopril bottle",
			anchorId: "telly-pin-7",
			worldMap: "bWFw",
			others: [],
		});
	});

	test("without a stored pin, asks to pin first and opens no AR", async () => {
		signIn();
		const sent = fakeShell({ type: "ar.pinFound", objectId: "7" });
		fakeServer(404, { error: "not_found", message: "No AR pin" });
		expect(await showInAr("1", sighting, alone)).toMatchObject({
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
		expect(await showInAr("1", sighting, alone)).toMatchObject({
			kind: "failed",
			code: "relocalization-failed",
			title: "I could not recognize the room",
		});
	});
});

// Every saved thing of one member: keys and a wallet are pinned, the glasses are not.
const thing = (
	id: string,
	category: MedicineSighting["category"],
	container: string,
	place: string,
	pinned: boolean,
) => ({ id, category, container, place, pinned }) as MedicineSighting;
const keys = thing("k", "keys", "keys", "Hall table", true);
const wallet = thing("w", "wallet", "wallet", "Kitchen counter", true);
const glasses = thing("g", "glasses", "reading glasses", "Desk", false);
const sightings = [keys, wallet, glasses];

/** A fake server that answers by "METHOD path" and records each call. */
const routes = (answers: Record<string, unknown>) => {
	const calls: Call[] = [];
	globalThis.fetch = Object.assign(
		async (url: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const path = new URL(String(url)).pathname;
			calls.push({
				url: path,
				method,
				body:
					init?.body === undefined ? undefined : JSON.parse(String(init.body)),
			});
			const answer = answers[`${method} ${path}`];
			return new Response(JSON.stringify(answer ?? {}), {
				status: answer === undefined ? 404 : 200,
				headers: { "Content-Type": "application/json" },
			});
		},
		{ preconnect: realFetch.preconnect },
	);
	return calls;
};

type ShellRequest = { type: string; requestId: string } & Record<
	string,
	unknown
>;

/** A fake iOS shell that answers each request with `answer(request)`. */
const scriptedShell = (
	answer: (request: ShellRequest) => Record<string, unknown>,
) => {
	const sent: ShellRequest[] = [];
	globalThis.ReactNativeWebView = {
		postMessage: (data) => {
			const request = JSON.parse(data) as ShellRequest;
			sent.push(request);
			queueMicrotask(() =>
				globalThis.dispatchEvent(
					new CustomEvent("telly-ar", {
						detail: { ...answer(request), requestId: request.requestId },
					}),
				),
			);
		},
	};
	return sent;
};

const pinPath = (id: string) =>
	`/api/families/1/medicine-memory/objects/${id}/ar-pin`;

describe("every pinned thing in the room (#351)", () => {
	test("a new pin joins the room map of the pinned thing at the same place, and every pin in it gets the new map", async () => {
		signIn();
		const sent = scriptedShell((request) =>
			request.type === "ar.savePin"
				? {
						type: "ar.pinSaved",
						anchorId: "A-g",
						worldMap: "bmV3",
						mapBytes: 3,
						anchors: [
							{ objectId: "g", anchorId: "A-g" },
							{ objectId: "w", anchorId: "A-w" },
							{ objectId: "forgotten", anchorId: "A-x" },
						],
					}
				: { type: "ar.closed" },
		);
		const calls = routes({
			[`GET ${pinPath("w")}`]: { anchorId: "A-w", worldMap: "a2l0Y2hlbg==" },
			[`PUT ${pinPath("g")}`]: { anchorId: "A-g" },
			[`PUT ${pinPath("w")}`]: { anchorId: "A-w" },
		});
		const atCounter = { ...glasses, place: "kitchen counter" };
		const outcome = await pinInAr(
			"1",
			atCounter,
			memberOf([keys, wallet, atCounter]).member,
		);
		expect(outcome.kind).toBe("done");
		expect(sent[0]).toMatchObject({
			type: "ar.savePin",
			objectId: "g",
			worldMap: "a2l0Y2hlbg==",
			others: [
				{ objectId: "k", label: "keys" },
				{ objectId: "w", label: "wallet" },
			],
		});
		expect(sent[1]).toMatchObject({
			type: "ar.watch",
			session: sent[0]?.session,
		});
		expect(calls).toEqual([
			{ url: pinPath("w"), method: "GET", body: undefined },
			{
				url: pinPath("g"),
				method: "PUT",
				body: { anchorId: "A-g", worldMap: "bmV3" },
			},
			{
				url: pinPath("w"),
				method: "PUT",
				body: { anchorId: "A-w", worldMap: "bmV3" },
			},
		]);
	});

	test("the first pin of a member starts a new room map", async () => {
		signIn();
		const sent = scriptedShell(() => ({
			type: "ar.error",
			code: "cancelled",
			message: "closed",
		}));
		const calls = routes({});
		await pinInAr("1", glasses, memberOf([glasses]).member);
		expect(sent[0]?.worldMap).toBeUndefined();
		expect(calls).toEqual([]);
	});

	test("a vision check that confirms a pinned thing at a new spot saves the sighting and the room map", async () => {
		signIn();
		const capturedAt = new Date().toISOString();
		const detection = (
			category: ObjectDetection["category"],
			label: string,
			box: ObjectDetection["box"],
		): ObjectDetection => ({
			category,
			label,
			confidence: 0.9,
			needsVerification: false,
			box,
		});
		let watches = 0;
		let closed: () => void = () => {};
		const done = new Promise<void>((resolve) => {
			closed = resolve;
		});
		const sent = scriptedShell((request) => {
			if (request.type === "ar.findPin") return { type: "ar.pinFound" };
			watches += 1;
			if (watches === 1)
				return {
					type: "ar.check",
					checkId: "c1",
					objectIds: ["k", "w"],
					image: "aW1n",
					width: 960,
					height: 1280,
					capturedAt,
				};
			if (watches === 2)
				return {
					type: "ar.moved",
					checkId: "c1",
					objectIds: ["k"],
					worldMap: "bW92ZWQ=",
					anchors: [
						{ objectId: "k", anchorId: "B-k" },
						{ objectId: "w", anchorId: "A-w" },
					],
				};
			closed();
			return { type: "ar.closed" };
		});
		const calls = routes({
			[`GET ${pinPath("k")}`]: { anchorId: "A-k", worldMap: "bWFw" },
			"POST /api/families/1/vision/object-detections": {
				frame: {
					id: "c1",
					capturedAt,
					width: 960,
					height: 1280,
					crop: { x: 0, y: 0, width: 960, height: 1280 },
					rotation: 0,
				},
				// The glasses are not pinned and the remote is not saved: neither is followed.
				detections: [
					detection("keys", "keys", { x: 100, y: 200, width: 40, height: 20 }),
					detection("glasses", "reading glasses", {
						x: 0,
						y: 0,
						width: 9,
						height: 9,
					}),
					detection("remote", "remote", { x: 0, y: 0, width: 9, height: 9 }),
				],
				model: "test",
				analyzedAt: capturedAt,
			},
			[`PUT ${pinPath("k")}`]: { anchorId: "B-k" },
			[`PUT ${pinPath("w")}`]: { anchorId: "A-w" },
		});
		const { member, changes } = memberOf(sightings);
		expect((await showInAr("1", keys, member)).kind).toBe("done");
		await done;

		expect(sent[0]).toMatchObject({
			type: "ar.findPin",
			others: [{ objectId: "w", label: "wallet" }],
		});
		// The second watch answers the check with the center of the keys' box.
		expect(sent[2]).toMatchObject({
			type: "ar.watch",
			answer: { checkId: "c1", found: [{ objectId: "k", x: 120, y: 210 }] },
		});
		expect(calls[1]).toMatchObject({
			url: "/api/families/1/vision/object-detections",
			body: {
				frame: { id: "c1", width: 960, height: 1280, rotation: 0 },
				image: { type: "image/jpeg", data: "aW1n" },
			},
		});
		expect(changes).toEqual([
			{
				method: "POST",
				path: "/sightings",
				body: {
					container: "keys",
					place: "New spot, seen in AR (was: Hall table)",
					seenAt: capturedAt,
					source: "camera_check",
					confidence: 0.9,
					labelRead: true,
					category: "keys",
				},
			},
		]);
		expect(calls.slice(2)).toEqual([
			{
				url: pinPath("k"),
				method: "PUT",
				body: { anchorId: "B-k", worldMap: "bW92ZWQ=" },
			},
			{
				url: pinPath("w"),
				method: "PUT",
				body: { anchorId: "A-w", worldMap: "bW92ZWQ=" },
			},
		]);
	});

	test("a detection is a saved thing only when kind and name match one of them", () => {
		const seen = (
			category: ObjectDetection["category"],
			label: string | null,
			needsVerification = false,
		): ObjectDetection => ({
			category,
			label,
			confidence: 0.9,
			needsVerification,
			box: { x: 0, y: 0, width: 1, height: 1 },
		});
		expect(objectFor(seen("keys", " Keys "), sightings)?.id).toBe("k");
		expect(objectFor(seen("glasses", "glasses"), sightings)?.id).toBe("g");
		expect(objectFor(seen("wallet", "keys"), sightings)).toBeUndefined();
		expect(objectFor(seen("keys", "keys", true), sightings)).toBeUndefined();
		expect(objectFor(seen("keys", null), sightings)).toBeUndefined();
		// "keys" is part of two saved names: it is neither of them, unless one is exactly "keys".
		const car = thing("c", "keys", "car keys", "Hall", true);
		const house = thing("h", "keys", "house keys", "Hall", true);
		expect(objectFor(seen("keys", "keys"), [car, house])).toBeUndefined();
		expect(objectFor(seen("keys", "keys"), [car, house, keys])?.id).toBe("k");
	});

	test("a moved place keeps the first place, however often it moves", () => {
		const once = movedPlace("Hall table");
		expect(once).toBe("New spot, seen in AR (was: Hall table)");
		expect(movedPlace(once)).toBe(once);
		expect(movedPlace("x".repeat(110))).toBe("New spot, seen in AR");
	});
});
