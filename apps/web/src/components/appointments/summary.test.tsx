// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { expect, test } from "bun:test";
import type {
	Appointment,
	ClinicianShare,
	PrepSummary,
} from "@health/contracts/appointments";

import {
	fireEvent,
	type Reply,
	render,
	serve,
	setupDom,
	signIn,
	waitFor,
	within,
} from "../test/dom-routed";
import { SummaryPanel } from "./summary";

setupDom();

const ME = "a".repeat(64);
const BASE = "/api/families/f1/appointments/a1";
const NO_SHARES = { [`GET ${BASE}/shares`]: { json: { shares: [] } } };

const SUMMARY: PrepSummary = {
	labs: null,
	observations: null,
	symptoms: ["Tired", "Dizzy"],
	medication: [],
	eatingSleep: [],
	questions: ["Dose time?"],
};

const appointment = (summary: Appointment["summary"] = null): Appointment => ({
	id: "a1",
	familyId: "f1",
	status: "confirmed",
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
	summary,
});

const REVIEWED = appointment({
	by: ME,
	at: "2026-09-05T08:00:00.000Z",
	content: SUMMARY,
});

const share = (over: Partial<ClinicianShare> = {}): ClinicianShare => ({
	id: "s1",
	appointmentId: "a1",
	recipient: { name: "Dr Lee", role: null, address: "lee@clinic.test" },
	sections: ["labs", "symptoms"],
	consent: { kind: "explicit", frequency: "once" },
	approval: { by: ME, at: "2026-09-05T09:00:00.000Z" },
	revocation: null,
	delivery: "simulated",
	sends: 0,
	lastSentAt: null,
	nextSendAt: "2026-09-05T09:00:00.000Z",
	...over,
});

const show = (value: Appointment) => {
	let changes = 0;
	const view = render(
		<SummaryPanel
			appointment={value}
			base={BASE}
			onChanged={() => {
				changes += 1;
			}}
		/>,
	);
	return { view, changes: () => changes };
};

/** Each summary heading with the text under it. */
const sections = (root: HTMLElement) =>
	Object.fromEntries(
		Array.from(root.querySelectorAll("h4"), (heading) => [
			heading.textContent,
			heading.nextElementSibling?.textContent,
		]),
	);

test("an unreviewed summary is prepared, read, and marked reviewed; nothing can be shared before", async () => {
	signIn();
	const calls = serve({
		...NO_SHARES,
		[`GET ${BASE}/summary`]: { json: SUMMARY },
		[`POST ${BASE}/summary`]: { status: 204 },
	});
	const { view, changes } = show(appointment());
	expect(
		view.getByText("Summary not reviewed. Nothing can be shared yet."),
	).toBeDefined();
	expect(view.queryByText("Approve a clinician update")).toBeNull();

	fireEvent.click(view.getByRole("button", { name: "Prepare summary…" }));
	await view.findByRole("button", { name: "I reviewed this summary" });
	expect(sections(view.container)).toEqual({
		"Lab results":
			"Unavailable: no linked Finchnode records with granted access.",
		Observations: "Unavailable: no reviewed lab report.",
		Symptoms: "Tired; Dizzy",
		"Medicine questions or doubts": "None recorded",
		"Eating and sleep": "None recorded",
		"Questions for the clinician": "Dose time?",
	});

	fireEvent.click(
		view.getByRole("button", { name: "I reviewed this summary" }),
	);
	await view.findByRole("button", { name: "Prepare summary…" });
	expect(calls.find((call) => call.method === "POST")).toEqual({
		method: "POST",
		path: `${BASE}/summary`,
		body: SUMMARY,
	});
	expect(changes()).toBe(1);
	await waitFor(() =>
		expect(calls.filter((call) => call.path === `${BASE}/shares`)).toHaveLength(
			2,
		),
	);
});

test("dated labs and report markers show their values, gaps, and sources; Close discards the draft", async () => {
	signIn();
	const lab = {
		unit: null,
		status: null,
		referenceRange: null,
		interpretation: null,
		sourceRecordId: null,
		codes: [],
		sourceUpdatedAt: null,
		syncedAt: null,
	};
	serve({
		...NO_SHARES,
		[`GET ${BASE}/summary`]: {
			json: {
				...SUMMARY,
				labs: [
					{
						...lab,
						id: "l1",
						name: "HbA1c",
						value: 48,
						unit: "mmol/mol",
						date: "2026-08-01",
						source: "lab-co",
						sourceName: "Lab Co",
					},
					{
						...lab,
						id: "l2",
						name: "Ferritin",
						value: null,
						date: null,
						source: "clinic",
						sourceName: null,
					},
					{
						...lab,
						id: "l3",
						name: "B12",
						value: "low",
						date: null,
						source: null,
						sourceName: null,
					},
				],
				observations: {
					reportId: "r1",
					reviewedAt: "2026-08-02T08:00:00.000Z",
					markers: [
						{ metric: "steps", sample: null },
						{
							metric: "heart_rate",
							sample: {
								id: "h1",
								familyId: "f1",
								metric: "heart_rate",
								value: 62,
								unit: "bpm",
								sourceTime: "2026-08-01T07:00:00.000Z",
								receivedAt: "2026-08-01T07:00:05.000Z",
								source: "watch",
								synthetic: true,
								quality: "validated",
							},
						},
					],
				},
			},
		},
	});
	const { view } = show(appointment());
	fireEvent.click(view.getByRole("button", { name: "Prepare summary…" }));
	await view.findByText(/^HbA1c:/);
	expect(view.getAllByRole("listitem").map((item) => item.textContent)).toEqual(
		[
			"HbA1c: 48 mmol/mol · 2026-08-01 · Lab Co",
			"Ferritin: no value  · undated · clinic",
			"B12: low  · undated · source unknown",
			"Steps: unavailable",
			"Heart rate: 62 bpm · 2026-08-01T07:00:00.000Z",
		],
	);

	fireEvent.click(view.getByRole("button", { name: "Close" }));
	expect(view.queryByText(/^HbA1c:/)).toBeNull();
	expect(view.getByRole("button", { name: "Prepare summary…" })).toBeDefined();
});

test("a summary the server cannot prepare shows why and keeps the prepare button", async () => {
	signIn();
	serve({
		...NO_SHARES,
		[`GET ${BASE}/summary`]: {
			status: 503,
			json: { error: "unavailable", message: "Records are offline." },
		},
	});
	const { view } = show(appointment());
	fireEvent.click(view.getByRole("button", { name: "Prepare summary…" }));
	expect((await view.findByRole("alert")).textContent).toBe(
		"Records are offline.",
	);
	expect(view.getByRole("button", { name: "Prepare summary…" })).toBeDefined();
});

test("a reviewed summary stays readable and a new one can be prepared", async () => {
	signIn();
	serve({ ...NO_SHARES, [`GET ${BASE}/summary`]: { json: SUMMARY } });
	const { view } = show(REVIEWED);
	expect(
		view.getByText("Summary reviewed Sat, 5 Sept 2026, 09:00 BST."),
	).toBeDefined();
	const details = view.getByText("Show the reviewed summary")
		.parentElement as HTMLElement;
	expect(sections(details).Symptoms).toBe("Tired; Dizzy");
	expect(view.getByText("Approve a clinician update")).toBeDefined();

	fireEvent.click(view.getByRole("button", { name: "Prepare a new summary…" }));
	await view.findByRole("button", { name: "I reviewed this summary" });
	expect(view.queryByText("Show the reviewed summary")).toBeNull();
});

test("each consent shows its recipient, sections, sends, and whether a send is allowed now", async () => {
	signIn();
	serve({
		[`GET ${BASE}/shares`]: {
			json: {
				shares: [
					share(),
					share({
						id: "s2",
						recipient: {
							name: "Ann",
							role: "GP",
							address: "ann@clinic.test",
						},
						sections: ["observations"],
						consent: { kind: "standing", frequency: "weekly" },
						sends: 2,
						lastSentAt: "2026-09-06T08:00:00.000Z",
						nextSendAt: "2099-01-01T12:00:00.000Z",
					}),
					share({
						id: "s3",
						consent: { kind: "standing", frequency: "monthly" },
						sections: ["medication", "eatingSleep", "questions"],
						revocation: { by: ME, at: "2026-09-07T08:00:00.000Z" },
					}),
				],
			},
		},
	});
	const { view } = show(appointment());
	const [first, second, third] = await view.findAllByRole("listitem");
	const once = within(first as HTMLElement);
	expect(once.getByText("To Dr Lee · lee@clinic.test")).toBeDefined();
	expect(
		once.getByText(
			"Once: I approve one send of this summary as reviewed · sections: Dated lab results, Symptoms",
		),
	).toBeDefined();
	expect(once.getByText("Not sent")).toBeDefined();
	expect(
		once
			.getByRole("button", { name: "Send (simulated)" })
			.hasAttribute("disabled"),
	).toBe(false);

	const weekly = within(second as HTMLElement);
	expect(weekly.getByText("To Ann (GP) · ann@clinic.test")).toBeDefined();
	expect(
		weekly.getByText(
			"Standing: the latest reviewed summary, at most weekly · sections: Observations from the reviewed lab report",
		),
	).toBeDefined();
	expect(
		weekly.getByText(
			"Sent 2× (simulated) · last Sun, 6 Sept 2026, 09:00 BST · not known to be read · next allowed Thu, 1 Jan 2099, 12:00 GMT",
		),
	).toBeDefined();
	expect(
		weekly
			.getByRole("button", { name: "Send (simulated)" })
			.hasAttribute("disabled"),
	).toBe(true);

	const revoked = within(third as HTMLElement);
	expect(
		revoked.getByText(
			"Standing: the latest reviewed summary, at most monthly · sections: Medicine questions or doubts, Eating and sleep, Questions for the clinician",
		),
	).toBeDefined();
	expect(revoked.getByText("Revoked")).toBeDefined();
	expect(revoked.queryAllByRole("button")).toHaveLength(0);
});

test("a simulated send shows progress, then reloads the consents and the screen", async () => {
	signIn();
	let finish: (reply: Reply) => void = () => {};
	const calls = serve({
		[`GET ${BASE}/shares`]: { json: { shares: [share({ id: "s 1" })] } },
		[`POST ${BASE}/shares/s%201/send`]: () =>
			new Promise<Reply>((resolve) => {
				finish = resolve;
			}),
	});
	const { view, changes } = show(appointment());
	fireEvent.click(
		await view.findByRole("button", { name: "Send (simulated)" }),
	);
	expect((await view.findByRole("status")).textContent).toBe(
		"Sending (simulated)…",
	);
	expect(
		view
			.getByRole("button", { name: "Revoke consent" })
			.hasAttribute("disabled"),
	).toBe(true);
	finish({ status: 204 });
	// The send reports the change, then reads the consents again.
	await waitFor(() => {
		expect(changes()).toBe(1);
		expect(calls.filter((call) => call.path === `${BASE}/shares`)).toHaveLength(
			2,
		);
	});
	expect(view.queryByRole("status")).toBeNull();
});

test("a refused revoke stays visible and the screen is not reloaded", async () => {
	signIn();
	const calls = serve({
		[`GET ${BASE}/shares`]: { json: { shares: [share()] } },
		[`POST ${BASE}/shares/s1/revoke`]: {
			status: 403,
			json: { error: "forbidden", message: "Only the approver can revoke." },
		},
	});
	const { view, changes } = show(appointment());
	fireEvent.click(await view.findByRole("button", { name: "Revoke consent" }));
	expect((await view.findByRole("alert")).textContent).toBe(
		"Only the approver can revoke.",
	);
	expect(calls.at(-1)?.path).toBe(`${BASE}/shares/s1/revoke`);
	expect(changes()).toBe(0);
});

test("consents that cannot be read say so", async () => {
	signIn();
	serve({
		[`GET ${BASE}/shares`]: {
			status: 503,
			json: { error: "unavailable", message: "Database is down." },
		},
	});
	const { view } = show(appointment());
	expect((await view.findByRole("alert")).textContent).toBe(
		"Updates unavailable: Database is down.",
	);
});

test("approving an update needs a recipient, a section, and explicit agreement", async () => {
	signIn();
	const calls = serve({
		...NO_SHARES,
		[`POST ${BASE}/shares`]: { status: 201, json: {} },
	});
	const { view, changes } = show(REVIEWED);
	const form = within(
		view.getByRole("group", { name: "Approve a clinician update" }),
	);
	const approve = form.getByRole("button", { name: "Approve update" });
	const agree = form.getByLabelText(
		"I approve sending the chosen sections to this recipient at this frequency.",
	) as HTMLInputElement;
	fireEvent.change(form.getByLabelText("Recipient name"), {
		target: { value: " Dr Lee " },
	});
	fireEvent.change(form.getByLabelText("Role (optional)"), {
		target: { value: " " },
	});
	fireEvent.change(form.getByLabelText("Email or address"), {
		target: { value: "lee@clinic.test" },
	});
	fireEvent.click(agree);
	expect(approve.hasAttribute("disabled")).toBe(true);
	fireEvent.click(form.getByLabelText("Dated lab results"));
	fireEvent.click(form.getByLabelText("Symptoms"));
	fireEvent.click(form.getByLabelText("Dated lab results"));
	fireEvent.change(form.getByLabelText("Delivery frequency"), {
		target: { value: "weekly" },
	});
	expect(approve.hasAttribute("disabled")).toBe(false);
	fireEvent.click(approve);

	await waitFor(() => expect(changes()).toBe(1));
	expect(calls.find((call) => call.method === "POST")?.body).toEqual({
		recipient: { name: "Dr Lee", role: null, address: "lee@clinic.test" },
		sections: ["symptoms"],
		consent: { kind: "standing", frequency: "weekly" },
	});
	expect(agree.checked).toBe(false);
	expect((form.getByLabelText("Symptoms") as HTMLInputElement).checked).toBe(
		false,
	);
	expect(
		(form.getByLabelText("Recipient name") as HTMLInputElement).value,
	).toBe(" Dr Lee ");
	expect(approve.hasAttribute("disabled")).toBe(true);
});

test("a refused approval keeps the choices so the member can retry", async () => {
	signIn();
	serve({
		...NO_SHARES,
		[`POST ${BASE}/shares`]: {
			status: 403,
			json: { error: "forbidden", message: "No clinician access." },
		},
	});
	const { view } = show(REVIEWED);
	const form = within(
		view.getByRole("group", { name: "Approve a clinician update" }),
	);
	fireEvent.change(form.getByLabelText("Recipient name"), {
		target: { value: "Dr Lee" },
	});
	fireEvent.change(form.getByLabelText("Email or address"), {
		target: { value: "lee@clinic.test" },
	});
	fireEvent.click(form.getByLabelText("Questions for the clinician"));
	fireEvent.click(
		form.getByLabelText(
			"I approve sending the chosen sections to this recipient at this frequency.",
		),
	);
	fireEvent.click(form.getByRole("button", { name: "Approve update" }));
	expect((await view.findByRole("alert")).textContent).toBe(
		"No clinician access.",
	);
	expect(
		(form.getByLabelText("Questions for the clinician") as HTMLInputElement)
			.checked,
	).toBe(true);
});
