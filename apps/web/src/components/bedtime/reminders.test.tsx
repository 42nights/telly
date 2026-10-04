// First: registers Happy DOM before React DOM and the router load.
import "../test/dom-routed";

import { expect, test } from "bun:test";
import type {
	ReminderOccurrence,
	ReminderOccurrenceDetail,
} from "@health/contracts/reminders";

import {
	fireEvent,
	type Reply,
	render,
	renderRouted,
	serve,
	setupDom,
	signIn,
	waitFor,
} from "../test/dom-routed";
import { OvernightReminders } from "./reminders";

setupDom();

const BASE = "/api/families/7";
const HISTORY = `GET ${BASE}/reminder-occurrences`;
const SETTINGS = `GET ${BASE}/reminder-settings`;
const inMinutes = (minutes: number) =>
	new Date(Date.now() + minutes * 60_000).toISOString();

const occurrence = (
	id: string,
	change: Partial<ReminderOccurrence> = {},
): ReminderOccurrence => ({
	id,
	reminderId: "1",
	familyId: "7",
	kind: "medication",
	subjectId: null,
	title: `Synthetic reminder ${id}`,
	scheduledFor: inMinutes(60),
	state: "scheduled",
	promptDue: false,
	prompts: 0,
	nextPromptAt: inMinutes(60),
	...change,
});
const detail = (o: ReminderOccurrence): ReminderOccurrenceDetail => ({
	occurrence: o,
	events: [],
});
const history = (...occurrences: ReminderOccurrence[]): Reply => ({
	json: { occurrences: occurrences.map(detail) },
});
const noSettings: Reply = { json: { settings: null } };
const settings: Reply = {
	json: {
		settings: {
			timeZone: "America/New_York",
			quietHours: null,
			repeatEveryMinutes: 5,
			maxPrompts: 3,
			snoozeMinutes: 10,
		},
	},
};
const due = occurrence("3", {
	title: "Take the evening pill",
	promptDue: true,
	prompts: 1,
	nextPromptAt: inMinutes(-1),
});
const handoff = (outcome: string): Reply => ({
	json: {
		outcome,
		reason: outcome === "use_phone" ? "disabled" : null,
		announcement: outcome === "spoken" ? "Take the evening pill" : null,
		detail: detail(due),
	},
});
const noop = () => {};

test("without a family the screen asks to sign in", async () => {
	const { view } = await renderRouted(
		<OvernightReminders familyId={null} onPrompt={noop} />,
	);
	expect(await view.findByText("Sign in to see reminders.")).toBeDefined();
});

test("a failed read shows the problem, not an empty night", async () => {
	signIn();
	serve({
		[HISTORY]: {
			status: 503,
			json: { error: "unavailable", message: "Database down" },
		},
		[SETTINGS]: noSettings,
	});
	const view = render(<OvernightReminders familyId="7" onPrompt={noop} />);
	expect(await view.findByText("Database down")).toBeDefined();
	expect(view.queryByText(/nothing will wake you/)).toBeNull();
});

test("a quiet night says nothing will wake the wearer and that nobody calls 911", async () => {
	signIn();
	serve({ [HISTORY]: history(), [SETTINGS]: noSettings });
	const view = render(<OvernightReminders familyId="7" onPrompt={noop} />);
	expect(
		await view.findByText(
			"No saved reminder is due tonight, so nothing will wake you.",
		),
	).toBeDefined();
	expect(
		view.getByRole("button", {
			name: /Nobody calls 911 when a reminder goes unanswered\./,
		}),
	).toBeDefined();
	expect(view.queryByRole("alert")).toBeNull();
});

test("tonight's saved reminders list soonest first with the saved repeat routine", async () => {
	signIn();
	const brush = inMinutes(120);
	serve({
		[HISTORY]: history(
			occurrence("1", {
				title: "Brush teeth",
				scheduledFor: brush,
				nextPromptAt: brush,
			}),
			occurrence("2", {
				title: "Night pill",
				scheduledFor: inMinutes(10),
				nextPromptAt: inMinutes(30),
			}),
			occurrence("4", {
				title: "Tomorrow's walk",
				nextPromptAt: inMinutes(20 * 60),
			}),
		),
		[SETTINGS]: settings,
	});
	const view = render(<OvernightReminders familyId="7" onPrompt={noop} />);
	const items = await view.findAllByRole("listitem");
	expect(items.map((li) => li.textContent)).toEqual([
		expect.stringMatching(/Night pill · set for .*, held by quiet hours$/),
		expect.stringMatching(/Brush teeth$/),
	]);
	expect(
		await view.findByRole("button", {
			name: /I ask again every 5 minutes, up to 3 times\./,
		}),
	).toBeDefined();
});

test("a due prompt sounds once, hands off to the phone when the speaker cannot say it", async () => {
	signIn();
	const calls = serve({
		[HISTORY]: history(due),
		[SETTINGS]: noSettings,
		[`POST ${BASE}/reminder-occurrences/3/speaker-handoffs`]:
			handoff("use_phone"),
		[`POST ${BASE}/reminder-occurrences/3/deliveries`]: { json: detail(due) },
	});
	let prompts = 0;
	const onPrompt = () => {
		prompts++;
	};
	const view = render(<OvernightReminders familyId="7" onPrompt={onPrompt} />);
	const alert = await view.findByRole("alert");
	expect(alert.textContent).toContain("Take the evening pill");
	await waitFor(() =>
		expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(
			`POST ${BASE}/reminder-occurrences/3/deliveries`,
		),
	);
	expect(calls.find((c) => c.path.endsWith("/speaker-handoffs"))?.body).toEqual(
		{ clientId: "bedtime-3-1" },
	);
	expect(calls.find((c) => c.path.endsWith("/deliveries"))?.body).toEqual({
		clientId: "bedtime-3-1",
		source: "web",
	});
	// Each write (handoff, delivery) reads the same prompt again; it is not sounded twice.
	await waitFor(() =>
		expect(
			calls.filter((c) => c.path.endsWith("/reminder-occurrences")),
		).toHaveLength(3),
	);
	expect(prompts).toBe(1);
});

test("a prompt the speaker said is not recorded again by the phone", async () => {
	signIn();
	const calls = serve({
		[HISTORY]: history(due),
		[SETTINGS]: noSettings,
		[`POST ${BASE}/reminder-occurrences/3/speaker-handoffs`]: handoff("spoken"),
	});
	const view = render(<OvernightReminders familyId="7" onPrompt={noop} />);
	await view.findByRole("alert");
	await waitFor(() =>
		expect(
			calls.filter((c) => c.path.endsWith("/reminder-occurrences")),
		).toHaveLength(2),
	);
	expect(calls.some((c) => c.path.endsWith("/deliveries"))).toBe(false);
});

test("a failed speaker handoff still records the phone delivery", async () => {
	signIn();
	const calls = serve({
		[HISTORY]: history(due),
		[SETTINGS]: noSettings,
		[`POST ${BASE}/reminder-occurrences/3/speaker-handoffs`]: "network-error",
	});
	const view = render(<OvernightReminders familyId="7" onPrompt={noop} />);
	await view.findByRole("alert");
	await waitFor(() =>
		expect(calls.some((c) => c.path.endsWith("/deliveries"))).toBe(true),
	);
});

test("answering 'I did it' records it and says what was recorded", async () => {
	signIn();
	let answered = false;
	const shown = occurrence("3", {
		title: "Take the evening pill",
		state: "delivered",
		prompts: 1,
	});
	const done = occurrence("3", {
		title: "Take the evening pill",
		state: "self_reported_complete",
		nextPromptAt: null,
	});
	const calls = serve({
		[HISTORY]: () => (answered ? history(done) : history(shown)),
		[SETTINGS]: noSettings,
		[`POST ${BASE}/reminder-occurrences/3/answers`]: () => {
			answered = true;
			return { json: detail(done) };
		},
	});
	const view = render(<OvernightReminders familyId="7" onPrompt={noop} />);
	fireEvent.click(await view.findByRole("button", { name: "I did it" }));
	expect((await view.findByRole("status")).textContent).toBe(
		"Marked done, by you.",
	);
	// Throws a plain error: formatting a Happy DOM element on each retry is very slow.
	await waitFor(() => {
		if (view.queryByRole("alert") !== null) throw new Error("prompt shown");
	});
	expect(calls.find((c) => c.path.endsWith("/answers"))?.body).toEqual({
		clientId: expect.any(String),
		source: "web",
		response: "done",
		wording: null,
	});
	// A shown prompt is never delivered again from this screen.
	expect(calls.some((c) => c.path.endsWith("/deliveries"))).toBe(false);
});

test("an answer that leaves the prompt open says it will ask again", async () => {
	signIn();
	const shown = occurrence("3", { state: "delivered", prompts: 1 });
	const calls = serve({
		[HISTORY]: history(shown),
		[SETTINGS]: noSettings,
		[`POST ${BASE}/reminder-occurrences/3/answers`]: { json: detail(shown) },
	});
	const view = render(<OvernightReminders familyId="7" onPrompt={noop} />);
	fireEvent.click(await view.findByRole("button", { name: "Later" }));
	expect((await view.findByRole("status")).textContent).toBe(
		"Saved. I will ask again soon.",
	);
	expect(calls.find((c) => c.path.endsWith("/answers"))?.body).toMatchObject({
		response: "later",
	});
});

test("a refused answer shows why it was not saved; a lost session ends and asks to sign in", async () => {
	signIn();
	const shown = occurrence("3", { state: "delivered", prompts: 1 });
	let reply: Reply = {
		status: 409,
		json: { error: "conflict", message: "Prompts have ended" },
	};
	serve({
		[HISTORY]: history(shown),
		[SETTINGS]: noSettings,
		[`POST ${BASE}/reminder-occurrences/3/answers`]: () => reply,
	});
	const { view } = await renderRouted(
		<OvernightReminders familyId="7" onPrompt={noop} />,
	);
	fireEvent.click(await view.findByRole("button", { name: "I need help" }));
	expect(await view.findByText("Not saved: Prompts have ended")).toBeDefined();
	reply = { status: 401, json: { error: "unauthorized", message: "expired" } };
	fireEvent.click(view.getByRole("button", { name: "Okay, I see it" }));
	expect(await view.findByText("Sign in to see reminders.")).toBeDefined();
	expect(sessionStorage.getItem("telly.session.token")).toBeNull();
});
