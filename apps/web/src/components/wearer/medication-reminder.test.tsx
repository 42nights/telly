import "../test/setup";

import { describe, expect, test } from "bun:test";
import type { CareNeed } from "@health/contracts/care";
import type { CareInstruction } from "@health/contracts/care-profile";
import type { MedicineSighting } from "@health/contracts/medicine-memory";
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
	type Call,
	fireEvent,
	installDom,
	type Reply,
	type Routes,
	render,
	serve,
	waitFor,
} from "../test/dom";

import { MedicationReminders } from "./medication-reminder";

installDom();

const me = "a".repeat(64);
const caregiver = "c".repeat(64);
const minutesAgo = (minutes: number) =>
	new Date(Date.now() - minutes * 60_000).toISOString();
const SCHEDULED = minutesAgo(10);

// Synthetic plan entry; not a real prescription.
const instruction: CareInstruction = {
	id: "10",
	familyId: "1",
	kind: "medication",
	name: "Synthetic Med A",
	instruction: "1 tablet by mouth with breakfast",
	times: ["08:00"],
	reason: "blood pressure",
	source: "demo pharmacy label",
	effectiveDate: "2026-01-01",
	timeZone: "UTC",
	editedBy: me,
	editedAt: "2026-01-01T00:00:00Z",
	verification: "verified",
	verifiedBy: caregiver,
	verifiedAt: "2026-01-01T00:00:00Z",
};
const occurrence = (
	extra: Partial<ReminderOccurrence> = {},
): ReminderOccurrence => ({
	id: "7",
	reminderId: "3",
	familyId: "1",
	kind: "medication",
	subjectId: "10",
	title: "Morning tablet",
	scheduledFor: SCHEDULED,
	state: "delivered",
	promptDue: false,
	prompts: 1,
	nextPromptAt: null,
	...extra,
});
const event = (
	id: string,
	state: ReminderEvent["state"],
	actor: string,
	at: string,
	wording: string | null = null,
): ReminderEvent => ({
	id,
	occurrenceId: "7",
	state,
	response: null,
	at,
	actor,
	source: "web",
	wording,
});
const sighting: MedicineSighting = {
	id: "9",
	familyId: "1",
	container: "SYNTHETIC A 10 mg tablets",
	place: "Kitchen counter",
	seenAt: minutesAgo(5),
	source: "camera_check",
	confidence: 0.9,
	labelRead: true,
	savedBy: me,
	notFoundAt: null,
};
const need = (attempts: CareNeed["attempts"]): CareNeed => ({
	id: "4",
	familyId: "1",
	kind: "help",
	summary: "help",
	facts: [],
	alertId: null,
	dueAt: minutesAgo(0),
	status: "open",
	acceptedBy: null,
	followUpBy: null,
	raisedBy: me,
	clientId: "med-7-1",
	createdAt: minutesAgo(0),
	updatedAt: minutesAgo(0),
	attempts,
	remaining: [],
});
const attempt: CareNeed["attempts"][number] = {
	step: 1,
	member: caregiver,
	name: "Alex",
	backup: false,
	channel: "message",
	status: "sent",
	body: "notice",
	createdAt: minutesAgo(0),
	updatedAt: minutesAgo(0),
	contactLocalTime: "Sat 3:04 AM (UTC)",
};

const BASE = "/api/families/1";
const HISTORY = `GET ${BASE}/reminder-occurrences`;
const PLAN = `GET ${BASE}/care-instructions`;
const ANSWERS = `POST ${BASE}/reminder-occurrences/7/answers`;
const NEEDS = `POST ${BASE}/care/needs`;
const detail = (o: ReminderOccurrence, events: ReminderEvent[] = []) => ({
	json: { occurrence: o, events },
});

/**
 * The server for one family: the history reads `history` each time, the plan, the caller, and
 * the medicine memory answer at once unless `routes` replaces them.
 */
const server = (history: () => ReminderOccurrence[], routes: Routes = {}) =>
	serve({
		[HISTORY]: () => ({
			json: {
				occurrences: history().map((o) => ({ occurrence: o, events: [] })),
			},
		}),
		[PLAN]: { json: { instructions: [instruction] } },
		"GET /api/me": { json: { issuer: "test", subject: "s", identity: me } },
		[`GET ${BASE}/medicine-memory`]: {
			json: { permission: null, sightings: [sighting] },
		},
		...routes,
	});

/** Renders the panel in a router, so its "Find it" link resolves. */
const show = () => {
	const root = createRootRoute({
		component: () => <MedicationReminders familyId="1" />,
	});
	const router = createRouter({
		routeTree: root,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	return render(<RouterProvider router={router} />);
};

const PROMPT =
	"It's time for Synthetic Med A. Your saved instruction says: “1 tablet by mouth with breakfast”. Source: demo pharmacy label, from 2026-01-01.";
const answersOf = (calls: Call[]) =>
	calls.filter((c) => c.path.endsWith("/answers")).map((c) => c.body);

describe("MedicationReminders", () => {
	test("shows nothing while loading, then a failed read as a failure", async () => {
		const pending = Promise.withResolvers<Reply>();
		server(() => [], { [HISTORY]: () => pending.promise });
		const view = show();
		await waitFor(() =>
			expect(view.container.querySelector("*") === null).toBe(true),
		);
		pending.resolve({
			status: 500,
			body: { error: "internal", message: "Database down" },
		});
		expect(await view.findByText("Database down")).toBeDefined();
	});

	test("shows only medication due in the last day and not settled; reads the verified plan", async () => {
		server(() => [
			occurrence(),
			occurrence({ id: "8", kind: "meal", title: "Lunch" }),
			occurrence({ id: "9", title: "Future", scheduledFor: minutesAgo(-10) }),
			occurrence({ id: "11", title: "Old", scheduledFor: minutesAgo(25 * 60) }),
			occurrence({ id: "12", title: "Taken", state: "self_reported_complete" }),
			occurrence({
				id: "13",
				title: "Confirmed",
				state: "caregiver_confirmed",
			}),
			occurrence({ id: "14", title: "Declined", state: "declined" }),
		]);
		const view = show();
		expect(await view.findByText(PROMPT)).toBeDefined();
		expect(view.getAllByRole("heading").map((h) => h.textContent)).toEqual([
			expect.stringContaining("Morning tablet ·"),
		]);
		expect(
			view.getByRole("link", { name: "Find it" }).getAttribute("href"),
		).toBe("/medicine?q=find+my+Synthetic+Med+A");
	});

	test("records that a due prompt was shown, once per prompt, then reads again", async () => {
		const calls = server(() => [occurrence({ promptDue: true, prompts: 2 })], {
			[`POST ${BASE}/reminder-occurrences/7/deliveries`]: detail(occurrence()),
		});
		const view = show();
		expect(await view.findByText(PROMPT)).toBeDefined();
		await waitFor(() =>
			expect(calls.filter((c) => c.path.endsWith("/deliveries"))).toEqual([
				{
					method: "POST",
					path: `${BASE}/reminder-occurrences/7/deliveries`,
					body: { clientId: "show-7-2", source: "web" },
				},
			]),
		);
		// The recorded delivery makes the panel read the history again.
		await waitFor(() =>
			expect(
				calls.filter((c) => c.path === `${BASE}/reminder-occurrences`).length,
			).toBeGreaterThanOrEqual(2),
		);
	});

	test("a failed delivery does not read the history again", async () => {
		const later = Promise.withResolvers<Reply>();
		const calls = server(() => [occurrence({ promptDue: true })], {
			[`POST ${BASE}/reminder-occurrences/7/deliveries`]: () => later.promise,
		});
		const view = show();
		expect(await view.findByText(PROMPT)).toBeDefined();
		await waitFor(() =>
			expect(calls.some((c) => c.path.endsWith("/deliveries"))).toBe(true),
		);
		later.resolve({ status: 503 });
		await Bun.sleep(20);
		expect(
			calls.filter((c) => c.path === `${BASE}/reminder-occurrences`),
		).toHaveLength(1);
	});

	test("without a readable plan it reads no instruction and says why", async () => {
		for (const [reply, why] of [
			[
				{
					status: 403,
					body: { error: "forbidden", message: "No care access" },
				},
				"I can't read your medication plan: No care access",
			],
			[{ status: 401 }, "Sign in to read your medication plan."],
		] as const) {
			server(() => [occurrence()], { [PLAN]: reply });
			const view = show();
			expect((await view.findByRole("status")).textContent).toBe(why);
			expect(
				view.getByText(/^It's time for Morning tablet\. I have no verified/),
			).toBeDefined();
			// "Find it" searches for the reminder title when no instruction is in effect.
			expect(
				view.getByRole("link", { name: "Find it" }).getAttribute("href"),
			).toBe("/medicine?q=find+my+Morning+tablet");
			fireEvent.click(view.getByRole("button", { name: "Why do I take it?" }));
			expect(view.getByText(/^I have no verified instruction/)).toBeDefined();
			view.unmount();
		}
	});

	test("Why do I take it? reads the saved reason; Back returns to the prompt", async () => {
		server(() => [occurrence()]);
		const view = show();
		expect(await view.findByText(PROMPT)).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "Why do I take it?" }));
		expect(
			view.getByText(
				"Your saved plan says you take Synthetic Med A for: “blood pressure”.",
			),
		).toBeDefined();
		expect(view.queryByRole("button", { name: "I took it" }) === null).toBe(
			true,
		);
		fireEvent.click(view.getByRole("button", { name: "Back" }));
		expect(view.getByText(PROMPT)).toBeDefined();
	});

	test("Read aloud speaks the text on screen", async () => {
		const calls = server(() => [occurrence()], {
			[`POST ${BASE}/voice/speech`]: { status: 503 },
		});
		const view = show();
		expect(await view.findByText(PROMPT)).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "Read aloud" }));
		expect((await view.findByRole("alert")).textContent).toBe(
			"The voice is not available right now.",
		);
		expect(calls.find((c) => c.path.endsWith("/voice/speech"))?.body).toEqual({
			text: PROMPT,
		});
	});

	test("each answer records the wearer's own words; a settled dose leaves the screen", async () => {
		const words = [
			["done", "I took it"],
			["already_did_it", "I already took it"],
			["later", "Later"],
			["not_now", "Not now"],
			["stop", "No, thank you"],
		] as const;
		for (const [response, label] of words) {
			let state: ReminderOccurrence["state"] = "delivered";
			const calls = server(() => [occurrence({ state })], {
				[ANSWERS]: () => {
					state = response === "stop" ? "declined" : "self_reported_complete";
					return detail(occurrence({ state }));
				},
			});
			const view = show();
			fireEvent.click(await view.findByRole("button", { name: label }));
			await waitFor(() =>
				expect(
					view.queryByRole("region", { name: "Medication" }) === null,
				).toBe(true),
			);
			expect(answersOf(calls)).toEqual([
				{
					clientId: expect.any(String),
					source: "web",
					response,
					wording: label,
				},
			]);
			view.unmount();
		}
	});

	test("a failed answer says it was not saved", async () => {
		for (const [reply, alert] of [
			[
				{ status: 503, body: { error: "unavailable", message: "Try later" } },
				"Your answer was not saved: Try later",
			],
			[{ status: 401 }, "Sign in to record your answer."],
		] as const) {
			server(() => [occurrence()], { [ANSWERS]: reply });
			const view = show();
			fireEvent.click(await view.findByRole("button", { name: "I took it" }));
			expect((await view.findByRole("alert")).textContent).toBe(alert);
			// The prompt stays, so the wearer can answer again.
			expect(view.getByRole("button", { name: "I took it" })).toBeDefined();
			view.unmount();
		}
	});

	test("not sure: reads every recorded step and container sighting, then asks the family", async () => {
		const calls = server(() => [occurrence()], {
			[ANSWERS]: detail(occurrence({ state: "unresolved" }), [
				event("1", "delivered", "scheduler", SCHEDULED),
				event(
					"2",
					"unresolved",
					me,
					minutesAgo(4),
					"I'm not sure if I took it",
				),
				event("3", "acknowledged", caregiver, minutesAgo(3)),
			]),
			[NEEDS]: { json: need([attempt]) },
		});
		const view = show();
		fireEvent.click(
			await view.findByRole("button", { name: "I'm not sure if I took it" }),
		);
		const answer = await view.findByText(/^Here is what is recorded/);
		const lines = answer.textContent?.split("\n") ?? [];
		expect(lines).toHaveLength(7);
		expect(lines[1]).toMatch(/, Telly: the reminder was shown\.$/);
		expect(lines[2]).toMatch(
			/, You: container found, “SYNTHETIC A 10 mg tablets” at Kitchen counter; this does not say the dose was taken\.$/,
		);
		expect(lines[3]).toMatch(
			/, You: the reminder was left open, in the words “I'm not sure if I took it”\.$/,
		);
		expect(lines[4]).toMatch(/, Member cccccc: the reminder was seen;/);
		expect(lines[5]).toBe(
			"I can't tell you whether to take it now. Don't take another dose because of me.",
		);
		// The answers are gone; the wearer can ask the family.
		expect(view.queryByRole("button", { name: "I took it" }) === null).toBe(
			true,
		);
		fireEvent.click(view.getByRole("button", { name: "Ask my family" }));
		expect(
			await view.findByText(
				"I asked Alex. Nobody has said they will help yet. Your question stays open until someone does.",
			),
		).toBeDefined();
		const asked = calls.find((c) => c.path.endsWith("/care/needs"))?.body;
		expect(asked).toEqual({
			clientId: expect.stringMatching(/^med-7-\d+$/),
			kind: "help",
			summary: expect.stringContaining(`reminder scheduled ${SCHEDULED}`),
			sampleIds: [],
			dueAt: null,
		});
		expect(JSON.stringify(asked)).not.toContain("Synthetic Med A");
		expect(answersOf(calls)).toEqual([
			{
				clientId: expect.any(String),
				source: "web",
				response: "unsure",
				wording: "I'm not sure if I took it",
			},
		]);
	});

	test("I need help: offers the family without dose advice; nobody set up is said plainly", async () => {
		const calls = server(() => [occurrence()], {
			[ANSWERS]: detail(occurrence({ state: "unresolved" })),
			[NEEDS]: { json: need([]) },
		});
		const view = show();
		fireEvent.click(await view.findByRole("button", { name: "I need help" }));
		expect(
			await view.findByText(
				"I can ask your family to help. I won't tell you whether to take a dose.",
			),
		).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "Ask my family" }));
		expect(
			await view.findByText(/^Nobody is set up to be contacted/),
		).toBeDefined();
		expect(answersOf(calls)[0]).toMatchObject({ response: "help" });
	});

	test("a failed request to the family says so and keeps the question", async () => {
		for (const [reply, alert] of [
			[
				{ status: 503, body: { error: "unavailable", message: "Try later" } },
				"Your family was not asked: Try later",
			],
			[{ status: 401 }, "Sign in to ask your family."],
		] as const) {
			server(() => [occurrence()], {
				[ANSWERS]: detail(occurrence({ state: "unresolved" })),
				[NEEDS]: reply,
			});
			const view = show();
			fireEvent.click(await view.findByRole("button", { name: "I need help" }));
			fireEvent.click(
				await view.findByRole("button", { name: "Ask my family" }),
			);
			expect((await view.findByRole("alert")).textContent).toBe(alert);
			expect(view.getByRole("button", { name: "Ask my family" })).toBeDefined();
			view.unmount();
		}
	});
});
