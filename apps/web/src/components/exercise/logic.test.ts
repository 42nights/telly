import { describe, expect, test } from "bun:test";
import type { ExercisePlan, ExerciseSession } from "@health/contracts/exercise";

import { invitation } from "./logic";

const identity = "a".repeat(64);
const plan = (
	id: string,
	windowStart: string,
	windowEnd: string,
	verified = true,
): ExercisePlan => ({
	id,
	activity: "Seated marching",
	steps: ["Lift one knee, then the other."],
	demands: [],
	restrictions: [],
	source: "Synthetic demo plan",
	windowStart,
	windowEnd,
	videoUrl: null,
	createdBy: identity,
	createdAt: "2026-10-01T08:00:00.000Z",
	verification: verified
		? { verifiedBy: identity, verifiedAt: "2026-10-01T08:00:00.000Z" }
		: null,
});
const at = (hours: number, minutes = 0) => new Date(2026, 9, 4, hours, minutes);

describe("exercise invitation", () => {
	test("offers only a verified plan inside its local window", () => {
		const unverified = plan("u", "09:00", "11:00", false);
		const verified = plan("v", "09:00", "11:00");
		expect(invitation([unverified, verified], [], at(9, 30))?.id).toBe("v");
		expect(invitation([unverified], [], at(9, 30))).toBeNull();
		expect(invitation([verified], [], at(8, 59))).toBeNull();
		expect(invitation([verified], [], at(11))).toBeNull();
		// A window past midnight.
		const late = plan("l", "22:00", "01:00");
		expect(invitation([late], [], at(0, 30))?.id).toBe("l");
		expect(invitation([late], [], at(12))).toBeNull();
	});

	test("an answer today ends the invitation, and the next day invites again", () => {
		const verified = plan("v", "09:00", "11:00");
		const declined: ExerciseSession = {
			sessionId: "s",
			planId: "v",
			outcome: "declined",
			reason: null,
			help: false,
			openedAt: at(9, 5).toISOString(),
			endedAt: at(9, 5).toISOString(),
		};
		expect(invitation([verified], [declined], at(10))).toBeNull();
		expect(
			invitation([verified], [declined], new Date(2026, 9, 5, 10))?.id,
		).toBe("v");
	});
});
