import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Identity, Timestamp } from "spacetimedb";
import { DbUnavailable, type FamilyDb } from "../db";
import {
	minuteOfDay,
	readReminderHistory,
	readReminderSettings,
	readReminders,
} from "./records";

// The identity's cached view rows, as the SDK hands them over: ids are u64, times are Timestamps.
const view = <T>(rows: T[]) => ({ iter: () => rows.values() });
const familyDb = (tables: Record<string, unknown>, isActive = true) =>
	({ connection: { isActive, db: tables } }) as unknown as FamilyDb;
const at = (iso: string) => Timestamp.fromDate(new Date(iso));
const member = new Identity(0xabcn);

const occurrence = (
	id: bigint,
	scheduledFor: string,
	overrides: Record<string, unknown> = {},
) => ({
	id,
	reminderId: 7n,
	familyId: 1n,
	kind: "medication",
	subjectId: undefined,
	title: "Blood pressure pill",
	scheduledFor: at(scheduledFor),
	state: "scheduled",
	promptDue: false,
	prompts: 0,
	nextPromptAt: undefined,
	...overrides,
});

describe("reminder records", () => {
	test("a closed connection serves no stale reminder rows", () => {
		const closed = familyDb({}, false);
		for (const read of [
			() => readReminderSettings(closed, "1"),
			() => readReminders(closed, "1"),
			() => readReminderHistory(closed, "1"),
		])
			expect(read).toThrow(
				new DbUnavailable({
					reason: "connection closed; cached rows are stale",
				}),
			);
	});

	test("settings belong to the asked family, with quiet hours as HH:MM or null", () => {
		const settings = (quietStart?: number, quietEnd?: number) =>
			familyDb({
				myReminderSettings: view([
					{
						familyId: 2n,
						timeZone: "Europe/Paris",
						quietStart: 0,
						quietEnd: 1,
						repeatEveryMinutes: 1,
						maxPrompts: 1,
						snoozeMinutes: 1,
					},
					{
						familyId: 1n,
						timeZone: "America/New_York",
						quietStart,
						quietEnd,
						repeatEveryMinutes: 10,
						maxPrompts: 3,
						snoozeMinutes: 15,
					},
				]),
			});
		expect(readReminderSettings(settings(22 * 60 + 5, 7 * 60), "1")).toEqual({
			timeZone: "America/New_York",
			quietHours: { start: "22:05", end: "07:00" },
			repeatEveryMinutes: 10,
			maxPrompts: 3,
			snoozeMinutes: 15,
		});
		// Half a quiet window is no quiet window.
		expect(readReminderSettings(settings(22 * 60), "1")?.quietHours).toBeNull();
		expect(readReminderSettings(settings(), "3")).toBeNull();
	});

	test("reminders are the family's own, with times as HH:MM and the creating clientId", () => {
		const db = familyDb({
			myReminders: view([
				{
					id: 5n,
					familyId: 1n,
					clientId: "phone-1",
					kind: "hydration",
					subjectId: undefined,
					title: "Water",
					times: [0, 9 * 60 + 30, 23 * 60 + 59],
					createdBy: member,
					createdAt: at("2026-01-01T08:00:00Z"),
				},
				{
					id: 6n,
					familyId: 2n,
					clientId: "other",
					kind: "meal",
					subjectId: "x",
					title: "Lunch",
					times: [720],
					createdBy: member,
					createdAt: at("2026-01-01T08:00:00Z"),
				},
			]),
		});
		expect(readReminders(db, "1")).toEqual([
			{
				clientId: "phone-1",
				reminder: {
					id: "5",
					familyId: "1",
					kind: "hydration",
					subjectId: null,
					title: "Water",
					times: ["00:00", "09:30", "23:59"],
					createdBy: member.toHexString(),
					createdAt: "2026-01-01T08:00:00.000000Z",
				},
			},
		]);
		expect(minuteOfDay("23:59")).toBe(23 * 60 + 59);
		expect(minuteOfDay("00:00")).toBe(0);
	});

	test("history is newest scheduled first, ties newest id first, each with its events oldest first", () => {
		const db = familyDb({
			myReminderOccurrences: view([
				occurrence(10n, "2026-01-01T08:00:00Z"),
				occurrence(12n, "2026-01-02T08:00:00Z", {
					state: "acknowledged",
					promptDue: true,
					prompts: 2,
					nextPromptAt: at("2026-01-02T08:10:00Z"),
					subjectId: "pill-1",
				}),
				occurrence(11n, "2026-01-02T08:00:00Z"),
				occurrence(13n, "2026-01-03T08:00:00Z", { familyId: 2n }),
			]),
			myReminderEvents: view([
				{
					id: 31n,
					familyId: 1n,
					occurrenceId: 12n,
					state: "acknowledged",
					response: "okay",
					at: at("2026-01-02T08:01:00Z"),
					actor: member,
					source: "phone",
					wording: "I'm on it",
				},
				{
					id: 30n,
					familyId: 1n,
					occurrenceId: 12n,
					state: "scheduled",
					response: undefined,
					at: at("2026-01-01T00:00:00Z"),
					actor: undefined,
					source: "scheduler",
					wording: undefined,
				},
				{
					id: 32n,
					familyId: 2n,
					occurrenceId: 12n,
					state: "declined",
					response: "stop",
					at: at("2026-01-02T08:02:00Z"),
					actor: member,
					source: "web",
					wording: undefined,
				},
			]),
		});
		const history = readReminderHistory(db, "1");
		expect(history.map((d) => d.occurrence.id)).toEqual(["12", "11", "10"]);
		expect(history[0]).toEqual({
			occurrence: {
				id: "12",
				reminderId: "7",
				familyId: "1",
				kind: "medication",
				subjectId: "pill-1",
				title: "Blood pressure pill",
				scheduledFor: "2026-01-02T08:00:00.000000Z",
				state: "acknowledged",
				promptDue: true,
				prompts: 2,
				nextPromptAt: "2026-01-02T08:10:00.000000Z",
			},
			events: [
				{
					id: "30",
					occurrenceId: "12",
					state: "scheduled",
					response: null,
					at: "2026-01-01T00:00:00.000000Z",
					actor: "scheduler",
					source: "scheduler",
					wording: null,
				},
				{
					id: "31",
					occurrenceId: "12",
					state: "acknowledged",
					response: "okay",
					at: "2026-01-02T08:01:00.000000Z",
					actor: member.toHexString(),
					source: "phone",
					wording: "I'm on it",
				},
			],
		});
		expect(history[1]).toMatchObject({
			occurrence: { nextPromptAt: null, subjectId: null },
			events: [],
		});

		expect(
			readReminderHistory(db, "1", "11").map((d) => d.occurrence.id),
		).toEqual(["11"]);
		// Another family's occurrence id answers nothing.
		expect(readReminderHistory(db, "1", "13")).toEqual([]);
	});

	test("a state the contract does not know never passes as a valid state", () => {
		const db = familyDb({
			myReminderOccurrences: view([
				occurrence(10n, "2026-01-01T08:00:00Z", { state: "missed" }),
			]),
			myReminderEvents: view([]),
		});
		expect(() => readReminderHistory(db, "1")).toThrow(Schema.SchemaError);
		expect(() => readReminderHistory(db, "1")).toThrow(
			/"unresolved"\n {2}at \["occurrence"\]\["state"\]$/,
		);
	});
});
