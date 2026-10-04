// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). No route
// places a call (the phone dials from a `tel:` link); the test also counts every outbound `fetch`
// to prove that no scenario reaches a dialer. All records are synthetic.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EmergencyOutcome } from "@health/contracts/emergency";
import { Effect, Schema } from "effect";
import { openFamilyDb, readFamilyRecords } from "../db";
import { careProfileRoutes } from "./care-profile";
import { emergencyRoutes } from "./emergency";
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
	test("help alerts the family at once, a check-in decides an ouch, and nothing else asks for help", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Emergency family");
				yield* setOwnScopes(db, familyId, ["health_records"], false);
				const app = familyApp(db, familyId, emergencyRoutes());
				const helpAlerts = () =>
					readFamilyRecords(db).alerts.filter((a) =>
						a.summary.startsWith("Emergency help requested: "),
					).length;
				const post = (path: string, body: unknown) =>
					send(app, "POST", path, body).pipe(
						Effect.map((r) => ({ status: r.status, outcome: decode(r.json) })),
					);

				// Explicit help: no questions, the family is alerted, the handoff is returned.
				const help = yield* post("/emergency", {
					kind: "help",
					report: "Call 911",
					wearer,
					location: fix(30),
				});
				expect(help.outcome).toMatchObject({
					action: "help",
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
				expect(helpAlerts()).toBe(1);

				// An ouch gets a check-in; a television voice neither asks for help nor cancels it.
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

				// The wearer denies: no help request, safety stays unconfirmed, the family still hears.
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
				expect(notOk.outcome).toMatchObject({ action: "help" });
				expect(helpAlerts()).toBe(2);

				// Suspected fall with no reply and a denied location: help, as not responding.
				const fall = yield* post("/emergency/check-in", {
					event: ouch("possible_fall", "thud"),
					reply: { kind: "no_response", waitedSeconds: 30 },
					wearer: { name: null, callback: null },
					location: { status: "denied" },
				});
				expect(fall.outcome).toMatchObject({
					action: "help",
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
				// A missed reminder or unheard vibration alone never asks for help or starts a check-in.
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
				expect(helpAlerts()).toBe(4);

				// Call my family: an alert only, no help request.
				const family = yield* post("/emergency", {
					kind: "family",
					report: null,
				});
				expect(family.outcome).toMatchObject({
					action: "family",
					family: { status: "raised" },
				});
				expect(helpAlerts()).toBe(4);

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
				expect(helpAlerts()).toBe(5);
				expect(summaries).toContain("Asked to reach the family.");
				expect(outbound).toBe(0);
			}),
		));

	test("an unclear reply asks again, and a failed alert never holds back the outcome", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Emergency faults");
				const app = familyApp(db, familyId, emergencyRoutes());
				const post = (target: typeof app, path: string, body: unknown) =>
					send(target, "POST", path, body).pipe(
						Effect.map((r) => ({ status: r.status, outcome: decode(r.json) })),
					);
				const event = ouch();

				// Neither help nor a denial: the check-in asks again, nothing alerts.
				const alertsBefore = readFamilyRecords(db).alerts.length;
				const unclear = yield* post(app, "/emergency/check-in", {
					event,
					reply: { kind: "speech", speaker: "wearer", text: "what time is it" },
					wearer,
					location: fix(30),
				});
				expect(unclear.status).toBe(200);
				expect(unclear.outcome).toEqual({
					action: "check_in",
					prompt: "I didn't catch that. Do you need help? Say yes or no.",
					event: { ...event, kind: "ouch" },
					reason: "unclear",
				});
				expect(readFamilyRecords(db).alerts).toHaveLength(alertsBefore);

				// "I don't need help" is a denial, though it contains "help".
				const noHelp = yield* post(app, "/emergency/check-in", {
					event,
					reply: {
						kind: "speech",
						speaker: "wearer",
						text: "I don't need help",
					},
					wearer,
					location: fix(30),
				});
				expect(noHelp.outcome).toMatchObject({
					action: "none",
					reason: "denied",
					family: { status: "raised" },
				});

				// A caller outside the family cannot raise the alert: the failure is reported, and the
				// handoff for the operator is still returned.
				const outsider = yield* openFamilyDb(config);
				const foreign = familyApp(outsider, familyId, emergencyRoutes());
				const help = yield* post(foreign, "/emergency", {
					kind: "help",
					report: null,
					wearer,
					location: { status: "unavailable" },
				});
				expect(help.outcome).toMatchObject({
					action: "help",
					handoff: { care: { status: "unavailable" } },
					family: {
						status: "failed",
						message: "not a member of this family",
					},
				});
				const family = yield* post(foreign, "/emergency", {
					kind: "family",
					report: null,
				});
				expect(family.outcome).toEqual({
					action: "family",
					family: { status: "failed", message: "not a member of this family" },
				});
				expect(
					readFamilyRecords(db).alerts.filter(
						(a) => a.raisedBy === outsider.identity,
					),
				).toEqual([]);
				expect(outbound).toBe(0);
			}),
		));
});
