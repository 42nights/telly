import { describe, expect, test } from "bun:test";
import type { ReminderEvent } from "@health/contracts/reminders";

import { familyStatus } from "./logic";

describe("family status", () => {
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

	test("delivered, a late self-report, and unresolved stay separate facts", () => {
		const s = familyStatus([
			event({ id: "1", state: "delivered", source: "web" }),
			event({ id: "2", state: "unresolved" }),
			event({
				id: "3",
				state: "self_reported_complete",
				response: "done",
				wording: "had soup",
			}),
		]);
		expect(s.delivered?.id).toBe("1");
		expect(s.unresolved?.id).toBe("2");
		expect(s.selfReported?.id).toBe("3");
		expect(s.wording).toBe("had soup");
	});

	test("an acknowledged prompt is not a self-report", () => {
		const s = familyStatus([
			event({ state: "acknowledged", response: "okay" }),
		]);
		expect(s.selfReported).toBeNull();
		expect(s.unresolved).toBeNull();
	});
});
