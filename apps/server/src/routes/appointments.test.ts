// Runs against a real local SpacetimeDB with the module published (`bun run db:test`) and a local
// server that answers FinchNode's documented record read. All records are synthetic.
import { afterAll, describe, expect, test } from "bun:test";
import {
	Appointment,
	Appointments,
	ClinicianShare,
	ClinicianShares,
	type NewAppointment,
	PrepSummary,
} from "@health/contracts/appointments";
import { Report } from "@health/contracts/reports";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { Identity } from "spacetimedb";
import { type FamilyDb, openFamilyDb } from "../db";
import type { FamilyEnv } from "../http";
import type { Finchnode } from "../integrations/finchnode";
import { appointmentRoutes } from "./appointments";
import { reportRoutes } from "./reports";
import {
	dbConfig,
	failure,
	familyApp,
	openFamily,
	send,
	withDb,
} from "./test-family";

const subject = "u_00000000000000c3";
const lab = {
	id: "rec_000000000000000000000044",
	name: "Hemoglobin A1c",
	value: "6.1",
	unit: "%",
	status: "final",
	date: "2026-09-12T09:00:00Z",
	referenceRange: "Synthetic reference: below 5.7%",
	interpretation: "H",
	source: "synthetic-ehr",
	sourceName: "Synthetic Health System",
	sourceRecordId: "Observation/syn-a1c",
	codes: [],
	sourceUpdatedAt: "2026-09-12T10:00:00Z",
	syncedAt: "2026-09-12T10:05:00Z",
};
const protocol = Bun.serve({
	port: 0,
	fetch: (request) =>
		new URL(request.url).pathname === `/users/${subject}/records`
			? Response.json({
					sources: [],
					data: { labs: [lab] },
					meta: {
						syncStatus: "complete",
						dataAsOf: lab.syncedAt,
						warnings: [],
					},
				})
			: Response.json({ error: { code: "not_found" } }, { status: 404 }),
});
afterAll(() => protocol.stop());
const finchnode: Finchnode = {
	kind: "api",
	baseUrl: `http://127.0.0.1:${protocol.port}`,
	apiKey: "ck_test_protocol",
	synthetic: true,
};

const suggestion: NewAppointment = {
	source: "model",
	visit: {
		title: "Memory clinic follow-up",
		clinician: "Dr. Synthetic",
		location: "Synthetic Clinic, Room 4",
		startsAt: "2026-10-20T09:30:00.000Z",
		timeZone: "Europe/London",
	},
	prep: {
		transportation: "Daughter drives; leave at 10:00",
		reminders: [1440, 120],
		symptoms: ["More confused in the evenings"],
		medication: ["Unsure whether the evening dose was taken on Tuesday"],
		eatingSleep: ["Skips breakfast", "Wakes at 3 am"],
		questions: ["Should the evening dose move earlier?"],
	},
};

const routes = () =>
	new Hono<FamilyEnv>()
		.route("/", reportRoutes())
		.route("/", appointmentRoutes(finchnode));

/** Grants or revokes `clinician_delivery` for the caller; a family's founder may set up sharing. */
const grant = (db: FamilyDb, familyId: string, granted: boolean) =>
	Effect.promise(() =>
		db.connection.reducers.setCareGrant({
			familyId: BigInt(familyId),
			member: Identity.fromString(db.identity),
			scope: "clinician_delivery",
			granted,
		}),
	);

describe.skipIf(dbConfig === undefined)("appointments", () => {
	test("a suggestion becomes a booking only after a request and the provider's confirmation", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Visit family");
				const app = familyApp(db, familyId, routes());

				const created = yield* send(app, "POST", "/appointments", suggestion);
				expect(created.status).toBe(201);
				const suggested = Schema.decodeUnknownSync(Appointment)(created.json);
				expect(suggested.status).toBe("suggested");
				expect(suggested.suggestion.source).toBe("model");
				expect(suggested.visit).toEqual(suggestion.visit);
				const path = `/appointments/${suggested.id}`;
				expect(
					Schema.decodeUnknownSync(Appointments)(
						(yield* send(app, "GET", "/appointments")).json,
					).appointments,
				).toEqual([suggested]);

				// A suggestion cannot skip the request, by API or by direct reducer call.
				const confirmation = { reference: "SYN-REF-1", receivedVia: "phone" };
				const early = yield* send(
					app,
					"POST",
					`${path}/confirmation`,
					confirmation,
				);
				expect(failure(early)).toEqual([400, "invalid_request"]);
				const direct = yield* Effect.promise(() =>
					db.connection.reducers
						.confirmAppointment({ id: suggested.id, confirmation: "{}" })
						.then(String, String),
				);
				expect(direct).toBe(
					"SenderError: only a requested appointment can be confirmed",
				);

				// A request needs the member's explicit confirmation in the body.
				const unconfirmed = yield* send(app, "POST", `${path}/request`, {
					confirm: false,
				});
				expect(failure(unconfirmed)).toEqual([400, "invalid_request"]);
				const requested = yield* send(app, "POST", `${path}/request`, {
					confirm: true,
				});
				const request = Schema.decodeUnknownSync(Appointment)(requested.json);
				expect(request.status).toBe("requested");
				expect(request.request?.by).toBe(db.identity);
				expect(request.confirmation).toBeNull();

				const booked = yield* send(
					app,
					"POST",
					`${path}/confirmation`,
					confirmation,
				);
				const confirmed = Schema.decodeUnknownSync(Appointment)(booked.json);
				expect(confirmed.status).toBe("confirmed");
				expect(confirmed.confirmation).toMatchObject(confirmation);
				const twice = yield* send(
					app,
					"POST",
					`${path}/confirmation`,
					confirmation,
				);
				expect(failure(twice)).toEqual([400, "invalid_request"]);

				// Preparation stays editable after booking; the visit itself does not change.
				const prep = { ...suggestion.prep, transportation: null };
				const edited = yield* send(app, "PUT", `${path}/prep`, prep);
				expect(Schema.decodeUnknownSync(Appointment)(edited.json).prep).toEqual(
					prep,
				);

				const cancelled = yield* send(app, "POST", `${path}/cancel`);
				expect(
					Schema.decodeUnknownSync(Appointment)(cancelled.json).status,
				).toBe("cancelled");
				const late = yield* send(app, "PUT", `${path}/prep`, prep);
				expect(failure(late)).toEqual([400, "invalid_request"]);

				const outsider = yield* openFamilyDb(config);
				const theirs = familyApp(outsider, familyId, routes());
				expect(failure(yield* send(theirs, "GET", path))).toEqual([
					404,
					"not_found",
				]);
				expect((yield* send(theirs, "GET", "/appointments")).json).toEqual({
					appointments: [],
				});
			}),
		));

	test("a clinician update sends only a reviewed summary, inside its consent", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Share family");
				const app = familyApp(db, familyId, routes());
				const created = yield* send(app, "POST", "/appointments", {
					...suggestion,
					source: "member",
				});
				const { id } = Schema.decodeUnknownSync(Appointment)(created.json);
				const path = `/appointments/${id}`;
				const share = {
					recipient: {
						name: "Dr. Synthetic",
						role: "Memory clinic",
						address: "clinic@example.invalid",
					},
					sections: ["labs", "observations", "medication", "questions"],
					consent: { kind: "explicit", frequency: "once" },
				};

				// Without a linked subject or a reviewed report, both sources are unavailable.
				const empty = yield* send(app, "GET", `${path}/summary`);
				const bare = Schema.decodeUnknownSync(PrepSummary)(empty.json);
				expect(bare.labs).toBeNull();
				expect(bare.observations).toBeNull();
				expect(bare.questions).toEqual(suggestion.prep.questions);

				// The caller holds `clinician_delivery` (#26), so this refusal is about the review.
				yield* grant(db, familyId, true);
				const unreviewed = yield* send(app, "POST", `${path}/shares`, share);
				expect(failure(unreviewed)).toEqual([400, "invalid_request"]);
				expect(JSON.stringify(unreviewed.json)).toContain("review the summary");

				// Link a synthetic subject and review two lab reports; the summary then carries the labs
				// and the latest reviewed report, dated.
				yield* Effect.promise(() =>
					db.connection.reducers.linkFinchnodeSubject({
						familyId: BigInt(familyId),
						subject,
						synthetic: true,
					}),
				);
				const reviewedReport = Effect.gen(function* () {
					const made = Schema.decodeUnknownSync(Report)(
						(yield* send(app, "POST", "/reports")).json,
					);
					yield* send(app, "POST", `/reports/${made.id}/review`);
					return made;
				});
				yield* reviewedReport;
				const report = yield* reviewedReport;
				const draft = Schema.decodeUnknownSync(PrepSummary)(
					(yield* send(app, "GET", `${path}/summary`)).json,
				);
				expect(draft.labs?.map((l) => [l.name, l.date])).toEqual([
					[lab.name, lab.date],
				]);
				expect(draft.observations?.reportId).toBe(report.id);

				// A summary the member did not see is refused.
				const stale = yield* send(app, "POST", `${path}/summary`, bare);
				expect(failure(stale)).toEqual([409, "conflict"]);
				const reviewed = yield* send(app, "POST", `${path}/summary`, draft);
				expect(
					Schema.decodeUnknownSync(Appointment)(reviewed.json).summary?.content,
				).toEqual(draft);

				// Without `clinician_delivery`, a reviewed summary still cannot be shared.
				yield* grant(db, familyId, false);
				const noAccess = yield* send(app, "POST", `${path}/shares`, share);
				expect(failure(noAccess)).toEqual([403, "forbidden"]);
				expect(JSON.stringify(noAccess.json)).toContain("clinician_delivery");
				yield* grant(db, familyId, true);

				const mismatched = yield* send(app, "POST", `${path}/shares`, {
					...share,
					consent: { kind: "explicit", frequency: "weekly" },
				});
				expect(failure(mismatched)).toEqual([400, "invalid_request"]);

				const once = Schema.decodeUnknownSync(ClinicianShare)(
					(yield* send(app, "POST", `${path}/shares`, share)).json,
				);
				expect(once.delivery).toBe("simulated");
				const sharePath = `${path}/shares/${once.id}`;
				const sent = Schema.decodeUnknownSync(ClinicianShare)(
					(yield* send(app, "POST", `${sharePath}/send`)).json,
				);
				expect([sent.sends, sent.nextSendAt]).toEqual([1, null]);
				const again = yield* send(app, "POST", `${sharePath}/send`);
				expect(failure(again)).toEqual([400, "invalid_request"]);

				// Explicit consent covers the summary as reviewed; a new review needs a new approval.
				const second = Schema.decodeUnknownSync(ClinicianShare)(
					(yield* send(app, "POST", `${path}/shares`, share)).json,
				);
				yield* send(app, "POST", `${path}/summary`, draft);
				const changed = yield* send(
					app,
					"POST",
					`${path}/shares/${second.id}/send`,
				);
				expect(failure(changed)).toEqual([400, "invalid_request"]);

				// A standing arrangement sends again only after the agreed interval.
				const weekly = Schema.decodeUnknownSync(ClinicianShare)(
					(yield* send(app, "POST", `${path}/shares`, {
						...share,
						consent: { kind: "standing", frequency: "weekly" },
					})).json,
				);
				const weeklyPath = `${path}/shares/${weekly.id}`;
				const first = Schema.decodeUnknownSync(ClinicianShare)(
					(yield* send(app, "POST", `${weeklyPath}/send`)).json,
				);
				expect(
					Date.parse(first.nextSendAt ?? "") -
						Date.parse(first.lastSentAt ?? ""),
				).toBe(7 * 86_400_000);
				const soon = yield* send(app, "POST", `${weeklyPath}/send`);
				expect(failure(soon)).toEqual([400, "invalid_request"]);

				yield* send(app, "POST", `${weeklyPath}/revoke`);
				const revoked = yield* send(app, "POST", `${weeklyPath}/send`);
				expect(failure(revoked)).toEqual([400, "invalid_request"]);

				const listed = Schema.decodeUnknownSync(ClinicianShares)(
					(yield* send(app, "GET", `${path}/shares`)).json,
				);
				expect(listed.shares.map((s) => s.sends).sort()).toEqual([0, 1, 1]);
			}),
		));
});
