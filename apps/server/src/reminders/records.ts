// Reminder rows (issue #28) as the caller's database identity sees them, in the shared contracts. The
// module stores kinds, states, responses, and sources as strings; decoding them here with the
// contract schemas keeps an unexpected value from passing as a valid state.
import {
	Reminder,
	ReminderOccurrenceDetail,
	type ReminderSettings,
} from "@health/contracts/reminders";
import { Schema } from "effect";
import { DbUnavailable, type FamilyDb } from "../db";

/** `HH:MM` for minutes after local midnight. */
const localTime = (minute: number) =>
	`${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** Minutes after local midnight for an `HH:MM` that the contract already checked. */
export const minuteOfDay = (time: string) =>
	Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

export const views = ({ connection }: FamilyDb) => {
	if (!connection.isActive)
		throw new DbUnavailable({
			reason: "connection closed; cached rows are stale",
		});
	return connection.db;
};

const decodeReminder = Schema.decodeUnknownSync(Reminder);
const decodeDetail = Schema.decodeUnknownSync(ReminderOccurrenceDetail);

export const readReminderSettings = (
	db: FamilyDb,
	familyId: string,
): ReminderSettings | null => {
	const row = [...views(db).myReminderSettings.iter()].find(
		(s) => s.familyId.toString() === familyId,
	);
	if (row === undefined) return null;
	return {
		timeZone: row.timeZone,
		quietHours:
			row.quietStart === undefined || row.quietEnd === undefined
				? null
				: { start: localTime(row.quietStart), end: localTime(row.quietEnd) },
		repeatEveryMinutes: row.repeatEveryMinutes,
		maxPrompts: row.maxPrompts,
		snoozeMinutes: row.snoozeMinutes,
	};
};

/** The family's saved reminders with the server-chosen `clientId` each was created with. */
export const readReminders = (db: FamilyDb, familyId: string) =>
	[...views(db).myReminders.iter()]
		.filter((r) => r.familyId.toString() === familyId)
		.map((r) => ({
			clientId: r.clientId,
			reminder: decodeReminder({
				id: r.id.toString(),
				familyId,
				kind: r.kind,
				subjectId: r.subjectId ?? null,
				title: r.title,
				times: r.times.map(localTime),
				createdBy: r.createdBy.toHexString(),
				createdAt: r.createdAt.toISOString(),
			}),
		}));

/**
 * The family's occurrences with their events, oldest event first, newest scheduled first. With
 * `occurrenceId`, only that occurrence when it belongs to the family.
 */
export const readReminderHistory = (
	db: FamilyDb,
	familyId: string,
	occurrenceId?: string,
): ReminderOccurrenceDetail[] => {
	const tables = views(db);
	const events = [...tables.myReminderEvents.iter()]
		.filter((e) => e.familyId.toString() === familyId)
		.sort((a, b) => (a.id < b.id ? -1 : 1));
	return [...tables.myReminderOccurrences.iter()]
		.filter(
			(o) =>
				o.familyId.toString() === familyId &&
				(occurrenceId === undefined || o.id.toString() === occurrenceId),
		)
		.sort(
			(a, b) =>
				Number(
					b.scheduledFor.microsSinceUnixEpoch -
						a.scheduledFor.microsSinceUnixEpoch,
				) || (b.id > a.id ? 1 : -1),
		)
		.map((o) =>
			decodeDetail({
				occurrence: {
					id: o.id.toString(),
					reminderId: o.reminderId.toString(),
					familyId,
					kind: o.kind,
					subjectId: o.subjectId ?? null,
					title: o.title,
					scheduledFor: o.scheduledFor.toISOString(),
					state: o.state,
					promptDue: o.promptDue,
					prompts: o.prompts,
					nextPromptAt: o.nextPromptAt?.toISOString() ?? null,
				},
				events: events
					.filter((e) => e.occurrenceId === o.id)
					.map((e) => ({
						id: e.id.toString(),
						occurrenceId: o.id.toString(),
						state: e.state,
						response: e.response ?? null,
						at: e.at.toISOString(),
						actor: e.actor?.toHexString() ?? "scheduler",
						source: e.source,
						wording: e.wording ?? null,
					})),
			}),
		);
};
