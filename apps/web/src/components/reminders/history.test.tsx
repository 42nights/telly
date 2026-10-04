import "../test/setup";

import { describe, expect, test } from "bun:test";
import type {
	ReminderEvent,
	ReminderOccurrenceDetail,
} from "@health/contracts/reminders";
import { installDom, render, serve, waitFor } from "../test/dom";

import { ReminderHistorySection, STATE_TEXT } from "./history";

installDom();

const PATH = "GET /api/families/7/reminder-occurrences";
const ME = "a".repeat(64);
const OTHER = `bcdef0${"1".repeat(58)}`;

const event = (patch: Partial<ReminderEvent>): ReminderEvent => ({
	id: "1",
	occurrenceId: "1",
	state: "scheduled",
	response: null,
	at: "2026-01-01T08:00:00.000Z",
	actor: "scheduler",
	source: "scheduler",
	wording: null,
	...patch,
});

const detail = (
	id: string,
	scheduledFor: string,
	events: ReminderEvent[] = [],
): ReminderOccurrenceDetail => ({
	occurrence: {
		id,
		reminderId: "1",
		familyId: "7",
		kind: "medication",
		subjectId: null,
		title: `Pill ${id}`,
		scheduledFor,
		state: "acknowledged",
		promptDue: false,
		prompts: 1,
		nextPromptAt: null,
	},
	events,
});

describe("ReminderHistorySection", () => {
	test("shows past occurrences with each step, who recorded it, from where, and their words", async () => {
		serve({
			[PATH]: {
				json: {
					occurrences: [
						detail("9", "2999-01-01T08:00:00.000Z"),
						detail("2", "2026-01-01T08:00:00.000Z", [
							event({ id: "10" }),
							event({
								id: "11",
								state: "acknowledged",
								response: "okay",
								actor: ME,
								source: "phone",
							}),
							event({
								id: "12",
								state: "self_reported_complete",
								response: "done",
								actor: OTHER,
								source: "glasses",
								wording: "took it with lunch",
							}),
						]),
					],
				},
			},
		});
		const view = render(<ReminderHistorySection familyId="7" me={ME} />);
		expect(view.getByRole("status").textContent).toContain(
			"Loading reminders…",
		);
		const heading = await view.findByRole("heading", { name: /Pill 2/ });
		expect(heading.textContent).toContain(STATE_TEXT.acknowledged);
		expect(view.queryByText(/Pill 9/)).toBeNull();
		const steps = view.getAllByRole("listitem").map((li) => li.textContent);
		expect(steps).toHaveLength(3);
		expect(steps[0]).toContain("Scheduled · Scheduler");
		expect(steps[0]).not.toContain("(scheduler)");
		expect(steps[1]).toContain("Seen, not done · You (phone)");
		expect(steps[1]).not.toContain("“");
		expect(steps[2]).toContain(
			"Done, by their own report · Member bcdef0 (glasses) · “took it with lunch”",
		);
	});

	test("hides the section while nothing has come due", async () => {
		serve({
			[PATH]: {
				json: { occurrences: [detail("1", "2999-01-01T08:00:00.000Z")] },
			},
		});
		const view = render(<ReminderHistorySection familyId="7" me={null} />);
		expect(view.container.textContent).toContain("Loading reminders…");
		await waitFor(() => expect(view.container.textContent).toBe(""));
	});

	test("shows at most the ten newest due occurrences", async () => {
		const occurrences = Array.from({ length: 12 }, (_, i) =>
			detail(String(i + 1), "2026-01-01T08:00:00.000Z"),
		);
		serve({ [PATH]: { json: { occurrences } } });
		const view = render(<ReminderHistorySection familyId="7" me={null} />);
		await view.findByText(/Pill 1 ·/);
		expect(view.getAllByRole("article")).toHaveLength(10);
		expect(view.queryByText(/Pill 11/)).toBeNull();
	});

	test("shows a provider failure instead of an empty history", async () => {
		serve({
			[PATH]: {
				status: 503,
				body: { error: "internal", message: "Database not configured" },
			},
		});
		const view = render(<ReminderHistorySection familyId="7" me={null} />);
		await waitFor(() =>
			expect(view.getByRole("alert").textContent).toContain(
				"Reminders unavailable",
			),
		);
		expect(view.getByRole("alert").textContent).toContain(
			"Database not configured",
		);
	});
});
