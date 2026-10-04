// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). The prompts come
// from the database's own scheduled timers on its real clock, so the timed test waits about two
// minutes. All records are synthetic. Each connection is a separate identity issued by that database.
import { describe, expect, test } from "bun:test";
import {
	Reminder,
	ReminderHistory,
	ReminderOccurrenceDetail,
	Reminders,
	SavedReminderSettings,
} from "@health/contracts/reminders";
import { Effect, Schema } from "effect";
import { Identity } from "spacetimedb";
import {
	type DbConfig,
	type FamilyDb,
	openFamilyDb,
	readFamilyRecords,
} from "../db";
import { reminderRoutes } from "./reminders";
import {
	dbConfig,
	failure,
	familyApp,
	openFamily,
	send,
	withDb,
} from "./test-family";

const detailOf = Schema.decodeUnknownSync(ReminderOccurrenceDetail);
const historyOf = Schema.decodeUnknownSync(ReminderHistory);
const remindersOf = Schema.decodeUnknownSync(Reminders);

/** `HH:MM` and its local date in `timeZone` at `ms`. */
const wallClock = (ms: number, timeZone: string) =>
	new Intl.DateTimeFormat("en-GB", {
		timeZone,
		hourCycle: "h23",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(ms));

const settings = (timeZone: string, extra: object = {}) => ({
	timeZone,
	quietHours: null,
	repeatEveryMinutes: 1,
	maxPrompts: 1,
	snoozeMinutes: 1,
	...extra,
});

const joinAs = (config: DbConfig, owner: FamilyDb, familyId: string) =>
	Effect.gen(function* () {
		const member = yield* openFamilyDb(config);
		yield* Effect.promise(() =>
			owner.connection.reducers.addFamilyMember({
				familyId: BigInt(familyId),
				member: Identity.fromString(member.identity),
			}),
		);
		return member;
	});

describe.skipIf(dbConfig === undefined)("reminder lifecycle", () => {
	test("settings come first; each time is one scheduled occurrence, readable by the family only", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Reminder family");
				const app = familyApp(db, familyId, reminderRoutes());
				const input = {
					kind: "medication",
					subjectId: "instruction-1",
					title: "Synthetic morning tablet",
					times: ["08:00", "20:30"],
				};

				expect(failure(yield* send(app, "POST", "/reminders", input))).toEqual([
					409,
					"conflict",
				]);
				expect(
					failure(
						yield* send(
							app,
							"PUT",
							"/reminder-settings",
							settings("Mars/Base"),
						),
					),
				).toEqual([400, "invalid_request"]);
				const quiet = settings("UTC", {
					quietHours: { start: "22:00", end: "07:00" },
				});
				expect(
					(yield* send(app, "PUT", "/reminder-settings", quiet)).json,
				).toEqual(quiet);
				expect(
					Schema.decodeUnknownSync(SavedReminderSettings)(
						(yield* send(app, "GET", "/reminder-settings")).json,
					).settings,
				).toEqual(quiet);

				const created = yield* send(app, "POST", "/reminders", input);
				expect(created.status).toBe(201);
				const reminder = Schema.decodeUnknownSync(Reminder)(created.json);
				expect(reminder).toMatchObject(input);
				expect(
					remindersOf((yield* send(app, "GET", "/reminders")).json).reminders,
				).toEqual([reminder]);

				const { occurrences } = historyOf(
					(yield* send(app, "GET", "/reminder-occurrences")).json,
				);
				expect(occurrences).toHaveLength(2);
				for (const { occurrence, events } of occurrences) {
					expect(occurrence).toMatchObject({
						reminderId: reminder.id,
						kind: "medication",
						subjectId: "instruction-1",
						state: "scheduled",
						promptDue: false,
					});
					const at = Date.parse(occurrence.scheduledFor);
					expect(at).toBeGreaterThan(Date.now());
					expect(at).toBeLessThanOrEqual(Date.now() + 86_400_000);
					expect(input.times).toContain(wallClock(at, "UTC"));
					// The first prompt is due at the reminder time; 08:00 and 20:30 are outside quiet hours.
					expect(occurrence.nextPromptAt).toBe(occurrence.scheduledFor);
					expect(events).toEqual([
						expect.objectContaining({
							state: "scheduled",
							actor: "scheduler",
							source: "scheduler",
							response: null,
							wording: null,
						}),
					]);
				}

				// Another family sees nothing, and the database refuses it on its own.
				const other = yield* openFamily(config, "Other family");
				const otherApp = familyApp(other.db, other.familyId, reminderRoutes());
				expect(
					remindersOf((yield* send(otherApp, "GET", "/reminders")).json)
						.reminders,
				).toEqual([]);
				const id = occurrences[0]?.occurrence.id ?? "";
				expect(
					failure(yield* send(otherApp, "GET", `/reminder-occurrences/${id}`)),
				).toEqual([404, "not_found"]);
				const refused = yield* Effect.promise(() =>
					other.db.connection.reducers
						.answerReminder({
							occurrenceId: BigInt(id),
							clientId: "x",
							source: "phone",
							response: "done",
							wording: undefined,
						})
						.then(
							() => "accepted",
							(error: Error) => error.message,
						),
				);
				expect(refused).toBe("not a member of this family");

				// Deleting stops the reminder; its occurrences that are not yet due go with it.
				const deleted = yield* Effect.promise(async () =>
					app.request(`/reminders/${reminder.id}`, { method: "DELETE" }),
				);
				expect(deleted.status).toBe(204);
				expect(
					historyOf((yield* send(app, "GET", "/reminder-occurrences")).json)
						.occurrences,
				).toEqual([]);
				expect(
					remindersOf((yield* send(app, "GET", "/reminders")).json).reminders,
				).toEqual([]);
			}),
		));

	test("each answer records its own state; quiet hours hold a snooze in the wearer's zone", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Answers family");
				const app = familyApp(db, familyId, reminderRoutes());
				const zone = "America/New_York";
				// Quiet hours from one hour ago to three hours ahead, on the New York clock.
				const quietHours = {
					start: wallClock(Date.now() - 3_600_000, zone),
					end: wallClock(Date.now() + 3 * 3_600_000, zone),
				};
				yield* send(
					app,
					"PUT",
					"/reminder-settings",
					settings(zone, { quietHours, snoozeMinutes: 10 }),
				);
				const soon = wallClock(Date.now() + 30 * 60_000, zone);
				const times = ["01:00", "02:00", "03:00", "04:00", "05:00", "06:00"];
				yield* send(app, "POST", "/reminders", {
					kind: "meal",
					subjectId: null,
					title: "Synthetic lunch",
					times: [soon, ...times.filter((t) => t !== soon)].slice(0, 6),
				});
				const occurrences = historyOf(
					(yield* send(app, "GET", "/reminder-occurrences")).json,
				).occurrences.map((d) => d.occurrence);

				// A reminder time inside quiet hours keeps its time; its prompt waits for their end.
				const held = occurrences.find(
					(o) => wallClock(Date.parse(o.scheduledFor), zone) === soon,
				);
				expect(held).toBeDefined();
				expect(wallClock(Date.parse(held?.nextPromptAt ?? ""), zone)).toBe(
					quietHours.end,
				);

				const answer = (
					index: number,
					response: string,
					wording: string | null,
				) =>
					Effect.map(
						send(
							app,
							"POST",
							`/reminder-occurrences/${occurrences[index]?.id}/answers`,
							{ clientId: `a-${index}`, source: "phone", response, wording },
						),
						(r) => detailOf(r.json),
					);

				// "later": deferred by the snooze, then held to the end of quiet hours (local time).
				const later = yield* answer(0, "later", "In a bit");
				expect(later.occurrence.state).toBe("deferred");
				expect(
					wallClock(Date.parse(later.occurrence.nextPromptAt ?? ""), zone),
				).toBe(quietHours.end);
				// "okay" only acknowledges: follow-ups continue and nothing is complete.
				const okay = yield* answer(1, "okay", "okay");
				expect(okay.occurrence).toMatchObject({ state: "acknowledged" });
				expect(okay.occurrence.nextPromptAt).not.toBeNull();
				expect((yield* answer(2, "stop", "Stop it")).occurrence).toMatchObject({
					state: "declined",
					nextPromptAt: null,
				});
				const unsure = yield* answer(3, "unsure", "I don't remember if I ate");
				expect(unsure.occurrence).toMatchObject({
					state: "unresolved",
					nextPromptAt: null,
				});
				expect(unsure.events.at(-1)).toMatchObject({
					state: "unresolved",
					response: "unsure",
					wording: "I don't remember if I ate",
					actor: db.identity,
					source: "phone",
				});
				expect((yield* answer(4, "help", "Help me")).occurrence.state).toBe(
					"unresolved",
				);
				const repeat = yield* answer(5, "repeat", "What?");
				expect(repeat.occurrence).toMatchObject({
					state: "scheduled",
					promptDue: true,
				});
				// After prompts end, only a completion still records.
				expect(
					failure(
						yield* send(
							app,
							"POST",
							`/reminder-occurrences/${occurrences[2]?.id}/answers`,
							{
								clientId: "late",
								source: "web",
								response: "later",
								wording: null,
							},
						),
					),
				).toEqual([409, "conflict"]);
			}),
		));

	test(
		"one occurrence from the database clock: acknowledged is not complete, silence ends unresolved, a retry records once, and prompts run while the server is down",
		() =>
			withDb((config) =>
				Effect.gen(function* () {
					// The "server" that saves the reminder, then stops: its connection closes.
					const saved = yield* Effect.scoped(
						Effect.gen(function* () {
							const { db, familyId } = yield* openFamily(
								config,
								"Clock family",
							);
							const app = familyApp(db, familyId, reminderRoutes());
							yield* send(app, "PUT", "/reminder-settings", settings("UTC"));
							// At least 10 s ahead, so the database never sees this minute as past.
							const time = wallClock(Date.now() + 70_000, "UTC");
							const reminder = Schema.decodeUnknownSync(Reminder)(
								(yield* send(app, "POST", "/reminders", {
									kind: "medication",
									subjectId: "instruction-2",
									title: "Synthetic tablet",
									times: [time],
								})).json,
							);
							const [first] = historyOf(
								(yield* send(app, "GET", "/reminder-occurrences")).json,
							).occurrences;
							return { familyId, token: db.token, reminder, first };
						}),
					);
					const occurrence = saved.first?.occurrence;
					if (occurrence === undefined) throw new Error("no occurrence");
					// No connection is open until the prompt is due.
					yield* Effect.sleep(
						Math.max(0, Date.parse(occurrence.scheduledFor) - Date.now()) +
							3_000,
					);

					// The restarted server, as the same identity.
					const db = yield* openFamilyDb({ ...config, token: saved.token });
					const caregiver = yield* joinAs(config, db, saved.familyId);
					const app = familyApp(db, saved.familyId, reminderRoutes());
					const path = `/reminder-occurrences/${occurrence.id}`;
					const read = Effect.map(send(app, "GET", path), (r) =>
						detailOf(r.json),
					);
					const post = (kind: string, body: object, caller = app) =>
						send(caller, "POST", `${path}/${kind}`, body);

					expect((yield* read).occurrence).toMatchObject({
						state: "scheduled",
						promptDue: true,
						prompts: 1,
					});
					const delivery = { clientId: "d-1", source: "phone" };
					yield* post("deliveries", delivery);
					yield* post("deliveries", delivery);
					const okay = {
						clientId: "o-1",
						source: "glasses",
						response: "dismissed",
						wording: null,
					};
					yield* post("answers", okay);
					const acknowledged = detailOf((yield* post("answers", okay)).json);
					expect(acknowledged.occurrence.state).toBe("acknowledged");
					expect(
						failure(yield* post("answers", { ...okay, response: "done" })),
					).toEqual([400, "invalid_request"]);

					// The follow-up comes due with the prompt limit reached: unresolved, by the scheduler.
					yield* Effect.sleep(
						Math.max(
							0,
							Date.parse(acknowledged.occurrence.nextPromptAt ?? "") -
								Date.now(),
						) + 3_000,
					);
					const settled = yield* read;
					expect(settled.occurrence).toMatchObject({
						state: "unresolved",
						promptDue: false,
						nextPromptAt: null,
					});
					// Silence contacted nobody: no alert and no family message.
					const records = readFamilyRecords(db);
					expect(records.alerts).toEqual([]);
					expect(records.messages).toEqual([]);

					// A late self-report records once; a caregiver's confirmation is a separate state.
					const late = {
						clientId: "l-1",
						source: "phone",
						response: "already_did_it",
						wording: "I took it with breakfast",
					};
					yield* post("answers", late);
					yield* post("answers", late);
					yield* post("answers", {
						...late,
						clientId: "l-2",
						response: "done",
					});
					const caregiverApp = familyApp(
						caregiver,
						saved.familyId,
						reminderRoutes(),
					);
					const confirm = {
						clientId: "c-1",
						source: "web",
						wording: "Saw the empty slot",
					};
					yield* post("confirmations", confirm, caregiverApp);
					const final = detailOf(
						(yield* post("confirmations", confirm, caregiverApp)).json,
					);

					expect(
						final.events.map((e) => [
							e.state,
							e.response,
							e.actor,
							e.source,
							e.wording,
						]),
					).toEqual([
						["scheduled", null, "scheduler", "scheduler", null],
						["delivered", null, db.identity, "phone", null],
						["acknowledged", "dismissed", db.identity, "glasses", null],
						["unresolved", null, "scheduler", "scheduler", null],
						[
							"self_reported_complete",
							"already_did_it",
							db.identity,
							"phone",
							"I took it with breakfast",
						],
						[
							"caregiver_confirmed",
							null,
							caregiver.identity,
							"web",
							"Saw the empty slot",
						],
					]);
					expect(new Set(final.events.map((e) => e.id)).size).toBe(6);
					expect(final.occurrence.state).toBe("caregiver_confirmed");

					// The same history reads back for the caregiver, with the next day already scheduled.
					const history = historyOf(
						(yield* send(caregiverApp, "GET", "/reminder-occurrences")).json,
					).occurrences;
					expect(
						history.find((d) => d.occurrence.id === occurrence.id),
					).toEqual(final);
					const next = history.find((d) => d.occurrence.id !== occurrence.id);
					expect(next?.occurrence).toMatchObject({
						reminderId: saved.reminder.id,
						state: "scheduled",
					});
					expect(
						Date.parse(next?.occurrence.scheduledFor ?? "") -
							Date.parse(occurrence.scheduledFor),
					).toBe(86_400_000);
				}),
			),
		240_000,
	);
});
