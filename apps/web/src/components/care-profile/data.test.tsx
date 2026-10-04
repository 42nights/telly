// First: registers Happy DOM before React DOM and the router load.
import "../test/dom";

import { expect, test } from "bun:test";

import { act, renderHook, serve, setupDom, signIn, waitFor } from "../test/dom";
import { useCare } from "./data";

setupDom();

const ME = "a".repeat(64);
const BASE = "/api/families/f1";

const reads = {
	"GET /api/me": { json: { issuer: "test", subject: "s", identity: ME } },
	[`GET ${BASE}/care-access`]: {
		json: { mine: ["health_records"], grants: [], history: [] },
	},
	[`GET ${BASE}/care-profile`]: {
		json: {
			familyId: "f1",
			profile: {
				preferredName: null,
				language: null,
				timeZone: null,
				accessibilityNeeds: null,
				diagnoses: null,
				allergies: null,
				dietaryRestrictions: null,
				fluidRestrictions: null,
				activityRestrictions: null,
				routines: null,
				contacts: null,
				familiarDestinations: null,
				devices: null,
				declinedPrompts: [],
			},
			editedBy: null,
			editedAt: null,
			history: [],
		},
	},
	[`GET ${BASE}/care-instructions`]: { json: { instructions: [] } },
	[`GET ${BASE}/care-profile/prompt`]: { json: { lines: ["Hello."] } },
};

test("reads every part of the care plan for the family and the caller", async () => {
	signIn();
	serve(reads);
	const { result } = renderHook(() => useCare("f1"));
	await waitFor(() => expect(result.current.me).toBe(ME));
	await waitFor(() => expect(result.current.prompt.kind).toBe("ready"));
	expect(result.current.access.kind).toBe("ready");
	expect(result.current.profile.kind).toBe("ready");
	expect(result.current.instructions.kind).toBe("ready");
});

test("a kept write resolves to null and reads the plan again", async () => {
	signIn();
	const calls = serve({
		...reads,
		[`PUT ${BASE}/care-profile`]: { status: 204 },
	});
	const { result } = renderHook(() => useCare("f1"));
	await waitFor(() => expect(result.current.prompt.kind).toBe("ready"));
	const before = calls.filter((c) => c.path === `${BASE}/care-access`).length;
	const refused = await act(() =>
		result.current.write("PUT", "/care-profile", { x: 1 }),
	);
	expect(refused).toBeNull();
	expect(calls).toContainEqual({
		method: "PUT",
		path: `${BASE}/care-profile`,
		body: { x: 1 },
	});
	await waitFor(() =>
		expect(
			calls.filter((c) => c.path === `${BASE}/care-access`).length,
		).toBeGreaterThan(before),
	);
});

test("a refused write resolves to the server's message", async () => {
	signIn();
	serve({
		...reads,
		[`POST ${BASE}/care-access`]: {
			status: 403,
			json: { error: "forbidden", message: "No family_access grant." },
		},
	});
	const { result } = renderHook(() => useCare("f1"));
	const refused = await act(() =>
		result.current.write("POST", "/care-access", {}),
	);
	expect(refused).toBe("No family_access grant.");
});

test("signed out, nothing is read and a write asks to sign in again", async () => {
	const calls = serve(reads);
	const { result } = renderHook(() => useCare("f1"));
	await waitFor(() => expect(result.current.access.kind).toBe("signed_out"));
	expect(result.current.me).toBeNull();
	const refused = await act(() =>
		result.current.write("POST", "/care-access", {}),
	);
	expect(refused).toBe("Sign in again to save.");
	expect(calls).toEqual([]);
});
