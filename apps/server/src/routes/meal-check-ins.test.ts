// Meal and drink check-ins (issue #32) against a real local SpacetimeDB (`bun run db:test`): an
// unresolved meal or hydration occurrence asks the family contact ladder (#30) once. The silent case
// runs on the database's own reminder timers, so this test waits about three minutes. All records
// and people are synthetic test identities; nothing leaves the database.
import { describe, expect, test } from "bun:test";
import { CareNeeds } from "@health/contracts/care";
import { ReminderHistory } from "@health/contracts/reminders";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { Identity } from "spacetimedb";
import { openFamilyDb } from "../db";
import type { FamilyEnv } from "../http";
import { careRoutes } from "./care";
import { reminderRoutes } from "./reminders";
import { dbConfig, familyApp, openFamily, send, withDb } from "./test-family";

const needsOf = Schema.decodeUnknownSync(CareNeeds);
const historyOf = Schema.decodeUnknownSync(ReminderHistory);

/** `HH:MM` in UTC at `ms`. */
const utcClock = (ms: number) => new Date(ms).toISOString().slice(11, 16);

describe.skipIf(dbConfig === undefined)("meal and drink check-ins", () => {
	test(
		"help and silence on a meal or drink ask the family ladder once; other kinds and ladderless families ask nobody",
		() =>
			withDb((config) =>
				Effect.gen(function* () {
					const { db, familyId } = yield* openFamily(config, "Meal family");
					const caregiver = yield* openFamilyDb(config);
					yield* Effect.promise(() =>
						db.connection.reducers.addFamilyMember({
							familyId: BigInt(familyId),
							member: Identity.fromString(caregiver.identity),
						}),
					);
					const routes = new Hono<FamilyEnv>()
						.route("/", reminderRoutes())
						.route("/care", careRoutes());
					const app = familyApp(db, familyId, routes);
					const needs = Effect.map(
						send(app, "GET", "/care/needs"),
						(r) => needsOf(r.json).needs,
					);

					yield* send(app, "PUT", "/care/ladder", {
						contacts: [
							{
								member: caregiver.identity,
								name: "Synthetic caregiver",
								timeZone: "UTC",
								detail: "summary",
								callFor: [],
							},
						],
						backup: null,
						answerSeconds: 600,
						followUpSeconds: 600,
					});
					yield* send(app, "PUT", "/reminder-settings", {
						timeZone: "UTC",
						quietHours: null,
						repeatEveryMinutes: 1,
						maxPrompts: 1,
						snoozeMinutes: 1,
					});
					// At least 10 s ahead, so the database never sees this minute as past.
					const soon = utcClock(Date.now() + 70_000);
					const later = utcClock(Date.now() + 3 * 3_600_000);
					for (const [kind, title, time] of [
						["meal", "Synthetic lunch", later],
						["medication", "Synthetic tablet", later],
						["hydration", "Synthetic water", soon],
					] as const)
						yield* send(app, "POST", "/reminders", {
							kind,
							subjectId: null,
							title,
							times: [time],
						});
					const occurrences = historyOf(
						(yield* send(app, "GET", "/reminder-occurrences")).json,
					).occurrences.map((d) => d.occurrence);
					const idOf = (kind: string) => {
						const found = occurrences.find((o) => o.kind === kind);
						if (found === undefined) throw new Error(`no ${kind} occurrence`);
						return found;
					};
					const help = (id: string, clientId: string) =>
						send(app, "POST", `/reminder-occurrences/${id}/answers`, {
							clientId,
							source: "web",
							response: "help",
							wording: "I can't open it",
						});

					// A request for help on a meal opens one need.
					const meal = idOf("meal");
					expect((yield* help(meal.id, "h-1")).status).toBe(200);
					// Help on another kind of reminder contacts nobody.
					expect((yield* help(idOf("medication").id, "h-2")).status).toBe(200);
					expect(
						(yield* needs).map(({ kind, summary, clientId }) => ({
							kind,
							summary,
							clientId,
						})),
					).toEqual([
						{
							kind: "help",
							summary: "Synthetic lunch: I can't open it",
							clientId: `reminder-${meal.id}`,
						},
					]);

					// Silence: the hydration prompt is given once, then ends unresolved and asks the ladder.
					const water = idOf("hydration");
					yield* Effect.sleep(
						Math.max(0, Date.parse(water.scheduledFor) - Date.now()) + 65_000,
					);
					const after = historyOf(
						(yield* send(app, "GET", "/reminder-occurrences")).json,
					).occurrences.find((d) => d.occurrence.id === water.id);
					expect(after?.occurrence.state).toBe("unresolved");
					expect(after?.events.at(-1)).toMatchObject({
						state: "unresolved",
						source: "scheduler",
					});
					const silent = (yield* needs).filter(
						(n) => n.clientId === `reminder-${water.id}`,
					);
					expect(silent.map((n) => [n.kind, n.summary])).toEqual([
						["help", "Synthetic water: no answer after 1 prompts"],
					]);
					expect(silent[0]?.attempts[0]?.member).toBe(caregiver.identity);
				}),
			),
		240_000,
	);

	test("a family without a contact ladder gets no care need from a meal check-in", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "No ladder family");
				const routes = new Hono<FamilyEnv>()
					.route("/", reminderRoutes())
					.route("/care", careRoutes());
				const app = familyApp(db, familyId, routes);
				yield* send(app, "PUT", "/reminder-settings", {
					timeZone: "UTC",
					quietHours: null,
					repeatEveryMinutes: 1,
					maxPrompts: 1,
					snoozeMinutes: 1,
				});
				yield* send(app, "POST", "/reminders", {
					kind: "meal",
					subjectId: null,
					title: "Synthetic dinner",
					times: [utcClock(Date.now() + 3 * 3_600_000)],
				});
				const [first] = historyOf(
					(yield* send(app, "GET", "/reminder-occurrences")).json,
				).occurrences;
				const answered = yield* send(
					app,
					"POST",
					`/reminder-occurrences/${first?.occurrence.id}/answers`,
					{ clientId: "h-1", source: "web", response: "help", wording: null },
				);
				expect(answered.status).toBe(200);
				expect(
					needsOf((yield* send(app, "GET", "/care/needs")).json).needs,
				).toEqual([]);
			}),
		));
});
