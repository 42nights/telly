// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). The dispatcher
// is a fake that records each handoff; the test also counts every outbound `fetch` to prove that no
// scenario reaches a real dialer. All records are synthetic.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Handoff } from "@health/contracts/emergency";
import { EmergencyOutcome } from "@health/contracts/emergency";
import { Effect, Schema } from "effect";
import { readFamilyRecords } from "../db";
import { careProfileRoutes } from "./care-profile";
import { type Dispatcher, emergencyRoutes } from "./emergency";
import {
	dbConfig,
	failure,
	familyApp,
	openFamily,
	send,
	setOwnScopes,
	withDb,
} from "./test-family";

const decode = Schema.decodeUnknownSync(EmergencyOutcome);
const wearer = { name: "Synthetic Wearer", callback: "+1 555 0100" };
const fix = (ageSeconds: number) => ({
	status: "fix",
	latitude: 37.4,
	longitude: -122.1,
	accuracyMeters: 25,
	capturedAt: new Date(Date.now() - ageSeconds * 1000).toISOString(),
});
const ouch = (kind = "ouch", report = "ouch") => ({
	kind,
	report,
	observedAt: new Date().toISOString(),
});

let outbound = 0;
const realFetch = globalThis.fetch;
beforeEach(() => {
	outbound = 0;
	globalThis.fetch = Object.assign(
		(...args: Parameters<typeof fetch>) => {
			outbound += 1;
			return realFetch(...args);
		},
		{ preconnect: realFetch.preconnect },
	);
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe.skipIf(dbConfig === undefined)("emergency requests", () => {
	test("help dispatches at once, a check-in decides an ouch, and nothing else dispatches", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Emergency family");
				yield* setOwnScopes(db, familyId, ["health_records"], false);
				const calls: Handoff[] = [];
				let answer: "connected" | "failed" = "connected";
				const fake: Dispatcher = async (handoff) => {
					calls.push(handoff);
					return answer;
				};
				const app = familyApp(db, familyId, emergencyRoutes(fake));
				const post = (path: string, body: unknown) =>
					send(app, "POST", path, body).pipe(
						Effect.map((r) => ({ status: r.status, outcome: decode(r.json) })),
					);

				// Explicit help: dispatched with no questions, family alerted, record not claimed.
				const help = yield* post("/emergency", {
					kind: "help",
					report: "Call 911",
					wearer,
					location: fix(30),
				});
				expect(help.outcome).toMatchObject({
					action: "dispatch",
					call: {
						simulated: true,
						states: ["connecting", "connected"],
						recordDelivered: false,
					},
					handoff: {
						name: "Synthetic Wearer",
						callback: "+1 555 0100",
						report: "Call 911",
						responsiveness: "responding",
						care: {
							status: "unavailable",
							reason: "Your care access does not include health records.",
						},
						location: { status: "current", accuracyMeters: 25 },
					},
					family: { status: "raised" },
				});
				expect(calls).toHaveLength(1);

				// An ouch gets a check-in; a television voice neither dispatches nor cancels it.
				const event = ouch();
				const checkIn = yield* post("/emergency", { kind: "event", event });
				expect(checkIn.outcome).toMatchObject({
					action: "check_in",
					reason: null,
				});
				const tv = yield* post("/emergency/check-in", {
					event,
					reply: { kind: "speech", speaker: "other", text: "Help! Call 911!" },
					wearer,
					location: fix(30),
				});
				expect(tv.outcome).toMatchObject({
					action: "check_in",
					reason: "other_voice",
				});

				// The wearer denies: no dispatch, safety stays unconfirmed, the family still hears.
				const denied = yield* post("/emergency/check-in", {
					event,
					reply: { kind: "speech", speaker: "wearer", text: "No, I'm fine" },
					wearer,
					location: fix(30),
				});
				expect(denied.outcome).toMatchObject({
					action: "none",
					reason: "denied",
					safety: "unconfirmed",
					family: { status: "raised" },
				});

				// "I'm not ok" is a request for help, not a denial.
				const notOk = yield* post("/emergency/check-in", {
					event,
					reply: { kind: "speech", speaker: "wearer", text: "I'm not ok" },
					wearer,
					location: fix(30),
				});
				expect(notOk.outcome).toMatchObject({ action: "dispatch" });
				expect(calls).toHaveLength(2);

				// Suspected fall with no reply and a denied location: dispatched as not responding.
				const fall = yield* post("/emergency/check-in", {
					event: ouch("possible_fall", "thud"),
					reply: { kind: "no_response", waitedSeconds: 30 },
					wearer: { name: null, callback: null },
					location: { status: "denied" },
				});
				expect(fall.outcome).toMatchObject({
					action: "dispatch",
					handoff: {
						name: null,
						responsiveness: "not_responding",
						location: { status: "denied" },
					},
				});

				// An old fix is last known, with its age.
				const stale = yield* post("/emergency/check-in", {
					event,
					reply: { kind: "speech", speaker: "wearer", text: "yes" },
					wearer,
					location: fix(900),
				});
				expect(stale.outcome).toMatchObject({
					handoff: { location: { status: "last_known" } },
				});

				// The call fails: reported as failed, never as connected.
				answer = "failed";
				const failed = yield* post("/emergency", {
					kind: "help",
					report: null,
					wearer,
					location: { status: "unavailable" },
				});
				expect(failed.outcome).toMatchObject({
					call: { states: ["connecting", "failed"], outcome: "failed" },
				});
				expect(calls).toHaveLength(5);

				// A missed reminder or unheard vibration alone never dispatches or starts a check-in.
				for (const kind of ["missed_reminder", "unheard_vibration"]) {
					const missed = yield* post("/emergency", {
						kind: "event",
						event: ouch(kind, "Take your 9 am pills"),
					});
					expect(missed.outcome).toEqual({
						action: "none",
						reason: "not_an_emergency",
						safety: "unconfirmed",
						family: null,
					});
					const forced = yield* send(app, "POST", "/emergency/check-in", {
						event: ouch(kind, "Take your 9 am pills"),
						reply: { kind: "no_response", waitedSeconds: 30 },
						wearer,
						location: fix(30),
					});
					expect(failure(forced)).toEqual([400, "invalid_request"]);
				}
				expect(calls).toHaveLength(5);

				// Call my family: an alert only, no dispatch.
				const family = yield* post("/emergency", {
					kind: "family",
					report: null,
				});
				expect(family.outcome).toMatchObject({
					action: "family",
					family: { status: "raised" },
				});
				expect(calls).toHaveLength(5);

				// With health_records access, the handoff carries the saved care facts (#26): the
				// profile's name when the device sends none, and only verified medicines.
				const care = familyApp(db, familyId, careProfileRoutes());
				yield* setOwnScopes(db, familyId, ["health_records"], true);
				yield* send(care, "PUT", "/care-profile", {
					preferredName: "Synthetic Sam",
					language: "en",
					timeZone: null,
					accessibilityNeeds: null,
					diagnoses: null,
					allergies: ["synthetic-penicillin"],
					dietaryRestrictions: null,
					fluidRestrictions: null,
					activityRestrictions: null,
					routines: null,
					contacts: null,
					familiarDestinations: null,
					devices: null,
					declinedPrompts: [],
				});
				const medicine = (name: string) => ({
					kind: "medication",
					name,
					instruction: "1 tablet",
					times: ["08:00"],
					reason: null,
					source: "pharmacy label",
					effectiveDate: "2026-10-01",
				});
				yield* send(
					care,
					"POST",
					"/care-instructions",
					medicine("Synthetic A"),
				);
				yield* send(
					care,
					"POST",
					"/care-instructions",
					medicine("Synthetic B"),
				);
				const first = [...db.connection.db.myCareInstructions.iter()].find(
					(row) => row.name === "Synthetic A",
				);
				yield* send(care, "POST", `/care-instructions/${first?.id}/verify`);
				const profiled = yield* post("/emergency", {
					kind: "help",
					report: null,
					wearer: { name: null, callback: null },
					location: { status: "unavailable" },
				});
				expect(profiled.outcome).toMatchObject({
					handoff: {
						name: "Synthetic Sam",
						care: {
							status: "available",
							conditions: null,
							allergies: ["synthetic-penicillin"],
							medications: ["Synthetic A"],
						},
					},
				});

				// Every raised alert is in the family's durable alert records.
				const summaries = readFamilyRecords(db).alerts.map((a) => a.summary);
				expect(
					summaries.filter((s) => s.includes("simulated call")),
				).toHaveLength(6);
				expect(summaries).toContain("Asked to reach the family.");
				expect(outbound).toBe(0);
			}),
		));
});
