import "../test/setup";

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import type { EmergencyOutcome } from "@health/contracts/emergency";
import {
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

const call = {
	simulated: true,
	states: ["connecting", "connected"],
	outcome: "connected",
	recordDelivered: false,
} as const;

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

const dispatch: EmergencyOutcome = {
	action: "dispatch",
	call,
	handoff,
	family: raised,
};

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
});

const rows = (container: HTMLElement) =>
	Object.fromEntries(
		[...container.querySelectorAll("dt")].map((dt) => [
			dt.textContent,
			dt.nextElementSibling?.textContent,
		]),
	);

describe("Emergency", () => {
	test("without a paired person the calls are off and a request fails as signed out", async () => {
		const calls = serve({});
		const view = render(<Home familyId={null} />);
		expect(
			view.getByRole("button", { name: "Call emergency help" }),
		).toHaveProperty("disabled", true);
		expect(
			view.getByRole("link", { name: "Call my family" }).getAttribute("href"),
		).toBe("tel:+19197170390");
		view.getByText("Emergency calls need a paired person and sign-in.");
		fireEvent.click(view.getByRole("button", { name: "Say ouch" }));
		expect((await view.findByRole("alert")).textContent).toBe(
			"The request did not go through: sign in first. Get help another way.",
		);
		expect(calls).toEqual([]);
	});

	test("emergency help connects a practice call and shows what a dispatcher would hear", async () => {
		const reply = held();
		const calls = serve({ [EMERGENCY]: reply.route });
		const view = render(<Home familyId="1" />);
		fireEvent.click(view.getByRole("button", { name: "Call emergency help" }));
		expect((await view.findByRole("status")).textContent).toBe(
			"Connecting (simulated)…",
		);
		const helpButton = view.getByRole("button", {
			name: "Call emergency help",
		});
		expect(helpButton).toHaveProperty("disabled", true);
		expect(helpButton.querySelector(".animate-spin")).not.toBeNull();
		expect(
			view
				.getByRole("link", { name: "Call my family" })
				.querySelector(".animate-spin"),
		).toBeNull();
		await waitFor(() => expect(calls).toHaveLength(1));
		// No geolocation in this browser: the location is unavailable, never a guess.
		expect(calls[0]).toEqual({
			method: "POST",
			path: "/api/families/1/emergency",
			body: {
				kind: "help",
				report: null,
				wearer: WEARER,
				location: { status: "unavailable" },
			},
		});
		reply.release({ json: dispatch });
		await view.findByText("Practice call connected (simulated).");
		view.getByText(/No real call was made\./);
		view.getByText("Your family got an alert.");
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
		// Done: the buttons work again.
		expect(
			view.getByRole("button", { name: "Call emergency help" }),
		).toHaveProperty("disabled", false);
	});

	test("a failed practice call says to get help another way and shows what is missing", async () => {
		serve({
			[EMERGENCY]: {
				json: {
					action: "dispatch",
					call: {
						...call,
						states: ["connecting", "failed"],
						outcome: "failed",
					},
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
			"Practice call failed (simulated). Get help another way.",
		);
		view.getByText("Your family was not alerted: No family member to alert.");
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
				[EMERGENCY]: {
					json: { ...dispatch, handoff: { ...handoff, location: { status } } },
				},
			});
			const view = render(<Home familyId="1" />);
			fireEvent.click(
				view.getByRole("button", { name: "Call emergency help" }),
			);
			await view.findByText("Practice call connected (simulated).");
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
		const calls = serve({ [EMERGENCY]: { json: dispatch } });
		const view = render(<Home familyId="1" />);
		fireEvent.click(view.getByRole("button", { name: "Call emergency help" }));
		await view.findByText("Practice call connected (simulated).");
		expect(calls[0]?.body).toMatchObject({
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
		const calls = serve({ [EMERGENCY]: { json: dispatch } });
		const view = render(<Home familyId="1" />);
		fireEvent.click(view.getByRole("button", { name: "Call emergency help" }));
		await view.findByText("Practice call connected (simulated).");
		expect(calls[0]?.body).toMatchObject({ location: { status } });
	});

	test("call my family tells the family and says so", async () => {
		const reply = held();
		const calls = serve({ [EMERGENCY]: reply.route });
		const view = render(<Home familyId="1" />);
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
		expect(calls.map((c) => c.body)).toEqual([
			{ kind: "family", report: null },
		]);
	});

	test.each([
		[503, "Calls are not configured."],
		[500, "Something broke."],
	])("a %i reply shows the server's reason", async (status, message) => {
		serve({
			[EMERGENCY]: { status, body: { error: "unavailable", message } },
		});
		const view = render(<Home familyId="1" />);
		fireEvent.click(view.getByRole("link", { name: "Call my family" }));
		expect((await view.findByRole("alert")).textContent).toBe(
			`The request did not go through: ${message} Get help another way.`,
		);
	});

	test("a 401 reply asks to sign in", async () => {
		serve({ [EMERGENCY]: { status: 401 } });
		const view = render(<Home familyId="1" />);
		fireEvent.click(view.getByRole("button", { name: "Call emergency help" }));
		expect((await view.findByRole("alert")).textContent).toBe(
			"The request did not go through: sign in first. Get help another way.",
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
			"If you don't answer in 30 seconds, I'll call for help (simulated)",
		);
		expect(calls[0]?.body).toMatchObject({
			kind: "event",
			event: { kind: "ouch", report: "ouch" },
		});
		fireEvent.click(view.getByRole("button", { name: "I'm OK" }));
		await view.findByText("OK. I won't call for help.");
		view.getByText(
			"Nothing here confirms you are safe. Ask for help any time.",
		);
		expect(view.queryByRole("alertdialog")).toBeNull();
		expect(calls[1]).toEqual({
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

	test("I need help in a check-in dispatches", async () => {
		const calls = serve({
			[EMERGENCY]: { json: checkIn },
			[CHECK_IN]: { json: dispatch },
		});
		const view = render(<Home familyId="1" />);
		fireEvent.click(view.getByRole("button", { name: "Say ouch" }));
		fireEvent.click(await view.findByRole("button", { name: "I need help" }));
		await view.findByText("Practice call connected (simulated).");
		expect(calls[1]?.body).toMatchObject({
			reply: { kind: "speech", speaker: "wearer", text: "I need help" },
		});
	});

	test("no answer by the deadline is sent as no response", async () => {
		const calls = serve({
			// The check-in opened 30 s ago: its deadline has passed when the prompt shows.
			[EMERGENCY]: () => {
				setSystemTime();
				return { json: checkIn };
			},
			[CHECK_IN]: {
				json: {
					action: "none",
					reason: "not_an_emergency",
					safety: "unconfirmed",
					family: { status: "failed", message: "Alerts are off." },
				},
			},
		});
		const view = render(<Home familyId="1" />);
		setSystemTime(new Date(Date.now() - 30_000));
		fireEvent.click(view.getByRole("button", { name: "Say ouch" }));
		await view.findByText("This is not an emergency by itself.");
		view.getByText("Your family was not alerted: Alerts are off.");
		expect(calls[1]?.body).toMatchObject({
			reply: { kind: "no_response", waitedSeconds: 30 },
		});
	});

	test("an unexpected reply is an error, not a result", async () => {
		serve({ [EMERGENCY]: { json: { action: "maybe" } } });
		const view = render(<Home familyId="1" />);
		fireEvent.click(view.getByRole("link", { name: "Call my family" }));
		expect((await view.findByRole("alert")).textContent).toContain(
			"The server sent an unexpected reply",
		);
	});
});
