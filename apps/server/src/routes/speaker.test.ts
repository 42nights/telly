// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). All records are
// synthetic, and the speaker is the simulator: nothing plays sound or leaves this process.
import { describe, expect, test } from "bun:test";
import {
	ReminderHistory,
	ReminderOccurrenceDetail,
} from "@health/contracts/reminders";
import {
	SavedSpeakerSettings,
	SpeakerHandoff,
	SpeakerStatus,
} from "@health/contracts/speaker";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import type { FamilyEnv } from "../http";
import { reminderRoutes } from "./reminders";
import { speakerRoutes } from "./speaker";
import {
	dbConfig,
	failure,
	familyApp,
	openFamily,
	send,
	withDb,
} from "./test-family";

const handoffOf = Schema.decodeUnknownSync(SpeakerHandoff);

describe.skipIf(dbConfig === undefined)("home-speaker handoff", () => {
	test("off by default; a shared room hears only a nudge; the phone covers an offline or refusing speaker; nothing is said twice", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Speaker family");
				const app = familyApp(
					db,
					familyId,
					new Hono<FamilyEnv>()
						.route("/", reminderRoutes())
						.route("/", speakerRoutes()),
				);
				yield* send(app, "PUT", "/reminder-settings", {
					timeZone: "UTC",
					quietHours: null,
					repeatEveryMinutes: 30,
					maxPrompts: 3,
					snoozeMinutes: 10,
				});
				// Times far from now, so no database timer runs during the test.
				const hour = (new Date().getUTCHours() + 12) % 24;
				const times = [0, 1, 2, 3, 4].map(
					(m) =>
						`${String(hour).padStart(2, "0")}:${String(m * 10).padStart(2, "0")}`,
				);
				yield* send(app, "POST", "/reminders", {
					kind: "medication",
					subjectId: null,
					title: "Synthetic blood pressure tablet",
					times,
				});
				const occurrences = Schema.decodeUnknownSync(ReminderHistory)(
					(yield* send(app, "GET", "/reminder-occurrences")).json,
				).occurrences.map((d) => d.occurrence.id);
				const path = (i: number) => `/reminder-occurrences/${occurrences[i]}`;
				// "repeat" makes the prompt due at once, as a database prompt would.
				const makeDue = (i: number) =>
					send(app, "POST", `${path(i)}/answers`, {
						clientId: `due-${i}`,
						source: "phone",
						response: "repeat",
						wording: null,
					});
				const handoff = (i: number, clientId: string) =>
					Effect.map(
						send(app, "POST", `${path(i)}/speaker-handoffs`, { clientId }),
						(r) => handoffOf(r.json),
					);
				const settings = (body: object) =>
					Effect.map(send(app, "PUT", "/speaker-settings", body), (r) =>
						Schema.decodeUnknownSync(SavedSpeakerSettings)(r.json),
					);
				const speaker = Effect.map(send(app, "GET", "/speaker"), (r) =>
					Schema.decodeUnknownSync(SpeakerStatus)(r.json),
				);

				// Off until the wearer enables it: the phone gives the prompt.
				expect((yield* send(app, "GET", "/speaker-settings")).json).toEqual({
					settings: { enabled: false, room: "shared", sharedRoomKinds: [] },
					updatedBy: null,
					updatedAt: null,
				});
				yield* makeDue(0);
				const off = yield* handoff(0, "h-0");
				expect(off).toMatchObject({
					outcome: "use_phone",
					reason: "disabled",
					announcement: null,
				});
				expect(off.detail.occurrence.promptDue).toBe(true);

				// Enabled in a shared room with no allowed kinds: a nudge without health details.
				const saved = yield* settings({
					enabled: true,
					room: "shared",
					sharedRoomKinds: [],
				});
				expect(saved.updatedBy).toBe(db.identity);
				const spoken = yield* handoff(0, "h-1");
				expect(spoken).toMatchObject({
					outcome: "spoken",
					reason: null,
					announcement: "You have a reminder. Please check your phone.",
				});
				expect(spoken.detail.occurrence).toMatchObject({
					state: "delivered",
					promptDue: false,
				});
				// A retry, a second handoff, and the phone's own delivery add nothing.
				expect((yield* handoff(0, "h-1")).outcome).toBe("nothing_due");
				expect((yield* handoff(0, "h-2")).outcome).toBe("nothing_due");
				yield* send(app, "POST", `${path(0)}/deliveries`, {
					clientId: "p-0",
					source: "phone",
				});
				// The wearer answers on the phone: acknowledged, then completed, each from its own device.
				for (const [clientId, response] of [
					["a-0", "okay"],
					["a-1", "done"],
				])
					yield* send(app, "POST", `${path(0)}/answers`, {
						clientId,
						source: "phone",
						response,
						wording: null,
					});
				const final = handoffOf(
					(yield* send(app, "POST", `${path(0)}/speaker-handoffs`, {
						clientId: "h-3",
					})).json,
				);
				expect(final.outcome).toBe("nothing_due");
				expect(final.detail.events.map((e) => [e.state, e.source])).toEqual([
					["scheduled", "scheduler"],
					["scheduled", "phone"],
					["delivered", "speaker"],
					["acknowledged", "phone"],
					["self_reported_complete", "phone"],
				]);
				expect((yield* speaker).announcements).toHaveLength(1);

				// The wearer allows medication titles in the shared room.
				yield* settings({
					enabled: true,
					room: "shared",
					sharedRoomKinds: ["medication"],
				});
				yield* makeDue(1);
				expect((yield* handoff(1, "h-4")).announcement).toBe(
					"Reminder: Synthetic blood pressure tablet.",
				);

				// Offline, then refusing: nothing is said, and the prompt stays due for the phone.
				for (const [i, mode] of [
					[2, "offline"],
					[3, "refused"],
				] as const) {
					yield* send(app, "PUT", "/speaker/simulator", { mode });
					yield* makeDue(i);
					const fallback = yield* handoff(i, `h-${mode}`);
					expect(fallback).toMatchObject({
						outcome: "use_phone",
						reason: mode,
						announcement: null,
					});
					expect(fallback.detail.occurrence.promptDue).toBe(true);
					const phone = yield* send(app, "POST", `${path(i)}/deliveries`, {
						clientId: `p-${i}`,
						source: "phone",
					});
					expect(
						Schema.decodeUnknownSync(ReminderOccurrenceDetail)(
							phone.json,
						).events.at(-1),
					).toMatchObject({ state: "delivered", source: "phone" });
				}
				const status = yield* speaker;
				expect(status.mode).toBe("refused");
				expect(status.announcements.map((a) => a.text)).toEqual([
					"Reminder: Synthetic blood pressure tablet.",
					"You have a reminder. Please check your phone.",
				]);

				// Back online, a private room says the title of any kind.
				yield* send(app, "PUT", "/speaker/simulator", { mode: "online" });
				yield* settings({
					enabled: true,
					room: "private",
					sharedRoomKinds: [],
				});
				yield* makeDue(4);
				expect((yield* handoff(4, "h-5")).outcome).toBe("spoken");

				// Only reminder kinds; clients cannot claim to be the speaker.
				expect(
					failure(
						yield* send(app, "PUT", "/speaker-settings", {
							enabled: true,
							room: "shared",
							sharedRoomKinds: ["diagnosis"],
						}),
					),
				).toEqual([400, "invalid_request"]);
				expect(
					failure(
						yield* send(app, "POST", `${path(4)}/deliveries`, {
							clientId: "fake",
							source: "speaker",
						}),
					),
				).toEqual([400, "invalid_request"]);
			}),
		));
});
