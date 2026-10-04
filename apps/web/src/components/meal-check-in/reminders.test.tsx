import "../test/setup";

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Reminder, ReminderEvent } from "@health/contracts/reminders";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	fireEvent,
	installDom,
	type Routes,
	render,
	serve,
	waitFor,
	within,
} from "../test/dom";

import { MealReminders } from "./reminders";

installDom();

const HISTORY = "/api/families/7/reminder-occurrences";
const REMINDERS = "/api/families/7/reminders";
const SETTINGS = "/api/families/7/reminder-settings";
const ZONE = "UTC";

const reminder = (r: Partial<Reminder> = {}): Reminder => ({
	id: "9",
	familyId: "7",
	kind: "meal",
	subjectId: null,
	title: "Lunch",
	times: ["12:00"],
	createdBy: "a",
	createdAt: "2026-10-01T12:00:00.000Z",
	...r,
});

const settings = {
	timeZone: ZONE,
	quietHours: null,
	repeatEveryMinutes: 10,
	maxPrompts: 3,
	snoozeMinutes: 15,
};

/** The three reads: the given reminders, saved settings, and no history. */
const reads = (reminders: readonly Reminder[], saved: unknown = settings) => ({
	[`GET ${REMINDERS}`]: { json: { reminders } },
	[`GET ${SETTINGS}`]: { json: { settings: saved } },
	[`GET ${HISTORY}`]: { json: { occurrences: [] } },
});

/** `ApiNotice` links to Sign in, so the tab renders inside an in-memory router. */
const show = (routes: Routes) => {
	const calls = serve(routes);
	const view = render(
		<RouterProvider
			router={createRouter({
				routeTree: createRootRoute({
					component: () => <MealReminders familyId="7" />,
				}),
				history: createMemoryHistory(),
			})}
		/>,
	);
	return { view, writes: () => calls.filter((c) => c.method !== "GET") };
};

const added = (r: Partial<Reminder>) => ({
	json: reminder({ id: "10", ...r }),
});

describe("MealReminders", () => {
	afterEach(() => setSystemTime());

	test("lists each meal and drink reminder with its times, and no other kind", async () => {
		const { view } = show(
			reads([
				reminder(),
				reminder({
					id: "8",
					kind: "hydration",
					title: "Drink water",
					times: ["10:00", "15:00"],
				}),
				reminder({ id: "7", kind: "medication", title: "Pills" }),
			]),
		);
		const list = await view.findByRole("list", { name: "Reminders" });
		expect(
			within(list)
				.getAllByRole("listitem")
				.map((li) => li.querySelector("span")?.textContent),
		).toEqual(["Lunch · 12:00", "Drink water · 10:00, 15:00"]);
		expect(view.queryByText(/Pills/)).toBeNull();
	});

	test("a check marks today's time the person answered DONE", async () => {
		setSystemTime(new Date("2026-10-04T15:00:00Z"));
		const occurrence = (id: string, scheduledFor: string) => ({
			id,
			reminderId: "8",
			familyId: "7",
			kind: "hydration",
			subjectId: null,
			title: "Drink water",
			scheduledFor,
			state: "self_reported_complete",
			promptDue: false,
			prompts: 1,
			nextPromptAt: null,
		});
		const done = (occurrenceId: string): ReminderEvent => ({
			id: occurrenceId,
			occurrenceId,
			state: "self_reported_complete",
			response: null,
			at: "2026-10-04T10:05:00.000Z",
			actor: "wearer",
			source: "imessage",
			wording: "DONE",
		});
		const { view } = show({
			...reads([
				reminder({
					id: "8",
					kind: "hydration",
					title: "Drink water",
					times: ["10:00", "15:00"],
				}),
			]),
			[`GET ${HISTORY}`]: {
				json: {
					occurrences: [
						// Today at 10:00, answered DONE.
						{
							occurrence: occurrence("1", "2026-10-04T10:00:00.000Z"),
							events: [done("1")],
						},
						// Yesterday at 15:00, answered DONE: not today, so no check.
						{
							occurrence: occurrence("2", "2026-10-03T15:00:00.000Z"),
							events: [done("2")],
						},
					],
				},
			},
		});
		expect(
			(await view.findByRole("img", { name: "Done at 10:00" })).getAttribute(
				"aria-label",
			),
		).toBe("Done at 10:00");
		expect(view.queryByRole("img", { name: "Done at 15:00" })).toBeNull();
	});

	test("adding the first reminder saves this browser's time zone, then the reminder", async () => {
		const { view, writes } = show({
			...reads([], null),
			[`PUT ${SETTINGS}`]: { status: 204 },
			[`POST ${REMINDERS}`]: added({
				kind: "hydration",
				title: "Drink water",
				times: ["09:00", "15:30"],
			}),
		});
		const add = await view.findByRole("button", { name: "Add reminder" });
		await waitFor(() =>
			expect((add as HTMLButtonElement).disabled).toBe(false),
		);
		fireEvent.click(add);
		const form = await view.findByRole("form", { name: "Add reminder" });
		fireEvent.change(within(form).getByLabelText("What"), {
			target: { value: " Drink water " },
		});
		fireEvent.change(within(form).getByLabelText("Kind"), {
			target: { value: "hydration" },
		});
		fireEvent.change(within(form).getByLabelText("Time 1"), {
			target: { value: "15:30" },
		});
		fireEvent.click(within(form).getByRole("button", { name: "Add a time" }));
		fireEvent.change(within(form).getByLabelText("Time 2"), {
			target: { value: "09:00" },
		});
		fireEvent.submit(form);

		// Compare to null: a failed `toBeNull()` on a DOM node formats the whole tree and stalls.
		await waitFor(() =>
			expect(view.queryByRole("form", { name: "Add reminder" }) === null).toBe(
				true,
			),
		);
		expect(writes()).toEqual([
			{
				method: "PUT",
				path: SETTINGS,
				body: {
					...settings,
					timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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

	test("editing adds the changed reminder, then deletes the old one", async () => {
		const { view, writes } = show({
			...reads([reminder()]),
			[`POST ${REMINDERS}`]: added({ title: "Late lunch", times: ["13:00"] }),
			[`DELETE ${REMINDERS}/9`]: { status: 204 },
		});
		fireEvent.click(await view.findByRole("button", { name: "Edit Lunch" }));
		const form = await view.findByRole("form", { name: "Edit reminder" });
		expect(
			(within(form).getByLabelText("What") as HTMLInputElement).value,
		).toBe("Lunch");
		fireEvent.change(within(form).getByLabelText("What"), {
			target: { value: "Late lunch" },
		});
		fireEvent.change(within(form).getByLabelText("Time 1"), {
			target: { value: "13:00" },
		});
		fireEvent.submit(form);

		await waitFor(() =>
			expect(view.queryByRole("form", { name: "Edit reminder" }) === null).toBe(
				true,
			),
		);
		expect(writes()).toEqual([
			{
				method: "POST",
				path: REMINDERS,
				body: {
					kind: "meal",
					subjectId: null,
					title: "Late lunch",
					times: ["13:00"],
				},
			},
			{ method: "DELETE", path: `${REMINDERS}/9`, body: undefined },
		]);
	});

	test("a failed save keeps the dialog open with the server's message, and deletes nothing", async () => {
		const { view, writes } = show({
			...reads([reminder()]),
			[`POST ${REMINDERS}`]: {
				status: 500,
				body: { error: "internal", message: "Bad time." },
			},
		});
		fireEvent.click(await view.findByRole("button", { name: "Edit Lunch" }));
		const form = await view.findByRole("form", { name: "Edit reminder" });
		fireEvent.submit(form);
		expect((await within(form).findByRole("alert")).textContent).toContain(
			"Bad time.",
		);
		expect(writes().map((w) => w.method)).toEqual(["POST"]);
	});

	test("Delete removes the reminder", async () => {
		const { view, writes } = show({
			...reads([reminder()]),
			[`DELETE ${REMINDERS}/9`]: { status: 204 },
		});
		fireEvent.click(await view.findByRole("button", { name: "Delete Lunch" }));
		await waitFor(() => expect(writes().length).toBe(1));
		expect(writes()).toEqual([
			{ method: "DELETE", path: `${REMINDERS}/9`, body: undefined },
		]);
	});

	test("signed out links to Sign in", async () => {
		const { view } = show({
			[`GET ${REMINDERS}`]: { status: 401 },
			[`GET ${SETTINGS}`]: { status: 401 },
			[`GET ${HISTORY}`]: { status: 401 },
		});
		expect(
			(await view.findAllByRole("link", { name: "Go to Sign in" })).length,
		).toBeGreaterThan(0);
	});
});
