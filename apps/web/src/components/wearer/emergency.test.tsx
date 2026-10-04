import "../test/setup";

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import type { EmergencyOutcome } from "@health/contracts/emergency";
import * as contacts from "@/lib/contacts";
import {
	type Call,
	fireEvent,
	installDom,
	render,
	type ServerReply,
	serve,
	waitFor,
} from "../test/dom";

import { Emergency, useEmergency } from "./emergency";

installDom();

const EMERGENCY = "POST /api/families/1/emergency";
const CHECK_IN = "POST /api/families/1/emergency/check-in";
const PROFILE = "GET /api/families/1/care-profile";
const WEARER = { name: null, callback: null };

/** The wearer home's part: the panel, plus the request box that calls `start`. */
function Home({ familyId }: { familyId: string | null }) {
	const emergency = useEmergency(familyId);
	return (
		<>
			<Emergency emergency={emergency} familyId={familyId} />
			<button onClick={() => emergency.start("ouch", "ouch")} type="button">
				Say ouch
			</button>
			<button
				onClick={() => emergency.start("help", "Help, I fell")}
				type="button"
			>
				Say help
			</button>
		</>
	);
}

const handoff = {
	name: null,
	callback: null,
	event: "Asked for emergency help",
	report: null,
	responsiveness: "responding",
	care: {
		status: "available",
		conditions: null,
		allergies: [],
		medications: ["Lisinopril 10 mg", "Metformin 500 mg"],
		savedAt: null,
	},
	location: {
		status: "current",
		latitude: 51.5,
		longitude: -0.12,
		accuracyMeters: 12.4,
		ageSeconds: 30,
	},
} as const;

const raised = { status: "raised", alertId: "7", summary: "Help" } as const;

const helpOutcome: EmergencyOutcome = {
	action: "help",
	handoff,
	family: raised,
};

const profile = {
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
};

/** The care profile read, with `contacts` in contact order. */
const profileWith = (contacts: unknown) => ({
	json: {
		familyId: "1",
		profile: { ...profile, contacts },
		editedBy: null,
		editedAt: null,
		history: [],
	},
});

/** A care profile whose first contact with a number is the family's. */
const withFamily = profileWith([
	{ name: "Neighbour", relationship: null, phone: null },
	{ name: "Sam", relationship: "Son", phone: "+1 (555) 010-0200" },
]);

const checkIn: EmergencyOutcome = {
	action: "check_in",
	prompt: "Are you OK?",
	event: {
		kind: "ouch",
		report: "ouch",
		observedAt: "2026-10-04T12:00:00.000Z",
	},
	reason: null,
};

/** A route that stays open until `release` answers it, so the waiting state can be checked. */
const held = () => {
	const { promise, resolve } = Promise.withResolvers<ServerReply>();
	return { route: () => promise, release: resolve };
};

const stubLocation = (
	answer: (success: PositionCallback, failure: PositionErrorCallback) => void,
) =>
	Object.defineProperty(navigator, "geolocation", {
		configurable: true,
		value: { getCurrentPosition: answer },
	});

// happy-dom's navigator has a `geolocation` that is null; a browser without it has no such key.
let geolocation: PropertyDescriptor | undefined;
beforeEach(() => {
	const proto = Object.getPrototypeOf(navigator);
	geolocation = Object.getOwnPropertyDescriptor(proto, "geolocation");
	Reflect.deleteProperty(proto, "geolocation");
});

afterEach(() => {
	Reflect.deleteProperty(navigator, "geolocation");
	if (geolocation)
		Object.defineProperty(
			Object.getPrototypeOf(navigator),
			"geolocation",
			geolocation,
		);
	setSystemTime();
	dialed.mockClear();
});

// The dialer is the phone's: tests record the number it would open.
const dialed = spyOn(contacts, "dial").mockImplementation(() => {});

const posts = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

const link = (view: ReturnType<typeof render>, name: string) =>
	view.getByRole("link", { name }).getAttribute("href");

const rows = (container: HTMLElement) =>
	Object.fromEntries(
		[...container.querySelectorAll("dt")].map((dt) => [
			dt.textContent,
			dt.nextElementSibling?.textContent,
		]),
	);

/** No "practice" or "simulated" words anywhere: every call is real. */
const noPretendCalls = (view: ReturnType<typeof render>) =>
	expect(view.container.textContent ?? "").not.toMatch(/simulat|practice/i);

describe("Emergency", () => {
	test("without a paired person the dialer still opens, and only the alert needs sign-in", async () => {
		const calls = serve({});
		const view = render(<Home familyId={null} />);
		expect(link(view, "Call emergency help")).toBe("tel:911");
		fireEvent.click(view.getByRole("link", { name: "Call emergency help" }));
		view.getByText(
			"Sign in with a paired person so a call also alerts your family.",
		);
		// No number on file anywhere: the field asks for one.
		view.getByRole("textbox", { name: "Family phone number" });
		fireEvent.click(view.getByRole("button", { name: "Say ouch" }));
		expect((await view.findByRole("alert")).textContent).toBe(
			"The family alert did not go through: sign in first. Call for help with the buttons above.",
		);
		expect(calls).toEqual([]);
		noPretendCalls(view);
	});

	test("emergency help opens the saved emergency number and alerts the family", async () => {
		localStorage.setItem(
			"telly.contacts",
			JSON.stringify({ emergency: "112", savedAt: 1 }),
		);
		const reply = held();
		const calls = serve({ [EMERGENCY]: reply.route, [PROFILE]: withFamily });
		const view = render(<Home familyId="1" />);
		await waitFor(() =>
			expect(link(view, "Call emergency help")).toBe("tel:112"),
		);
		fireEvent.click(view.getByRole("link", { name: "Call emergency help" }));
		expect((await view.findByRole("status")).textContent).toBe(
			"Telling your family…",
		);
		expect(
			view
				.getByRole("link", { name: "Call emergency help" })
				.querySelector(".animate-spin"),
		).not.toBeNull();
		await waitFor(() => expect(posts(calls)).toHaveLength(1));
		// No geolocation in this browser: the location is unavailable, never a guess.
		expect(posts(calls)[0]).toEqual({
			method: "POST",
			path: "/api/families/1/emergency",
			body: {
				kind: "help",
				report: null,
				wearer: WEARER,
				location: { status: "unavailable" },
			},
		});
		reply.release({ json: helpOutcome });
		await view.findByText("Your family got an alert.");
		view.getByText("Tell the operator:");
		expect(rows(view.container)).toEqual({
			Name: "Not on file",
			Callback: "Not on file",
			"What happened": "Asked for emergency help",
			"Exact words": "None",
			Responding: "Yes",
			Conditions: "Unknown",
			Allergies: "None recorded",
			"Verified medicines": "Lisinopril 10 mg, Metformin 500 mg",
			Location: "Current: 51.50000, -0.12000 · ±12 m · 30 s old",
		});
		noPretendCalls(view);
	});

	test("a spoken request for help alerts the family and shows what is missing", async () => {
		serve({
			[PROFILE]: withFamily,
			[EMERGENCY]: {
				json: {
					action: "help",
					handoff: {
						...handoff,
						name: "Ada",
						callback: "+44 20 7946 0000",
						report: "Help, I fell",
						responsiveness: "not_responding",
						care: { status: "unavailable", reason: "No health records access" },
						location: {
							...handoff.location,
							status: "last_known",
							ageSeconds: 300,
						},
					},
					family: { status: "failed", message: "No family member to alert." },
				},
			},
		});
		const view = render(<Home familyId="1" />);
		fireEvent.click(view.getByRole("button", { name: "Say help" }));
		await view.findByText(
			"Your family was not alerted: No family member to alert.",
		);
		// It never dials by itself: the buttons stay for the person to press.
		expect(dialed).not.toHaveBeenCalled();
		view.getByRole("link", { name: "Call emergency help" });
		expect(rows(view.container)).toEqual({
			Name: "Ada",
			Callback: "+44 20 7946 0000",
			"What happened": "Asked for emergency help",
			"Exact words": "Help, I fell",
			Responding: "No answer",
			"Conditions, medicines, allergies": "No health records access",
			Location: "Last known: 51.50000, -0.12000 · ±12 m · 5 min old",
		});
	});

	test.each([
		["denied", "Not shared: location permission is off"],
		["unavailable", "Unavailable"],
	] as const)(
		"a handoff without a fix (%s) says why",
		async (status, words) => {
			serve({
				[PROFILE]: withFamily,
				[EMERGENCY]: {
					json: {
						...helpOutcome,
						handoff: { ...handoff, location: { status } },
					},
				},
			});
			const view = render(<Home familyId="1" />);
			fireEvent.click(view.getByRole("link", { name: "Call emergency help" }));
			await view.findByText("Tell the operator:");
			expect(rows(view.container).Location).toBe(words);
		},
	);

	test("a location fix is sent with its accuracy and time", async () => {
		const captured = Date.parse("2026-10-04T11:59:00.000Z");
		stubLocation((success) =>
			success({
				coords: { latitude: 51.5, longitude: -0.12, accuracy: 8 },
				timestamp: captured,
			} as GeolocationPosition),
		);
		const calls = serve({ [EMERGENCY]: { json: helpOutcome } });
		const view = render(<Home familyId="1" />);
		fireEvent.click(view.getByRole("link", { name: "Call emergency help" }));
		await view.findByText("Tell the operator:");
		expect(posts(calls)[0]?.body).toMatchObject({
			location: {
				status: "fix",
				latitude: 51.5,
				longitude: -0.12,
				accuracyMeters: 8,
				capturedAt: "2026-10-04T11:59:00.000Z",
			},
		});
	});

	test.each([
		[1, "denied"],
		[3, "unavailable"],
	] as const)("a location error %i is sent as %s", async (code, status) => {
		stubLocation((_success, failure) =>
			failure?.({ code, PERMISSION_DENIED: 1 } as GeolocationPositionError),
		);
		const calls = serve({ [EMERGENCY]: { json: helpOutcome } });
		const view = render(<Home familyId="1" />);
		fireEvent.click(view.getByRole("link", { name: "Call emergency help" }));
		await view.findByText("Tell the operator:");
		expect(posts(calls)[0]?.body).toMatchObject({ location: { status } });
	});

	test("call my family dials the first care-profile contact with a number and alerts the family", async () => {
		// A number saved on this phone loses to the care profile's contact order.
		localStorage.setItem(
			"telly.contacts",
			JSON.stringify({ familyPhone: "+1 555 010 0999", savedAt: 1 }),
		);
		const reply = held();
		const calls = serve({ [EMERGENCY]: reply.route, [PROFILE]: withFamily });
		const view = render(<Home familyId="1" />);
		await waitFor(() =>
			expect(link(view, "Call my family")).toBe("tel:+15550100200"),
		);
		fireEvent.click(view.getByRole("link", { name: "Call my family" }));
		expect(view.getByRole("status").textContent).toBe("Telling your family…");
		expect(
			view
				.getByRole("link", { name: "Call my family" })
				.querySelector(".animate-spin"),
		).not.toBeNull();
		reply.release({ json: { action: "family", family: raised } });
		await view.findByText("I told your family.");
		view.getByText("Your family got an alert.");
		expect(view.queryByText(/Nothing here confirms/)).toBeNull();
		expect(posts(calls).map((c) => c.body)).toEqual([
			{ kind: "family", report: null },
		]);
		noPretendCalls(view);
	});

	test("with no contact number in the profile, the number saved on this phone is called", async () => {
		localStorage.setItem(
			"telly.contacts",
			JSON.stringify({ familyPhone: "+1 555 010 0999", savedAt: 1 }),
		);
		serve({ [PROFILE]: profileWith(null) });
		const view = render(<Home familyId="1" />);
		await waitFor(() =>
			expect(link(view, "Call my family")).toBe("tel:+15550100999"),
		);
	});

	test("with no number, Save & Call saves it to the care profile and opens the dialer", async () => {
		const existing = [{ name: "Neighbour", relationship: null, phone: null }];
		const calls = serve({
			[PROFILE]: profileWith(existing),
			"PUT /api/families/1/care-profile": { status: 204 },
			[EMERGENCY]: { json: { action: "family", family: raised } },
		});
		const view = render(<Home familyId="1" />);
		const field = await view.findByRole("textbox", {
			name: "Family phone number",
		});
		expect(view.queryByRole("link", { name: "Call my family" })).toBeNull();

		// A short number is refused before anything is saved or dialed.
		fireEvent.change(field, { target: { value: "5550" } });
		fireEvent.click(view.getByRole("button", { name: "Save & Call" }));
		view.getByText("Enter the full phone number, with the area code.");
		expect(dialed).not.toHaveBeenCalled();

		fireEvent.change(field, { target: { value: "+1 555 010 0300" } });
		fireEvent.click(view.getByRole("button", { name: "Save & Call" }));
		expect(dialed.mock.calls).toEqual([["+1 555 010 0300"]]);
		await view.findByText("I told your family.");
		expect(posts(calls)).toEqual([
			{
				method: "PUT",
				path: "/api/families/1/care-profile",
				body: {
					...profile,
					contacts: [
						...existing,
						{
							name: "Family",
							relationship: "Family",
							phone: "+1 555 010 0300",
						},
					],
				},
			},
			{
				method: "POST",
				path: "/api/families/1/emergency",
				body: { kind: "family", report: null },
			},
		]);
		// The next press is a plain call link.
		expect(link(view, "Call my family")).toBe("tel:+15550100300");
		noPretendCalls(view);
	});

	test("a member who cannot edit the profile still calls, with the number kept on this phone", async () => {
		const calls = serve({
			[PROFILE]: {
				status: 403,
				body: { error: "forbidden", message: "No health records access." },
			},
			[EMERGENCY]: { json: { action: "family", family: raised } },
		});
		const view = render(<Home familyId="1" />);
		fireEvent.change(
			await view.findByRole("textbox", { name: "Family phone number" }),
			{ target: { value: "555 010 0400" } },
		);
		fireEvent.click(view.getByRole("button", { name: "Save & Call" }));
		expect(dialed.mock.calls).toEqual([["555 010 0400"]]);
		await view.findByText(
			"Saved on this phone only. No health records access.",
		);
		expect(posts(calls).map((c) => c.method)).toEqual(["POST"]);
		expect(link(view, "Call my family")).toBe("tel:5550100400");
	});

	test.each([
		[503, "Alerts are not configured."],
		[500, "Something broke."],
	])("a %i reply shows the server's reason", async (status, message) => {
		serve({
			[PROFILE]: withFamily,
			[EMERGENCY]: { status, body: { error: "unavailable", message } },
		});
		const view = render(<Home familyId="1" />);
		fireEvent.click(await view.findByRole("link", { name: "Call my family" }));
		expect((await view.findByRole("alert")).textContent).toBe(
			`The family alert did not go through: ${message} Call for help with the buttons above.`,
		);
	});

	test("a 401 reply asks to sign in", async () => {
		serve({ [EMERGENCY]: { status: 401 } });
		const view = render(<Home familyId="1" />);
		fireEvent.click(view.getByRole("link", { name: "Call emergency help" }));
		expect((await view.findByRole("alert")).textContent).toBe(
			"The family alert did not go through: sign in first. Call for help with the buttons above.",
		);
	});

	test("an ouch starts a check-in; I'm OK sends the wearer's words", async () => {
		const calls = serve({
			[EMERGENCY]: { json: checkIn },
			[CHECK_IN]: {
				json: {
					action: "none",
					reason: "denied",
					safety: "unconfirmed",
					family: null,
				},
			},
		});
		const view = render(<Home familyId="1" />);
		fireEvent.click(view.getByRole("button", { name: "Say ouch" }));
		const dialog = await view.findByRole("alertdialog", { name: "Check-in" });
		expect(dialog.textContent).toContain("Are you OK?");
		expect(dialog.textContent).toContain(
			"If you don't answer in 30 seconds, I'll alert your family.",
		);
		noPretendCalls(view);
		expect(posts(calls)[0]?.body).toMatchObject({
			kind: "event",
			event: { kind: "ouch", report: "ouch" },
		});
		fireEvent.click(view.getByRole("button", { name: "I'm OK" }));
		await view.findByText("OK. I won't call for help.");
		view.getByText(
			"Nothing here confirms you are safe. Ask for help any time.",
		);
		expect(view.queryByRole("alertdialog")).toBeNull();
		expect(posts(calls)[1]).toEqual({
			method: "POST",
			path: "/api/families/1/emergency/check-in",
			body: {
				event: checkIn.action === "check_in" ? checkIn.event : null,
				reply: { kind: "speech", speaker: "wearer", text: "I'm OK" },
				wearer: WEARER,
				location: { status: "unavailable" },
			},
		});
	});

	test("I need help in a check-in alerts the family and shows the call buttons", async () => {
		const calls = serve({
			[PROFILE]: withFamily,
			[EMERGENCY]: { json: checkIn },
			[CHECK_IN]: { json: helpOutcome },
		});
		const view = render(<Home familyId="1" />);
		fireEvent.click(view.getByRole("button", { name: "Say ouch" }));
		fireEvent.click(await view.findByRole("button", { name: "I need help" }));
		await view.findByText("Your family got an alert.");
		view.getByRole("link", { name: "Call emergency help" });
		expect(posts(calls)[1]?.body).toMatchObject({
			reply: { kind: "speech", speaker: "wearer", text: "I need help" },
		});
	});

	test("no answer by the deadline alerts the family and shows the call buttons", async () => {
		const calls = serve({
			[PROFILE]: withFamily,
			// The check-in opened 30 s ago: its deadline has passed when the prompt shows.
			[EMERGENCY]: () => {
				setSystemTime();
				return { json: checkIn };
			},
			[CHECK_IN]: {
				json: {
					...helpOutcome,
					handoff: { ...handoff, responsiveness: "not_responding" },
				},
			},
		});
		const view = render(<Home familyId="1" />);
		setSystemTime(new Date(Date.now() - 30_000));
		fireEvent.click(view.getByRole("button", { name: "Say ouch" }));
		await view.findByText("Your family got an alert.");
		expect(rows(view.container).Responding).toBe("No answer");
		expect(link(view, "Call emergency help")).toBe("tel:911");
		expect(link(view, "Call my family")).toBe("tel:+15550100200");
		expect(dialed).not.toHaveBeenCalled();
		expect(posts(calls)[1]?.body).toMatchObject({
			reply: { kind: "no_response", waitedSeconds: 30 },
		});
		noPretendCalls(view);
	});

	test("an unexpected reply is an error, not a result", async () => {
		serve({ [EMERGENCY]: { json: { action: "maybe" } } });
		const view = render(<Home familyId="1" />);
		fireEvent.click(view.getByRole("link", { name: "Call emergency help" }));
		expect((await view.findByRole("alert")).textContent).toContain(
			"The server sent an unexpected reply",
		);
	});
});
