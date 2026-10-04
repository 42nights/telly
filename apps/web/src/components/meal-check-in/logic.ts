// Meal and drink check-ins (issue #32) on the shared reminder lifecycle (#28). A check-in is a
// `meal` or `hydration` reminder.
import type { ReminderEvent, ReminderKind } from "@health/contracts/reminders";

type MealKind = Extract<ReminderKind, "meal" | "hydration">;

export const isMealKind = (kind: ReminderKind): kind is MealKind =>
	kind === "meal" || kind === "hydration";

/**
 * Three independent facts for the family. `delivered`: a device showed it. `selfReported`: the
 * wearer said they did it, which never proves they ate or are safe. `unresolved`: no answer settled
 * it. A late self-report after `unresolved` keeps both visible.
 */
export const familyStatus = (events: readonly ReminderEvent[]) => {
	const first = (state: ReminderEvent["state"]) =>
		events.find((e) => e.state === state) ?? null;
	return {
		delivered: first("delivered"),
		selfReported: first("self_reported_complete"),
		caregiverConfirmed: first("caregiver_confirmed"),
		unresolved: first("unresolved"),
		/** The newest words the wearer gave, such as a barrier. */
		wording: events.findLast((e) => e.wording !== null)?.wording ?? null,
	};
};
