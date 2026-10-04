// Wearer wording for a scheduled medication time and for "did I take it?" (#31,
// docs/board.html#wf-family). Every sentence comes from the saved plan (#26), the recorded
// reminder events (#28), or medicine sightings (#29). Nothing here suggests a dose, a missed-dose
// rule, or a change to treatment.
import type { CareInstruction } from "@health/contracts/care-profile";
import type { MedicineSighting } from "@health/contracts/medicine-memory";
import type {
	ReminderEvent,
	ReminderOccurrence,
	ReminderState,
} from "@health/contracts/reminders";

/** The local calendar date (`YYYY-MM-DD`) of `now` in `timeZone`. */
const localDate = (now: number, timeZone: string | null): string =>
	new Intl.DateTimeFormat("en-CA", {
		...(timeZone === null ? {} : { timeZone }),
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);

/**
 * The instruction to read for a medication occurrence: the verified version, in effect today, of
 * the instruction the reminder names. Versions share a name (#26); a newer unverified version
 * leaves the verified one in effect. Null when none is verified and in effect.
 */
export const instructionInEffect = (
	occurrence: ReminderOccurrence,
	instructions: readonly CareInstruction[],
	now: number,
): CareInstruction | null => {
	const named = instructions.find((i) => i.id === occurrence.subjectId);
	if (named === undefined) return null;
	const name = named.name.toLowerCase();
	return (
		instructions.find(
			(i) =>
				i.kind === "medication" &&
				i.verification === "verified" &&
				i.name.toLowerCase() === name &&
				i.effectiveDate <= localDate(now, i.timeZone),
		) ?? null
	);
};

// Also said when the plan cannot be read (no access, or the server failed): never a guess.
const NOT_VERIFIED =
	"I have no verified instruction for this that I can read, so I won't read one to you. Please ask your caregiver.";

/** What to say at the scheduled time: the saved instruction verbatim, with its source and date. */
export const medicationPrompt = (
	title: string,
	m: CareInstruction | null,
): string =>
	m === null
		? `It's time for ${title}. ${NOT_VERIFIED}`
		: `It's time for ${m.name}. Your saved instruction says: “${m.instruction}”. Source: ${m.source}, from ${m.effectiveDate}.`;

/** "Why do I take this?" from the saved plan only. */
export const medicationReason = (m: CareInstruction | null): string =>
	m === null
		? NOT_VERIFIED
		: m.reason === null
			? `Your saved plan does not say why you take ${m.name}. Your caregiver or pharmacist can tell you.`
			: `Your saved plan says you take ${m.name} for: “${m.reason}”.`;

// Each state says exactly what it proves. Only a person's report says anything about the dose.
const STATE_TEXT: Record<ReminderState, string> = {
	scheduled: "the reminder was scheduled",
	delivered: "the reminder was shown",
	acknowledged: "the reminder was seen; this does not say the dose was taken",
	self_reported_complete: "the dose was reported taken, by the wearer",
	caregiver_confirmed: "a caregiver confirmed the dose",
	deferred: "the reminder was put off",
	declined: "the reminder was declined",
	unresolved: "the reminder was left open",
};

/**
 * The answer when the wearer cannot remember whether they took a dose: every recorded step for
 * this dose time and every container sighting (#29) since it, oldest first, then an offer of human
 * help. A sighting is "container found" only, never a dose. It never advises another dose or a
 * skipped one. `who` names an event's actor; `time` formats an instant.
 */
export const uncertaintyAnswer = (
	occurrence: ReminderOccurrence,
	events: readonly ReminderEvent[],
	sightings: readonly MedicineSighting[],
	who: (actor: string) => string,
	time: (iso: string) => string,
): readonly string[] => [
	`Here is what is recorded for ${occurrence.title} at ${time(occurrence.scheduledFor)}:`,
	...[
		...events.map((e) => ({
			at: e.at,
			text: `${time(e.at)}, ${who(e.actor)}: ${STATE_TEXT[e.state]}${e.wording === null ? "" : `, in the words “${e.wording}”`}.`,
		})),
		...sightings
			.filter((s) => s.seenAt >= occurrence.scheduledFor)
			.map((s) => ({
				at: s.seenAt,
				text: `${time(s.seenAt)}, ${who(s.savedBy)}: container found, “${s.container}” at ${s.place}; this does not say the dose was taken.`,
			})),
	]
		.toSorted((a, b) => a.at.localeCompare(b.at))
		.map((line) => line.text),
	"I can't tell you whether to take it now. Don't take another dose because of me.",
	"I can ask your family to help.",
];

/**
 * The care-need summary (#30) for a dose question. Every family member can read care needs, so it
 * names no medicine and quotes nothing: the wearer's words, the times, and the open state are in
 * the reminder history (#28).
 */
export const questionSummary = (
	occurrence: ReminderOccurrence,
	askedAt: string,
): string =>
	`The wearer asked for a person to help with a reminder scheduled ${occurrence.scheduledFor} (asked ${askedAt}). Their own words and the recorded steps are in the reminder history in Telly.`;
