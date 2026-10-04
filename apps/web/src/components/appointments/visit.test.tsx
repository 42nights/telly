// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { expect, test } from "bun:test";
import type { Appointment } from "@health/contracts/appointments";
import type { RenderResult } from "@testing-library/react";

import {
	act,
	fireEvent,
	type Reply,
	render,
	serve,
	setupDom,
	signIn,
	waitFor,
	within,
} from "../test/dom-routed";
import { VisitCard } from "./visit";

setupDom();

const ME = "a".repeat(64);
const BASE = "/api/families/f1/appointments/a%201";
const SHARES = { [`GET ${BASE}/shares`]: { json: { shares: [] } } };

const appointment = (over: Partial<Appointment> = {}): Appointment => ({
	id: "a 1",
	familyId: "f1",
	status: "suggested",
	visit: {
		title: "Eye check",
		clinician: null,
		location: null,
		startsAt: "2030-10-20T09:30:00.000Z",
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

const show = (value: Appointment) => ({
	view: render(<VisitCard appointment={value} familyId="f1" />),
});

/** The term → value pairs of the visit's facts list. */
const facts = (view: RenderResult) =>
	Object.fromEntries(
		Array.from(view.container.querySelectorAll("dt"), (dt) => [
			dt.textContent,
			dt.nextElementSibling?.textContent,
		]),
	);

test("a new suggestion shows what is not recorded and offers only a request", async () => {
	signIn();
	serve(SHARES);
	const { view } = show(appointment());
	expect(view.getByRole("heading", { name: "Eye check" })).toBeDefined();
	expect(view.getByText("Suggested · not booked")).toBeDefined();
	expect(facts(view)).toEqual({
		When: "Sun, 20 Oct 2030, 10:30 BST",
		"Time zone": "Europe/London",
		Clinician: "Not recorded",
		Where: "Not recorded",
		Transportation: "Not arranged",
		Reminders: "None",
		Symptoms: "None recorded",
		"Medicine questions or doubts": "None recorded",
		"Eating and sleep": "None recorded",
		"Questions for the clinician": "None recorded",
	});
	expect(view.getByText(/^Suggested by a family member · /)).toBeDefined();
	expect(view.getByText("Not requested")).toBeDefined();
	expect(view.getByText("No provider confirmation")).toBeDefined();
	expect(
		view.getAllByRole("button").map((button) => button.textContent),
	).toEqual([
		"Request this visit…",
		"Edit preparation…",
		"Cancel visit",
		"Prepare summary…",
	]);
	expect(
		await view.findByText("Visit summary and clinician updates"),
	).toBeDefined();
});

test("a booked visit shows its preparation, every step, and reminder times in the visit's zone", () => {
	signIn();
	serve(SHARES);
	const { view } = show(
		appointment({
			status: "confirmed",
			visit: {
				title: "Eye check",
				clinician: "Dr Lee",
				location: "Ward 4",
				startsAt: "2030-10-20T09:30:00.000Z",
				timeZone: "Europe/London",
			},
			prep: {
				transportation: "Bus 12",
				reminders: [1440, 120],
				symptoms: ["Tired", "Dizzy"],
				medication: [],
				eatingSleep: [],
				questions: ["Dose time?"],
			},
			suggestion: { by: ME, at: "2026-09-01T08:00:00.000Z", source: "model" },
			request: { by: ME, at: "2026-09-02T08:00:00.000Z" },
			confirmation: {
				by: ME,
				at: "2026-09-03T08:00:00.000Z",
				reference: "REF-9",
				receivedVia: "phone",
			},
		}),
	);
	expect(view.getByText("Booked · confirmed by the provider")).toBeDefined();
	const shown = facts(view);
	expect(shown.Clinician).toBe("Dr Lee");
	expect(shown.Where).toBe("Ward 4");
	expect(shown.Transportation).toBe("Bus 12");
	expect(shown.Reminders).toBe(
		"Sat, 19 Oct 2030, 10:30 BST; Sun, 20 Oct 2030, 08:30 BST",
	);
	expect(view.getByText("Tired")).toBeDefined();
	expect(view.getByText("Dizzy")).toBeDefined();
	expect(view.getByText("Dose time?")).toBeDefined();
	expect(view.getByText(/^Suggested by the assistant · /)).toBeDefined();
	expect(
		view.getByText(
			"Requested · Wed, 2 Sept 2026, 09:00 BST · simulated: nothing was sent to the provider",
		),
	).toBeDefined();
	expect(
		view.getByText(
			"Provider confirmed · reference REF-9 · by phone · recorded Thu, 3 Sept 2026, 09:00 BST",
		),
	).toBeDefined();
	expect(view.queryByRole("button", { name: /Request this visit/ })).toBeNull();
	expect(
		view.queryByRole("button", { name: /provider confirmation/ }),
	).toBeNull();
	expect(view.getByRole("button", { name: "Edit preparation…" })).toBeDefined();
});

test("a cancelled visit offers no actions and no clinician updates", () => {
	signIn();
	const calls = serve({});
	const { view } = show(
		appointment({
			status: "cancelled",
			cancellation: { by: ME, at: "2026-09-04T08:00:00.000Z" },
		}),
	);
	expect(view.getByText("Cancelled")).toBeDefined();
	expect(
		view.getByText("Cancelled · Fri, 4 Sept 2026, 09:00 BST"),
	).toBeDefined();
	expect(view.queryAllByRole("button")).toHaveLength(0);
	expect(view.queryByText("Visit summary and clinician updates")).toBeNull();
	expect(calls).toHaveLength(0);
});

test("a request needs explicit agreement, says nothing is sent, and closes once recorded", async () => {
	signIn();
	let finish: (reply: Reply) => void = () => {};
	const calls = serve({
		...SHARES,
		[`POST ${BASE}/request`]: () =>
			new Promise<Reply>((resolve) => {
				finish = resolve;
			}),
	});
	const { view } = show(appointment());
	fireEvent.click(view.getByRole("button", { name: "Request this visit…" }));
	const panel = within(view.getByRole("group", { name: "Request this visit" }));
	expect(panel.getByText(/nothing is sent to the provider/)).toBeDefined();
	const record = panel.getByRole("button", { name: "Record request" });
	expect(record.hasAttribute("disabled")).toBe(true);
	fireEvent.click(
		panel.getByLabelText(
			"I confirm this visit, time, and place should be requested.",
		),
	);
	expect(record.hasAttribute("disabled")).toBe(false);
	fireEvent.click(record);

	expect(await view.findByRole("status")).toBeDefined();
	expect(view.getByRole("status").textContent).toBe("Recording request…");
	expect(record.hasAttribute("disabled")).toBe(true);
	expect(
		view.getByRole("button", { name: "Cancel visit" }).hasAttribute("disabled"),
	).toBe(true);
	expect(calls.at(-1)).toEqual({
		method: "POST",
		path: `${BASE}/request`,
		body: { confirm: true },
	});

	await act(async () => finish({ status: 204 }));
	await waitFor(() => {
		if (view.queryByRole("group", { name: "Request this visit" }) !== null)
			throw new Error("request panel still open");
	});
	expect(view.queryByRole("status")).toBeNull();
});

test("the request names the clinician when one is recorded, and Close discards it", () => {
	signIn();
	serve(SHARES);
	const { view } = show(
		appointment({
			visit: {
				title: "Eye check",
				clinician: "Dr Lee",
				location: null,
				startsAt: "2030-10-20T09:30:00.000Z",
				timeZone: "Europe/London",
			},
		}),
	);
	fireEvent.click(view.getByRole("button", { name: "Request this visit…" }));
	const group = view.getByRole("group", { name: "Request this visit" });
	expect(within(group).getByText(/nothing is sent to Dr Lee/)).toBeDefined();
	fireEvent.click(within(group).getByRole("button", { name: "Close" }));
	expect(view.queryByRole("group", { name: "Request this visit" })).toBeNull();
});

test("a provider confirmation needs a reference; a refusal stays visible and keeps the form", async () => {
	signIn();
	const calls = serve({
		...SHARES,
		[`POST ${BASE}/confirmation`]: {
			status: 409,
			json: { error: "conflict", message: "Visit is not requested." },
		},
	});
	const { view } = show(
		appointment({
			status: "requested",
			request: { by: ME, at: "2026-09-02T08:00:00.000Z" },
		}),
	);
	expect(
		view.getByText("Requested · simulated, nothing sent · not booked"),
	).toBeDefined();
	fireEvent.click(
		view.getByRole("button", { name: "Record provider confirmation…" }),
	);
	const panel = within(
		view.getByRole("group", { name: "Provider confirmation" }),
	);
	const save = panel.getByRole("button", { name: "Save confirmation" });
	fireEvent.change(panel.getByLabelText("Reference"), {
		target: { value: "   " },
	});
	expect(save.hasAttribute("disabled")).toBe(true);
	fireEvent.change(panel.getByLabelText("Reference"), {
		target: { value: " REF-9 " },
	});
	fireEvent.change(panel.getByLabelText("Received by"), {
		target: { value: "portal" },
	});
	fireEvent.click(save);

	expect((await view.findByRole("alert")).textContent).toBe(
		"Visit is not requested.",
	);
	expect(calls.at(-1)).toEqual({
		method: "POST",
		path: `${BASE}/confirmation`,
		body: { reference: "REF-9", receivedVia: "portal" },
	});
	expect(
		view.getByRole("group", { name: "Provider confirmation" }),
	).toBeDefined();
});

test("preparation edits start from the recorded prep and save it whole", async () => {
	signIn();
	const calls = serve({ ...SHARES, [`PUT ${BASE}/prep`]: { status: 204 } });
	const { view } = show(
		appointment({
			prep: {
				transportation: "Bus 12",
				reminders: [120],
				symptoms: ["Tired"],
				medication: [],
				eatingSleep: [],
				questions: [],
			},
		}),
	);
	fireEvent.click(view.getByRole("button", { name: "Edit preparation…" }));
	const panel = within(view.getByRole("group", { name: "Preparation" }));
	expect(
		(panel.getByLabelText("Transportation") as HTMLInputElement).value,
	).toBe("Bus 12");
	expect(
		(panel.getByLabelText("Symptoms (one per line)") as HTMLTextAreaElement)
			.value,
	).toBe("Tired");
	fireEvent.click(panel.getByLabelText("1 day before"));
	fireEvent.change(
		panel.getByLabelText("Questions for the clinician (one per line)"),
		{
			target: { value: "Dose time?\n" },
		},
	);
	fireEvent.click(panel.getByRole("button", { name: "Save preparation" }));

	await waitFor(() => {
		if (view.queryByRole("group", { name: "Preparation" }) !== null)
			throw new Error("preparation panel still open");
	});
	expect(calls.at(-1)).toEqual({
		method: "PUT",
		path: `${BASE}/prep`,
		body: {
			transportation: "Bus 12",
			reminders: [1440, 120],
			symptoms: ["Tired"],
			medication: [],
			eatingSleep: [],
			questions: ["Dose time?"],
		},
	});
});

test("Cancel visit posts the cancellation", async () => {
	signIn();
	const calls = serve({ ...SHARES, [`POST ${BASE}/cancel`]: { status: 204 } });
	const { view } = show(appointment());
	fireEvent.click(view.getByRole("button", { name: "Cancel visit" }));
	await waitFor(() =>
		expect(
			calls.some(
				(call) => call.method === "POST" && call.path === `${BASE}/cancel`,
			),
		).toBe(true),
	);
});
