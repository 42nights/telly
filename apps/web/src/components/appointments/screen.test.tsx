// First: registers Happy DOM before React DOM and the router load.
import "../test/dom";

import { expect, test } from "bun:test";
import type { Appointment } from "@health/contracts/appointments";

import { FamilyProvider } from "@/lib/family";

import {
	act,
	fireEvent,
	type Reply,
	renderRouted,
	serve,
	setupDom,
	signIn,
	waitFor,
	within,
} from "../test/dom";
import { AppointmentsScreen } from "./screen";

setupDom();

const ME = "a".repeat(64);
const FAMILIES = {
	json: {
		families: [
			{ id: "f1", name: "Ada", createdAt: "2026-01-01T00:00:00.000Z" },
		],
	},
};
const LIST = "GET /api/families/f1/appointments";
const NO_SHARES = { json: { shares: [] } };

const appointment = (
	id: string,
	title: string,
	startsAt: string,
	over: Partial<Appointment> = {},
): Appointment => ({
	id,
	familyId: "f1",
	status: "suggested",
	visit: {
		title,
		clinician: null,
		location: null,
		startsAt,
		timeZone: "Europe/London",
	},
	prep: {
		transportation: null,
		reminders: [],
		symptoms: [],
		medication: [],
		eatingSleep: [],
		questions: [],
	},
	suggestion: { by: ME, at: "2026-09-01T08:00:00.000Z", source: "member" },
	request: null,
	confirmation: null,
	cancellation: null,
	summary: null,
	...over,
});

const show = () =>
	renderRouted(
		<FamilyProvider>
			<AppointmentsScreen />
		</FamilyProvider>,
	);

test("without a paired person the screen says so instead of showing visits", async () => {
	signIn();
	serve({ "GET /api/families": { json: { families: [] } } });
	const { view } = await show();
	expect(await view.findByText("No person is paired yet.")).toBeDefined();
	expect(view.getByText("No person")).toBeDefined();
});

test("signed out, the screen asks for sign-in", async () => {
	serve({});
	const { view } = await show();
	expect(await view.findByText("Sign-in required")).toBeDefined();
	expect(view.getByText(/Sign in to see appointments\./)).toBeDefined();
});

test("a family the caller is not a member of shows the forbidden notice", async () => {
	signIn();
	serve({
		"GET /api/families": FAMILIES,
		[LIST]: {
			status: 403,
			json: { error: "forbidden", message: "Not your family." },
		},
	});
	const { view } = await show();
	expect(await view.findByText("Not a member of this family")).toBeDefined();
	expect(view.getByText("Not your family.")).toBeDefined();
});

test("upcoming visits are kept apart from past and cancelled ones", async () => {
	signIn();
	serve({
		"GET /api/families": FAMILIES,
		[LIST]: {
			json: {
				appointments: [
					appointment("a1", "Eye check", "2030-10-20T09:30:00.000Z"),
					appointment("a2", "Dentist", "2030-11-01T09:30:00.000Z", {
						status: "cancelled",
						cancellation: { by: ME, at: "2026-09-02T08:00:00.000Z" },
					}),
					appointment("a3", "Bloods", "2020-01-01T09:30:00.000Z", {
						status: "confirmed",
					}),
				],
			},
		},
		"GET /api/families/f1/appointments/a1/shares": NO_SHARES,
		"GET /api/families/f1/appointments/a3/shares": NO_SHARES,
	});
	const { view } = await show();
	const upcoming = await view.findByRole("region", { name: "Upcoming visits" });
	expect(
		within(upcoming)
			.getAllByRole("article")
			.map((card) => card.getAttribute("aria-label")),
	).toEqual(["Eye check"]);
	const past = view.getByRole("region", { name: "Past and cancelled" });
	expect(
		within(past)
			.getAllByRole("article")
			.map((card) => card.getAttribute("aria-label")),
	).toEqual(["Dentist", "Bloods"]);
});

test("with no visits the screen says none are upcoming and hides the past list", async () => {
	signIn();
	serve({
		"GET /api/families": FAMILIES,
		[LIST]: { json: { appointments: [] } },
	});
	const { view } = await show();
	expect(await view.findByText("No upcoming visits recorded.")).toBeDefined();
	expect(view.queryByRole("region", { name: "Past and cancelled" })).toBeNull();
});

test("a new suggestion posts the visit in its own zone, then clears the form and reloads", async () => {
	signIn();
	let finish: (reply: Reply) => void = () => {};
	const calls = serve({
		"GET /api/families": FAMILIES,
		[LIST]: { json: { appointments: [] } },
		"POST /api/families/f1/appointments": () =>
			new Promise<Reply>((resolve) => {
				finish = resolve;
			}),
	});
	const { view } = await show();
	const form = await view.findByRole("region", { name: "Suggest a visit" });
	const panel = within(form);
	const save = panel.getByRole("button", { name: "Save suggestion" });
	expect(panel.getByText("A suggestion is not a booking.")).toBeDefined();
	expect(save.hasAttribute("disabled")).toBe(true);

	fireEvent.change(panel.getByLabelText("Visit"), {
		target: { value: " Eye check " },
	});
	expect(save.hasAttribute("disabled")).toBe(true);
	fireEvent.change(panel.getByLabelText("Date and time (local to the visit)"), {
		target: { value: "2030-10-20T10:30" },
	});
	fireEvent.change(panel.getByLabelText("Time zone of the visit"), {
		target: { value: "America/New_York" },
	});
	fireEvent.change(panel.getByLabelText("Clinician (optional)"), {
		target: { value: "Dr Lee" },
	});
	fireEvent.change(panel.getByLabelText("Place (optional)"), {
		target: { value: "  " },
	});
	fireEvent.change(panel.getByLabelText("Transportation"), {
		target: { value: "Bus 12" },
	});
	fireEvent.click(panel.getByLabelText("2 hours before"));
	fireEvent.click(panel.getByLabelText("30 minutes before"));
	fireEvent.change(panel.getByLabelText("Symptoms (one per line)"), {
		target: { value: "Tired\n\nDizzy" },
	});
	expect(save.hasAttribute("disabled")).toBe(false);

	fireEvent.click(save);
	expect(await panel.findByText("Saving suggestion…")).toBeDefined();
	expect(save.hasAttribute("disabled")).toBe(true);
	const post = calls.find((call) => call.method === "POST");
	expect(post?.body).toEqual({
		source: "member",
		visit: {
			title: "Eye check",
			clinician: "Dr Lee",
			location: null,
			startsAt: "2030-10-20T14:30:00.000Z",
			timeZone: "America/New_York",
		},
		prep: {
			transportation: "Bus 12",
			reminders: [1440, 30],
			symptoms: ["Tired", "Dizzy"],
			medication: [],
			eatingSleep: [],
			questions: [],
		},
	});

	await act(async () => finish({ status: 201, json: {} }));
	await waitFor(() =>
		expect(
			calls.filter((call) => call.path.endsWith("/appointments")),
		).toHaveLength(3),
	);
	expect((panel.getByLabelText("Visit") as HTMLInputElement).value).toBe("");
	expect(
		(panel.getByLabelText("Transportation") as HTMLInputElement).value,
	).toBe("");
	expect(
		(panel.getByLabelText("2 hours before") as HTMLInputElement).checked,
	).toBe(true);
	expect(
		(panel.getByLabelText("Time zone of the visit") as HTMLSelectElement).value,
	).toBe("America/New_York");
	expect(panel.getByText("A suggestion is not a booking.")).toBeDefined();
});

test("a failed save keeps the form and shows why; an incomplete form sends nothing", async () => {
	signIn();
	const calls = serve({
		"GET /api/families": FAMILIES,
		[LIST]: { json: { appointments: [] } },
		"POST /api/families/f1/appointments": {
			status: 503,
			json: { error: "unavailable", message: "Database is down." },
		},
	});
	const { view } = await show();
	const form = await view.findByRole("region", { name: "Suggest a visit" });
	const panel = within(form);
	const title = panel.getByLabelText("Visit") as HTMLInputElement;
	fireEvent.change(title, { target: { value: "Eye check" } });

	fireEvent.submit(title.form as HTMLFormElement);
	expect(calls.some((call) => call.method === "POST")).toBe(false);

	fireEvent.change(panel.getByLabelText("Date and time (local to the visit)"), {
		target: { value: "2030-10-20T10:30" },
	});
	fireEvent.click(panel.getByRole("button", { name: "Save suggestion" }));
	expect(await panel.findByText("Database is down.")).toBeDefined();
	expect(title.value).toBe("Eye check");
	expect(
		calls.filter(
			(call) => call.method === "GET" && call.path.endsWith("/appointments"),
		),
	).toHaveLength(1);
});
