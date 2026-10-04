import { expect, test } from "bun:test";
import { setupDom } from "@/lib/test/dom";

setupDom();

// Dynamic: these modules read `@/env` and `document`, which `@/lib/test/dom` sets up first.
const { act, renderHook, waitFor } = await import("@testing-library/react");
const { json, serve, signIn } = await import("@/lib/test/app");
const { useMedicineMemory } = await import("@/lib/medicine-memory");

const MEMORY = "/api/families/fam-1/medicine-memory";
const OFF = { permission: null, sightings: [] };
const ON = {
	permission: {
		places: ["kitchen counter"],
		setBy: "user-1",
		setAt: "2026-10-04T12:00:00.000Z",
	},
	sightings: [],
};

test("the memory of the selected family is read from the server", async () => {
	signIn();
	const calls = serve({ [`GET ${MEMORY}`]: OFF });
	const { result } = renderHook(() => useMedicineMemory("fam-1"));
	expect(result.current.memory).toEqual({ kind: "loading" });
	await waitFor(() =>
		expect(result.current.memory).toMatchObject({ kind: "ready", value: OFF }),
	);
	expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		`GET ${MEMORY}`,
	]);
});

test("a change that the server accepts is sent once and the memory is read again", async () => {
	signIn();
	let enabled = false;
	const calls = serve({
		[`GET ${MEMORY}`]: () => (enabled ? ON : OFF),
		[`PUT ${MEMORY}`]: () => {
			enabled = true;
			return ON;
		},
	});
	const { result } = renderHook(() => useMedicineMemory("fam-1"));
	await waitFor(() =>
		expect(result.current.memory).toMatchObject({ value: OFF }),
	);

	const body = { enabled: true, places: ["kitchen counter"] };
	let reply: unknown;
	await act(async () => {
		reply = await result.current.change("PUT", "", body);
	});
	expect(reply).toEqual({ kind: "ready", value: ON });
	await waitFor(() =>
		expect(result.current.memory).toMatchObject({ value: ON }),
	);
	expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		`GET ${MEMORY}`,
		`PUT ${MEMORY}`,
		`GET ${MEMORY}`,
	]);
	expect(calls[1]?.body).toEqual(body);
});

test("a refused change returns the server's reason and does not read the memory again", async () => {
	signIn();
	const calls = serve({
		[`GET ${MEMORY}`]: OFF,
		[`POST ${MEMORY}/sightings`]: json(409, {
			error: "conflict",
			message: "Remembering is off.",
		}),
	});
	const { result } = renderHook(() => useMedicineMemory("fam-1"));
	await waitFor(() =>
		expect(result.current.memory).toMatchObject({ kind: "ready" }),
	);

	let reply: unknown;
	await act(async () => {
		reply = await result.current.change("POST", "/sightings", {
			container: "Lisinopril bottle",
		});
	});
	expect(reply).toEqual({ kind: "error", message: "Remembering is off." });
	expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		`GET ${MEMORY}`,
		`POST ${MEMORY}/sightings`,
	]);
});

test("with no paired person, nothing is read and a change is refused without a request", async () => {
	signIn();
	const calls = serve({});
	const { result } = renderHook(() => useMedicineMemory(null));
	expect(result.current.memory).toEqual({ kind: "loading" });
	expect(await result.current.change("PUT", "", { enabled: false })).toEqual({
		kind: "error",
		message: "No person is paired yet.",
	});
	expect(calls).toEqual([]);
});
