import "../test/setup";

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import type {
	ReminderEvent,
	ReminderOccurrence,
} from "@health/contracts/reminders";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	fireEvent,
	installDom,
	render,
	type ServerReply,
	serve,
	waitFor,
	within,
} from "../test/dom";

import { MealReminders, MealStatusSection } from "./family-status";

installDom();

const HISTORY = "GET /api/families/7/reminder-occurrences";
const REMINDERS = "/api/families/7/reminders";
const SETTINGS = "/api/families/7/reminder-settings";
// The reminder list's reads: no reminders and no saved settings yet.
const EDITOR = {
	[`GET ${REMINDERS}`]: { json: { reminders: [] } },
	[`GET ${SETTINGS}`]: { json: { settings: null } },
};

const occurrence = (
	o: Partial<ReminderOccurrence> = {},
): ReminderOccurrence => ({
	id: "1",
	reminderId: "9",
	familyId: "7",
	kind: "meal",
	subjectId: null,
	title: "Lunch",
	scheduledFor: "2026-10-04T12:00:00.000Z",
	state: "scheduled",
	promptDue: false,
	prompts: 0,
	nextPromptAt: null,
	...o,
});

const event = (e: Partial<ReminderEvent>): ReminderEvent => ({
	id: "1",
	occurrenceId: "1",
	state: "scheduled",
	response: null,
	at: "2026-10-04T12:00:00.000Z",
	actor: "scheduler",
	source: "scheduler",
	wording: null,
	...e,
});

const history = (
	...rows: (readonly [ReminderOccurrence, readonly ReminderEvent[]])[]
): ServerReply => ({
	json: {
		occurrences: rows.map(([o, events]) => ({ occurrence: o, events })),
	},
});

/** `ApiNotice` links to Sign in, so each part renders inside an in-memory router. */
const show = (part = <MealStatusSection familyId="7" />) =>
	render(
		<RouterProvider
			router={createRouter({
				routeTree: createRootRoute({ component: () => part }),
				history: createMemoryHistory(),
			})}
		/>,
	);

describe("MealStatusSection", () => {
	beforeEach(() => setSystemTime(new Date("2026-10-04T12:30:00Z")));
	afterEach(() => setSystemTime());

	test("waits for the server while the history loads", async () => {
		serve({
			[HISTORY]: () => Promise.withResolvers<ServerReply>().promise,
		});
		const view = show();
		expect(
			(await view.findByRole("heading", { name: "Meals and drinks" }))
				.textContent,
		).toBe("Meals and drinks");
		expect(view.getByRole("status").textContent).toContain(
			"Waiting for the server.",
		);
	});

	test("a failed read shows the failure, not an empty list", async () => {
		serve({
			[HISTORY]: { status: 500, body: { error: "internal", message: "Boom." } },
		});
		const view = show();
		const alert = await view.findByRole("alert");
		expect(alert.textContent).toContain("Could not load meal check-ins");
		expect(alert.textContent).toContain("Boom.");
		expect(view.queryByText(/has come due/)).toBeNull();
	});

	test("signed out links to Sign in", async () => {
		serve({
			[HISTORY]: { status: 401 },
		});
		const view = show();
		expect(
			(await view.findAllByRole("link", { name: "Go to Sign in" })).length,
		).toBeGreaterThan(0);
	});

	test("with no meal or drink check-in due, the section is hidden", async () => {
		serve({
			[HISTORY]: history(
				[occurrence({ scheduledFor: "2026-10-04T13:00:00.000Z" }), []],
				[occurrence({ id: "2", kind: "medication", title: "Pills" }), []],
			),
		});
		const view = show();
		await view.findByText("Loading meal check-ins…");
		await waitFor(() => expect(view.container.textContent).toBe(""));
	});

	test("each due check-in shows shown, self-report, and unresolved as separate facts", async () => {
		serve({
			[HISTORY]: history(
				[
					occurrence({ title: "Lunch" }),
					[
						event({
							id: "1",
							state: "delivered",
							at: "2026-10-04T12:01:00.000Z",
						}),
						event({
							id: "2",
							state: "unresolved",
							at: "2026-10-04T12:20:00.000Z",
						}),
						event({
							id: "3",
							state: "self_reported_complete",
							at: "2026-10-04T12:25:00.000Z",
							wording: "had soup",
						}),
					],
				],
				[
					occurrence({ id: "2", kind: "hydration", title: "Water" }),
					[event({ id: "4", occurrenceId: "2", state: "caregiver_confirmed" })],
				],
			),
		});
		const view = show();
		const [lunch, water] = await view.findAllByRole("article");
		if (lunch === undefined || water === undefined) throw new Error("two");
		expect(
			view.getByRole("button", { name: /is the person's own report/ }),
		).toBeDefined();
		const facts = (article: HTMLElement) =>
			within(article)
				.getAllByRole("listitem")
				.map((li) => li.textContent?.split(" · ")[0]);
		expect(facts(lunch)).toEqual([
			"Shown on a device: yes",
			"Says they did: yes",
			"Unresolved: yes",
			"Their words: “had soup”",
		]);
		expect(
			within(lunch)
				.getAllByRole("listitem")
				.map((li) => li.querySelector("time")?.getAttribute("dateTime")),
		).toEqual([
			"2026-10-04T12:01:00.000Z",
			"2026-10-04T12:25:00.000Z",
			"2026-10-04T12:20:00.000Z",
			undefined,
		]);
		expect(facts(water)).toEqual([
			"Shown on a device: no",
			"Says they did: no",
			"Confirmed by a caregiver: yes",
			"Unresolved: no",
		]);
		expect(
			within(water).getByRole("heading").querySelector("time")?.dateTime,
		).toBe("2026-10-04T12:00:00.000Z");
	});

	test("shows at most six due check-ins", async () => {
		serve({
			[HISTORY]: history(
				...Array.from(
					{ length: 8 },
					(_, i) =>
						[occurrence({ id: String(i), title: `Meal ${i}` }), []] as const,
				),
			),
		});
		const view = show();
		await view.findByText("Meal 0", { exact: false });
		expect(
			view
				.getAllByRole("article")
				.map((a) => a.querySelector("h4")?.firstChild?.textContent),
		).toEqual(["Meal 0", "Meal 1", "Meal 2", "Meal 3", "Meal 4", "Meal 5"]);
	});
});

describe("MealReminders", () => {
	test("Add opens a dialog; saving stores this browser's time zone first, then the reminder", async () => {
		const calls = serve({
			...EDITOR,
			[`PUT ${SETTINGS}`]: { status: 204 },
			[`POST ${REMINDERS}`]: {
				json: {
					id: "5",
					familyId: "7",
					kind: "hydration",
					subjectId: null,
					title: "Drink water",
					times: ["09:00", "15:30"],
					createdBy: "a",
					createdAt: "2026-10-04T12:00:00.000Z",
				},
			},
		});
		const view = show(<MealReminders familyId="7" />);
		expect(
			await view.findByText("No meal or drink reminder yet."),
		).toBeDefined();
		const add = view.getByRole("button", { name: "Add" });
		await waitFor(() => expect(add.hasAttribute("disabled")).toBe(false));
		fireEvent.click(add);
		const dialog = view.getByRole("dialog", { hidden: true });
		expect(dialog.hasAttribute("open")).toBe(true);
		const form = within(dialog).getByRole("form", {
			name: "Add a meal or drink reminder",
		});
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		expect(
			within(form).getByRole("button", {
				name: `Uses this browser's time zone, ${zone}.`,
			}),
		).toBeDefined();
		fireEvent.change(within(form).getByLabelText("What"), {
			target: { value: " Drink water " },
		});
		fireEvent.change(within(form).getByLabelText("Kind"), {
			target: { value: "hydration" },
		});
		fireEvent.change(within(form).getByLabelText("Time 1"), {
			target: { value: "15:30" },
		});
		fireEvent.click(
			within(form).getByRole("button", { name: "Add another time" }),
		);
		fireEvent.change(within(form).getByLabelText("Time 2"), {
			target: { value: "09:00" },
		});
		fireEvent.submit(form);

		expect((await view.findByText("Saved: Drink water.")).textContent).toBe(
			"Saved: Drink water.",
		);
		expect(dialog.hasAttribute("open")).toBe(false);

		const writes = calls.filter((c) => c.method !== "GET");
		expect(writes).toEqual([
			{
				method: "PUT",
				path: SETTINGS,
				body: {
					timeZone: zone,
					quietHours: null,
					repeatEveryMinutes: 10,
					maxPrompts: 3,
					snoozeMinutes: 15,
				},
			},
			{
				method: "POST",
				path: REMINDERS,
				body: {
					kind: "hydration",
					subjectId: null,
					title: "Drink water",
					times: ["09:00", "15:30"],
				},
			},
		]);
	});
});
