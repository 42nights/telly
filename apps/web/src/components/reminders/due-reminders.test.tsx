import "../test/setup";

import { describe, expect, test } from "bun:test";
import type {
	ReminderEvent,
	ReminderOccurrence,
	ReminderOccurrenceDetail,
} from "@health/contracts/reminders";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
	fireEvent,
	installDom,
	render,
	type ServerReply,
	serve,
	waitFor,
} from "../test/dom";

import { DueReminders } from "./due-reminders";

installDom();

/** A 401 ends the session and `ApiNotice` links to Sign in, so it needs a router. */
const inRouter = (ui: ReactNode) => {
	const router = createRouter({
		routeTree: createRootRoute({ component: () => ui }),
		history: createMemoryHistory(),
	});
	return render(<RouterProvider router={router} />);
};

const BASE = "/api/families/7/reminder-occurrences";
const LIST = `GET ${BASE}`;

const event = (patch: Partial<ReminderEvent> = {}): ReminderEvent => ({
	id: "1",
	occurrenceId: "3",
	state: "scheduled",
	response: null,
	at: "2026-01-01T08:00:00.000Z",
	actor: "scheduler",
	source: "scheduler",
	wording: null,
	...patch,
});

const detail = (
	patch: Partial<ReminderOccurrence> = {},
	events: ReminderEvent[] = [event()],
): ReminderOccurrenceDetail => ({
	occurrence: {
		id: "3",
		reminderId: "1",
		familyId: "7",
		kind: "medication",
		subjectId: null,
		title: "Blood pressure pill",
		scheduledFor: "2026-01-01T08:00:00.000Z",
		state: "scheduled",
		promptDue: true,
		prompts: 0,
		nextPromptAt: "2026-01-01T08:00:00.000Z",
		...patch,
	},
	events,
});

const list = (...occurrences: ReminderOccurrenceDetail[]): ServerReply => ({
	json: { occurrences },
});

const failure = (status: number, message: string): ServerReply => ({
	status,
	body: { error: "internal", message },
});

const reads = (calls: { method: string; path: string }[]) =>
	calls.filter((c) => c.method === "GET" && c.path === BASE).length;

describe("DueReminders", () => {
	test("renders nothing and reads nothing without a person", () => {
		const calls = serve({});
		const view = render(<DueReminders familyId={null} />);
		expect(view.container.innerHTML).toBe("");
		expect(calls).toEqual([]);
	});

	test("shows a failed read instead of an empty list", async () => {
		serve({ [LIST]: failure(500, "Database down") });
		const view = render(<DueReminders familyId="7" />);
		expect(view.getByRole("status").textContent).toContain(
			"Loading reminders…",
		);
		await waitFor(() =>
			expect(view.getByRole("alert").textContent).toContain(
				"Could not load remindersDatabase down",
			),
		);
	});

	test("lists only prompts that are due or still waiting for an answer", async () => {
		const calls = serve({
			[LIST]: list(
				detail({
					id: "1",
					state: "delivered",
					promptDue: false,
					nextPromptAt: null,
				}),
				detail({ id: "2", state: "deferred", promptDue: false }),
			),
		});
		const view = render(<DueReminders familyId="7" />);
		expect(await view.findByText("No reminder is due.")).toBeDefined();
		expect(calls.every((c) => c.method === "GET")).toBe(true);
	});

	test("shows a seen prompt that repeats, without giving it again", async () => {
		const calls = serve({
			[LIST]: list(detail({ state: "acknowledged", promptDue: false })),
		});
		const view = render(<DueReminders familyId="7" />);
		const item = await view.findByRole("listitem");
		expect(item.textContent).toContain("Blood pressure pill");
		expect(item.textContent).toContain("Seen, not done");
		expect(item.textContent).not.toContain("home speaker");
		expect(calls.every((c) => c.method === "GET")).toBe(true);
	});

	test("gives a due prompt on this screen once, then reads again", async () => {
		const calls = serve({
			[LIST]: list(detail()),
			[`POST ${BASE}/3/deliveries`]: { json: detail() },
		});
		const view = render(<DueReminders familyId="7" />);
		await view.findByText("Blood pressure pill");
		await waitFor(() => expect(reads(calls)).toBeGreaterThanOrEqual(2));
		const deliveries = calls.filter((c) => c.path.endsWith("/deliveries"));
		expect(deliveries).toEqual([
			{
				method: "POST",
				path: `${BASE}/3/deliveries`,
				body: { clientId: "w-3-1", source: "web" },
			},
		]);
	});

	test("sends the answer with a stable id and reads the list again", async () => {
		const shown = detail({ state: "delivered", promptDue: false }, [
			event(),
			event({ id: "2", state: "delivered", source: "web" }),
		]);
		const calls = serve({
			[LIST]: list(shown),
			[`POST ${BASE}/3/answers`]: { json: shown },
		});
		const view = render(<DueReminders familyId="7" />);
		fireEvent.click(await view.findByRole("button", { name: "Done" }));
		await waitFor(() => expect(reads(calls)).toBe(2));
		expect(calls.find((c) => c.method === "POST")).toEqual({
			method: "POST",
			path: `${BASE}/3/answers`,
			body: {
				clientId: "a-3-done-2",
				source: "web",
				response: "done",
				wording: null,
			},
		});
		expect(view.getByRole("listitem").textContent).not.toContain(
			"home speaker",
		);
	});

	test("says why an answer was not saved, and a 401 ends the session", async () => {
		const shown = detail({ state: "delivered", promptDue: false });
		let reply = failure(500, "Conflict");
		const calls = serve({
			[LIST]: list(shown),
			[`POST ${BASE}/3/answers`]: () => reply,
		});
		const view = inRouter(<DueReminders familyId="7" />);
		fireEvent.click(await view.findByRole("button", { name: "Later" }));
		await waitFor(() =>
			expect(view.getByRole("listitem").textContent).toContain(
				"Shown · Not saved: Conflict",
			),
		);
		reply = { status: 401 };
		fireEvent.click(view.getByRole("button", { name: "Okay" }));
		expect(
			await view.findByRole("link", { name: "Go to Sign in" }),
		).toBeDefined();
		expect(calls.filter((c) => c.method === "POST").length).toBe(2);
	});
});
