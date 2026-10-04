import "../test/setup";

import { describe, expect, test } from "bun:test";
import type { CareProfile } from "@health/contracts/care-profile";
import {
	ReminderAnswerInput,
	type ReminderOccurrence,
} from "@health/contracts/reminders";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { Schema } from "effect";
import type { ReactNode } from "react";
import {
	type Call,
	fireEvent,
	installDom,
	render,
	type ServerReply,
	serve,
	waitFor,
} from "../test/dom";

import { MealCheckIn } from "./check-in";

installDom();

const NOW = Date.parse("2026-10-04T12:30:00Z");
const HISTORY = "GET /api/families/7/reminder-occurrences";
const PROFILE = "GET /api/families/7/care-profile";
const ANSWER = "POST /api/families/7/reminder-occurrences/1/answers";

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
	promptDue: true,
	prompts: 1,
	nextPromptAt: "2026-10-04T12:45:00.000Z",
	...o,
});

const history = (...os: ReminderOccurrence[]): ServerReply => ({
	json: { occurrences: os.map((o) => ({ occurrence: o, events: [] })) },
});

const profile = (p: Partial<CareProfile> = {}): ServerReply => ({
	json: {
		familyId: "7",
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
			...p,
		},
		editedBy: null,
		editedAt: null,
		history: [],
	},
});

const detail: ServerReply = { json: { occurrence: occurrence(), events: [] } };

/** Renders the check-in on `/` of an in-memory router that also has the `/cooking` page. */
const show = (onUrgent: (words: string) => void = () => {}) => {
	const root = createRootRoute();
	const page = (path: string, ui: ReactNode) =>
		createRoute({ getParentRoute: () => root, path, component: () => ui });
	const router = createRouter({
		routeTree: root.addChildren([
			page("/", <MealCheckIn familyId="7" now={NOW} onUrgent={onUrgent} />),
			page("/cooking", <p>Cooking guide</p>),
		]),
		history: createMemoryHistory(),
	});
	const view = render(<RouterProvider router={router} />);
	return { view, router };
};

const answers = (calls: Call[]) =>
	calls
		.filter((c) => `${c.method} ${c.path}` === ANSWER)
		.map((c) => Schema.decodeUnknownSync(ReminderAnswerInput)(c.body));

const said = (calls: Call[]) =>
	answers(calls).map(({ response, wording }) => ({ response, wording }));

describe("MealCheckIn", () => {
	test("a history that cannot be read says check-ins are not available", async () => {
		serve({ [HISTORY]: { status: 500 } });
		const { view } = show();
		expect((await view.findByRole("status")).textContent).toBe(
			"Meal and drink check-ins are not available right now.",
		);
	});

	test("shows nothing while loading and when no meal or drink is due", async () => {
		const reply = Promise.withResolvers<ServerReply>();
		const calls = serve({ [HISTORY]: () => reply.promise });
		const { view } = show();
		await waitFor(() => expect(calls.length).toBe(1));
		expect(view.container.textContent).toBe("");
		reply.resolve(history(occurrence({ kind: "medication" })));
		await Bun.sleep(20);
		expect(view.container.textContent).toBe("");
		expect(view.queryByRole("status")).toBeNull();
	});

	test("a due meal shows its title, meal answers, and the diet notes", async () => {
		serve({
			[HISTORY]: history(occurrence()),
			[PROFILE]: profile({
				dietaryRestrictions: ["low salt", "soft food"],
				allergies: [],
			}),
		});
		const { view } = show();
		expect(
			(await view.findByRole("heading", { name: "Lunch" })).textContent,
		).toBe("Lunch");
		expect(
			await view.findByText("Diet notes: low salt; soft food"),
		).toBeDefined();
		expect(view.getByText("Allergies: none")).toBeDefined();
		expect(view.getByRole("button", { name: "I ate" })).toBeDefined();
		expect(view.queryByText(/general water target/)).toBeNull();
	});

	test("a due drink shows drink answers, unknown fluid notes, and no water target", async () => {
		serve({
			[HISTORY]: history(occurrence({ kind: "hydration", title: "Water" })),
			[PROFILE]: profile(),
		});
		const { view } = show();
		expect(await view.findByText("Fluid notes: not known")).toBeDefined();
		expect(view.getByRole("button", { name: "I had a drink" })).toBeDefined();
		expect(
			view.getByText(
				"I follow only your agreed drink times, not a general water target.",
			),
		).toBeDefined();
	});

	test("notes that cannot be read say why", async () => {
		serve({
			[HISTORY]: history(occurrence()),
			[PROFILE]: {
				status: 403,
				body: { error: "forbidden", message: "No health records grant." },
			},
		});
		const { view } = show();
		expect(
			await view.findByText(
				"Your diet and fluid notes cannot be read: No health records grant.",
			),
		).toBeDefined();
	});

	test("notes rejected for the session end it, so check-ins are not available", async () => {
		const calls = serve({
			[HISTORY]: history(occurrence()),
			[PROFILE]: { status: 401 },
		});
		const { view } = show();
		expect((await view.findByRole("status")).textContent).toBe(
			"Meal and drink check-ins are not available right now.",
		);
		expect(
			calls.filter((c) => c.path.endsWith("/reminder-occurrences")).length,
		).toBe(1);
	});

	test("I ate records done, shows saving, then reads the history again", async () => {
		const reply = Promise.withResolvers<ServerReply>();
		const calls = serve({
			[HISTORY]: history(occurrence()),
			[PROFILE]: profile(),
			[ANSWER]: () => reply.promise,
		});
		const { view } = show();
		fireEvent.click(await view.findByRole("button", { name: "I ate" }));
		expect(await view.findByText("Saving…")).toBeDefined();
		expect(
			view.getByRole("button", { name: "Later" }).hasAttribute("disabled"),
		).toBe(true);
		const reads = calls.filter((c) => c.path.endsWith("/reminder-occurrences"));
		expect(reads.length).toBe(1);
		reply.resolve(detail);
		await waitFor(() =>
			expect(
				calls.filter((c) => c.path.endsWith("/reminder-occurrences")).length,
			).toBe(2),
		);
		await waitFor(() =>
			expect(view.queryByText("Saving…") === null).toBe(true),
		);
		const [sent] = answers(calls);
		expect(sent?.source).toBe("web");
		expect(sent?.response).toBe("done");
		expect(sent?.wording).toBeNull();
	});

	test("a failed answer shows why and a resend keeps the same answer id", async () => {
		let status = 503;
		const calls = serve({
			[HISTORY]: history(occurrence()),
			[PROFILE]: profile(),
			[ANSWER]: () =>
				status === 200
					? detail
					: {
							status,
							body: { error: "unavailable", message: "Database is down." },
						},
		});
		const { view } = show();
		const later = await view.findByRole("button", { name: "Later" });
		fireEvent.click(later);
		expect(await view.findByText("Not saved: Database is down.")).toBeDefined();
		status = 200;
		fireEvent.click(later);
		await waitFor(() =>
			expect(view.queryByText(/Not saved/) === null).toBe(true),
		);
		fireEvent.click(view.getByRole("button", { name: "Not this time" }));
		await waitFor(() => expect(answers(calls).length).toBe(3));
		const ids = answers(calls).map((a) => a.clientId);
		expect(ids[1]).toBe(ids[0]);
		expect(ids[2]).not.toBe(ids[0]);
		expect(said(calls).map((a) => a.response)).toEqual([
			"later",
			"later",
			"stop",
		]);
		status = 401;
		fireEvent.click(await view.findByRole("button", { name: "Later" }));
		expect(
			await view.findByText(
				"Meal and drink check-ins are not available right now.",
			),
		).toBeDefined();
		expect(answers(calls).length).toBe(4);
	});

	test("the wearer's typed words go with a direct answer", async () => {
		const calls = serve({
			[HISTORY]: history(occurrence()),
			[PROFILE]: profile(),
			[ANSWER]: detail,
		});
		const { view } = show();
		fireEvent.change(await view.findByRole("textbox"), {
			target: { value: "  had soup  " },
		});
		fireEvent.click(view.getByRole("button", { name: "Not this time" }));
		await waitFor(() =>
			expect(said(calls)).toEqual([{ response: "stop", wording: "had soup" }]),
		);
	});

	test("something in the way lists the barriers in drink words, and Back returns", async () => {
		serve({
			[HISTORY]: history(occurrence({ kind: "hydration" })),
			[PROFILE]: profile(),
		});
		const { view } = show();
		fireEvent.click(
			await view.findByRole("button", { name: "Something is in the way" }),
		);
		expect(view.getByText("What is in the way?")).toBeDefined();
		expect(view.getByRole("button", { name: "I'm not thirsty" })).toBeDefined();
		expect(
			view.getByRole("button", { name: "There is nothing to drink" }),
		).toBeDefined();
		expect(view.queryByRole("button", { name: "I had a drink" })).toBeNull();
		fireEvent.click(view.getByRole("button", { name: "Back" }));
		expect(view.getByRole("button", { name: "I had a drink" })).toBeDefined();
		expect(view.queryByText("What is in the way?")).toBeNull();
	});

	test("forgot: have it now records nothing; remind me later records later with the barrier", async () => {
		const calls = serve({
			[HISTORY]: history(occurrence()),
			[PROFILE]: profile(),
			[ANSWER]: detail,
		});
		const { view } = show();
		fireEvent.click(
			await view.findByRole("button", { name: "Something is in the way" }),
		);
		fireEvent.click(view.getByRole("button", { name: "I forgot" }));
		expect(view.getByText("I forgot", { selector: "b" })).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "I'll have it now" }));
		expect(view.getByRole("button", { name: "I ate" })).toBeDefined();
		expect(answers(calls)).toEqual([]);
		fireEvent.click(
			view.getByRole("button", { name: "Something is in the way" }),
		);
		fireEvent.click(view.getByRole("button", { name: "I forgot" }));
		fireEvent.click(view.getByRole("button", { name: "Remind me later" }));
		await waitFor(() =>
			expect(said(calls)).toEqual([{ response: "later", wording: "I forgot" }]),
		);
	});

	test("not hungry: skip records stop", async () => {
		const calls = serve({
			[HISTORY]: history(occurrence()),
			[PROFILE]: profile(),
			[ANSWER]: detail,
		});
		const { view } = show();
		fireEvent.click(
			await view.findByRole("button", { name: "Something is in the way" }),
		);
		fireEvent.click(view.getByRole("button", { name: "I'm not hungry" }));
		fireEvent.click(view.getByRole("button", { name: "Skip this one" }));
		await waitFor(() =>
			expect(said(calls)).toEqual([
				{ response: "stop", wording: "I'm not hungry" },
			]),
		);
	});

	test("unwell: help now opens the help path with the barrier and typed words, and records help", async () => {
		const urgent: string[] = [];
		const calls = serve({
			[HISTORY]: history(occurrence()),
			[PROFILE]: profile(),
			[ANSWER]: detail,
		});
		const { view } = show((words) => urgent.push(words));
		fireEvent.change(await view.findByRole("textbox"), {
			target: { value: "dizzy" },
		});
		fireEvent.click(
			view.getByRole("button", { name: "Something is in the way" }),
		);
		fireEvent.click(view.getByRole("button", { name: "I feel unwell" }));
		fireEvent.click(view.getByRole("button", { name: "I need help now" }));
		expect(urgent).toEqual(["I feel unwell: dizzy"]);
		await waitFor(() =>
			expect(said(calls)).toEqual([
				{ response: "help", wording: "I feel unwell: dizzy" },
			]),
		);
	});

	test("cannot make a meal: ask family records help without the help path", async () => {
		const urgent: string[] = [];
		const calls = serve({
			[HISTORY]: history(occurrence()),
			[PROFILE]: profile(),
			[ANSWER]: detail,
		});
		const { view } = show((words) => urgent.push(words));
		fireEvent.click(
			await view.findByRole("button", { name: "Something is in the way" }),
		);
		fireEvent.click(view.getByRole("button", { name: "I can't make it" }));
		fireEvent.click(
			view.getByRole("button", { name: "Ask family to help me make it" }),
		);
		await waitFor(() =>
			expect(said(calls)).toEqual([
				{ response: "help", wording: "I can't make it" },
			]),
		);
		expect(urgent).toEqual([]);
	});

	test("cannot make a meal: guide me opens the cooking page and records nothing", async () => {
		const calls = serve({
			[HISTORY]: history(occurrence()),
			[PROFILE]: profile(),
		});
		const { view, router } = show();
		fireEvent.click(
			await view.findByRole("button", { name: "Something is in the way" }),
		);
		fireEvent.click(view.getByRole("button", { name: "I can't make it" }));
		fireEvent.click(
			view.getByRole("button", { name: "Guide me one step at a time" }),
		);
		expect(await view.findByText("Cooking guide")).toBeDefined();
		expect(router.state.location.pathname).toBe("/cooking");
		expect(answers(calls)).toEqual([]);
	});

	test("typed urgent words open the help path at once and record help", async () => {
		const urgent: string[] = [];
		const calls = serve({
			[HISTORY]: history(occurrence()),
			[PROFILE]: profile(),
			[ANSWER]: detail,
		});
		const { view } = show((words) => urgent.push(words));
		const box = await view.findByRole("textbox");
		fireEvent.click(view.getByRole("button", { name: "Send" }));
		expect(urgent).toEqual([]);
		expect(answers(calls)).toEqual([]);
		fireEvent.change(box, { target: { value: "I'm choking" } });
		fireEvent.click(view.getByRole("button", { name: "Send" }));
		expect(urgent).toEqual(["I'm choking"]);
		await waitFor(() =>
			expect(said(calls)).toEqual([
				{ response: "help", wording: "I'm choking" },
			]),
		);
	});

	test("typed ordinary words ask what is in the way", async () => {
		const calls = serve({
			[HISTORY]: history(occurrence()),
			[PROFILE]: profile(),
		});
		const { view } = show();
		fireEvent.change(await view.findByRole("textbox"), {
			target: { value: "the soup is cold" },
		});
		fireEvent.click(view.getByRole("button", { name: "Send" }));
		expect(view.getByText("What is in the way?")).toBeDefined();
		expect(answers(calls)).toEqual([]);
	});
});
