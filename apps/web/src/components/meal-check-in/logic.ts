// Meal and drink check-ins (issue #32) on the shared reminder lifecycle (#28). A check-in is a
// `meal` or `hydration` reminder: it follows only the wearer's agreed times, never a universal
// water target, and its next steps never suggest a food, an amount, or a treatment.
import type { CareProfile } from "@health/contracts/care-profile";
import type {
	ReminderEvent,
	ReminderHistory,
	ReminderKind,
	ReminderOccurrence,
	ReminderResponse,
} from "@health/contracts/reminders";

export type MealKind = Extract<ReminderKind, "meal" | "hydration">;

export const isMealKind = (kind: ReminderKind): kind is MealKind =>
	kind === "meal" || kind === "hydration";

/** Why the routine did not happen. */
export const BARRIERS = [
	"forgot",
	"not_hungry",
	"unwell",
	"cannot_prepare",
	"cannot_reach",
	"cannot_open",
	"no_food",
	"difficulty_eating",
	"changed_plans",
] as const;
export type Barrier = (typeof BARRIERS)[number];

/** The wearer's own words for each barrier: [meal, drink]. They are also sent as the answer's wording. */
const BARRIER_WORDS: Record<Barrier, readonly [string, string]> = {
	forgot: ["I forgot", "I forgot"],
	not_hungry: ["I'm not hungry", "I'm not thirsty"],
	unwell: ["I feel unwell", "I feel unwell"],
	cannot_prepare: ["I can't make it", "I can't pour it"],
	cannot_reach: ["I can't reach it", "I can't reach it"],
	cannot_open: ["I can't open it", "I can't open it"],
	no_food: ["There is no food", "There is nothing to drink"],
	difficulty_eating: ["It is hard to eat", "It is hard to drink"],
	changed_plans: ["My plans changed", "My plans changed"],
};

export const barrierWords = (barrier: Barrier, kind: MealKind) =>
	BARRIER_WORDS[barrier][kind === "meal" ? 0 : 1];

/**
 * What a step does. `now`: nothing is recorded; the wearer answers Done when finished. `later`,
 * `skip`: the lifecycle's `later` and `stop`. `caregiver`: `help`, then a care need for the family
 * ladder (#30). `help_path`: the separate urgent help path (#34).
 */
export type StepAction = "now" | "later" | "skip" | "caregiver" | "help_path";
export type Step = { readonly action: StepAction; readonly label: string };

const later: Step = { action: "later", label: "Remind me later" };
const skip: Step = { action: "skip", label: "Skip this one" };
const family = (what: string): Step => ({
	action: "caregiver",
	label: `Ask family to ${what}`,
});

/** The next steps for one barrier, most relevant first. */
export const nextSteps = (
	barrier: Barrier,
	kind: MealKind,
): readonly Step[] => {
	const meal = kind === "meal";
	switch (barrier) {
		case "forgot":
			return [{ action: "now", label: "I'll have it now" }, later];
		case "not_hungry":
		case "changed_plans":
			return [later, skip];
		case "unwell":
			return [
				{ action: "help_path", label: "I need help now" },
				family("check on me"),
				later,
			];
		case "cannot_prepare":
			return [family(meal ? "help me make it" : "help me get a drink"), later];
		case "cannot_reach":
			return [family("help me reach it")];
		case "cannot_open":
			return [family("help me open it")];
		case "no_food":
			return [family(meal ? "bring food" : "bring a drink")];
		case "difficulty_eating":
			return [
				{ action: "help_path", label: "I'm choking or can't swallow" },
				family(meal ? "help me eat" : "help me drink"),
			];
	}
};

/** The lifecycle answer a step records, or null when it records none. */
export const stepResponse: Record<StepAction, ReminderResponse | null> = {
	now: null,
	later: "later",
	skip: "stop",
	caregiver: "help",
	help_path: "help",
};

// Words that report an emergency during a check-in. A match leaves the routine for the help path at
// once; a miss is never proof that the wearer is safe.
// ponytail: fixed English list; use the #34 emergency classifier for every language when it has one.
const URGENT =
	/\b(chok(e|es|ed|ing)|can(no|')?t (breathe|swallow)|(trouble|difficulty) (breathing|swallowing)|chest pain|faint(ed|ing)?|passed out|vomit(ing)? blood|collapsed?)\b/i;

export const reportsUrgentSymptom = (text: string): boolean =>
	URGENT.test(text);

const OPEN_STATES: Partial<Record<ReminderOccurrence["state"], true>> = {
	scheduled: true,
	delivered: true,
	acknowledged: true,
	deferred: true,
};

/**
 * The meal or drink check-in to show the wearer: due now (its prompt is due, or it was shown and
 * not answered) and still open. The newest one wins; a deferred one waits for its next prompt.
 */
export const dueCheckIn = (
	history: ReminderHistory,
	now: number,
): ReminderOccurrence | null => {
	let due: ReminderOccurrence | null = null;
	for (const { occurrence: o } of history.occurrences)
		if (
			isMealKind(o.kind) &&
			OPEN_STATES[o.state] === true &&
			o.nextPromptAt !== null &&
			Date.parse(o.scheduledFor) <= now &&
			(o.promptDue || o.state === "delivered" || o.state === "acknowledged") &&
			(due === null || o.scheduledFor > due.scheduledFor)
		)
			due = o;
	return due;
};

/**
 * The wearer's saved notes that apply to this kind, from the care profile (#26). `items: null` is
 * unknown, never "none"; an empty list means someone confirmed there are none.
 */
export const restrictionsFor = (profile: CareProfile, kind: MealKind) =>
	kind === "hydration"
		? [{ label: "Fluid notes", items: profile.fluidRestrictions }]
		: [
				{ label: "Diet notes", items: profile.dietaryRestrictions },
				{ label: "Allergies", items: profile.allergies },
			];

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
