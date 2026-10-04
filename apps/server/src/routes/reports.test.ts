// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). All records
// are synthetic. Each connection is a separate identity issued by that database.
import { describe, expect, test } from "bun:test";
import {
	Report,
	ReportPdf,
	ReportPdfLink,
	ReportPdfs,
	Reports,
} from "@health/contracts/reports";
import { Effect, Schema } from "effect";
import { Identity, Timestamp } from "spacetimedb";
import type { FamilyDb } from "../db";
import { openFamilyDb } from "../db";
import type { R2Bucket } from "../integrations/r2";
import { reportRoutes } from "./reports";
import {
	dbConfig,
	failure,
	familyApp,
	openFamily,
	send,
	setOwnScopes,
	withDb,
} from "./test-family";

const fields = {
	patientName: "Synthetic Patient",
	dateOfBirth: "1950-01-01",
	patientId: "SYN-001",
	physician: "Dr. Synthetic",
	hospital: "Synthetic General",
	notes: null,
	observations: "Seemed tired after lunch.",
	questions: null,
	corrections: [{ metric: "hrv", value: 45, reason: "Typed at the source" }],
};

const recordSamples = (db: FamilyDb, familyId: string) =>
	Effect.forEach(
		[
			["hrv", 41, "ms", "2026-01-01T08:00:00Z", "Validated"],
			["hrv", 44, "ms", "2026-01-02T08:00:00Z", "Validated"],
			["spo2", 97, "%", "2026-01-02T08:00:00Z", "Unvalidated"],
		] as const,
		([metric, value, unit, time, quality]) =>
			Effect.promise(() =>
				db.connection.reducers.recordSample({
					familyId: BigInt(familyId),
					metric,
					value,
					unit,
					sourceTime: Timestamp.fromDate(new Date(time)),
					source: "synthetic-demo",
					synthetic: true,
					quality: { tag: quality },
				}),
			),
	);

describe.skipIf(dbConfig === undefined)("lab reports", () => {
	test("a report is generated from family samples, filled, reviewed, then frozen", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Report family");
				yield* recordSamples(db, familyId);
				const app = familyApp(db, familyId, reportRoutes());

				const created = yield* send(app, "POST", "/reports");
				expect(created.status).toBe(201);
				const draft = Schema.decodeUnknownSync(Report)(created.json);
				const marker = (metric: string) =>
					draft.markers.find((m) => m.metric === metric)?.sample;
				// Latest sample per metric, quality kept; a metric without samples stays unavailable.
				expect(marker("hrv")?.value).toBe(44);
				expect(marker("spo2")?.quality).toBe("unvalidated");
				expect(marker("falls")).toBeNull();
				expect(draft.review).toBeNull();

				const path = `/reports/${draft.id}`;
				const extra = { ...fields, diagnosis: "x" };
				const bad = yield* send(app, "POST", `${path}/fields`, extra);
				expect(failure(bad)).toEqual([400, "invalid_request"]);
				// An unavailable marker never gets a value, not even as a correction.
				const invented = {
					...fields,
					corrections: [{ metric: "falls", value: 0, reason: "None seen" }],
				};
				const unmeasured = yield* send(app, "POST", `${path}/fields`, invented);
				expect(failure(unmeasured)).toEqual([400, "invalid_request"]);
				const filled = yield* send(app, "POST", `${path}/fields`, fields);
				const saved = Schema.decodeUnknownSync(Report)(filled.json);
				expect(saved.fields).toEqual(fields);
				// The correction sits beside the generated sample, which stays as it was.
				expect(saved.markers).toEqual(draft.markers);

				const early = yield* send(app, "POST", `${path}/submit`);
				expect(failure(early)).toEqual([409, "conflict"]);

				const review = yield* send(app, "POST", `${path}/review`);
				const reviewed = Schema.decodeUnknownSync(Report)(review.json);
				expect(reviewed.review?.reviewedBy).toBe(db.identity);
				const again = yield* send(app, "POST", `${path}/review`);
				expect(Schema.decodeUnknownSync(Report)(again.json).review).toEqual(
					reviewed.review,
				);

				const late = { ...fields, notes: "late" };
				const edit = yield* send(app, "POST", `${path}/fields`, late);
				expect(failure(edit)).toEqual([409, "conflict"]);
				const direct = yield* Effect.promise(() =>
					db.connection.reducers
						.updateReport({ id: draft.id, fields: "{}", review: true })
						.then(String, String),
				);
				expect(direct).toBe("SenderError: report is already reviewed");

				// Hospital delivery has no provider API, so submission is an explicit unavailable error.
				const submitted = yield* send(app, "POST", `${path}/submit`);
				expect(failure(submitted)).toEqual([503, "unavailable"]);

				const listed = yield* send(app, "GET", "/reports");
				expect(Schema.decodeUnknownSync(Reports)(listed.json).reports).toEqual([
					reviewed,
				]);
			}),
		));

	test("a report keeps the meals of its time, and only with health records", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Meal report");
				const app = familyApp(db, familyId, reportRoutes());
				const generate = Effect.map(send(app, "POST", "/reports"), (r) =>
					Schema.decodeUnknownSync(Report)(r.json),
				);
				const intake = (mealId: string, words: string) =>
					Effect.promise(() =>
						db.connection.reducers.recordMealFact({
							familyId: BigInt(familyId),
							mealId,
							fact: JSON.stringify({
								type: "intake_report",
								kind: "meal",
								amount: "some",
								reportedBy: "wearer",
								words,
								via: "voice",
							}),
						}),
					);

				// Meal facts are health records: without the scope they are left out, not shown as none.
				yield* setOwnScopes(db, familyId, ["health_records"], false);
				expect((yield* generate).meals).toBeNull();
				yield* setOwnScopes(db, familyId, ["health_records"], true);
				yield* intake("lunch-1", "I ate about half");
				const report = yield* generate;
				expect(
					report.meals?.flatMap((m) => m.facts.map(({ fact }) => fact)),
				).toMatchObject([{ type: "intake_report", words: "I ate about half" }]);
				expect(report.unresolved).toEqual([]);

				// A later meal never enters a report that was already made.
				yield* intake("dinner-1", "All of it");
				const again = yield* send(app, "GET", `/reports/${report.id}`);
				expect(Schema.decodeUnknownSync(Report)(again.json)).toEqual(report);
			}),
		));

	test("another family's identity cannot read or change a report", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db: owner, familyId } = yield* openFamily(config, "Private");
				const outsider = yield* openFamilyDb(config);
				const ownerApp = familyApp(owner, familyId, reportRoutes());
				const created = yield* send(ownerApp, "POST", "/reports");
				const { id } = Schema.decodeUnknownSync(Report)(created.json);

				const outsiderApp = familyApp(outsider, familyId, reportRoutes());
				const read = yield* send(outsiderApp, "GET", `/reports/${id}`);
				expect(failure(read)).toEqual([404, "not_found"]);

				const theirs = outsider.connection.reducers;
				const writes = [
					theirs.createReport({
						id: crypto.randomUUID(),
						familyId: BigInt(familyId),
						markers: "[]",
						fields: "{}",
					}),
					theirs.updateReport({ id, fields: "{}", review: false }),
					theirs.updateReport({ id, fields: undefined, review: true }),
				];
				const results = yield* Effect.promise(() => Promise.allSettled(writes));
				expect(
					results.map((r) =>
						r.status === "rejected" ? String(r.reason) : r.status,
					),
				).toEqual(writes.map(() => "SenderError: not a member of this family"));

				const after = yield* send(ownerApp, "GET", `/reports/${id}`);
				expect(after.json).toEqual(created.json);
			}),
		));

	test("a saved PDF belongs to the member who made it", () =>
		withDb((config) =>
			Effect.gen(function* () {
				// The storage stand-in keeps objects by key; the routes alone decide the keys.
				const objects = new Map<string, Uint8Array>();
				const bucket: R2Bucket = {
					put: async (key, body) => void objects.set(key, body),
					exists: async (key) => objects.has(key),
					presign: async (key) => `https://storage.test/${key}?signed`,
					list: async (prefix) =>
						[...objects]
							.filter(([key]) => key.startsWith(prefix))
							.map(([key, body]) => ({
								key,
								size: body.length,
								lastModified: new Date().toISOString(),
							})),
				};
				const { db: owner, familyId } = yield* openFamily(config, "Pdf");
				const relative = yield* openFamilyDb(config);
				yield* Effect.promise(() =>
					owner.connection.reducers.addFamilyMember({
						familyId: BigInt(familyId),
						member: Identity.fromString(relative.identity),
					}),
				);
				const ownerApp = familyApp(owner, familyId, reportRoutes(bucket));
				const created = yield* send(ownerApp, "POST", "/reports");
				const report = Schema.decodeUnknownSync(Report)(created.json);

				const made = yield* send(
					ownerApp,
					"POST",
					`/reports/${report.id}/pdfs`,
				);
				expect(made.status).toBe(201);
				const pdf = Schema.decodeUnknownSync(ReportPdf)(made.json);
				const listed = yield* send(ownerApp, "GET", "/report-pdfs");
				expect(Schema.decodeUnknownSync(ReportPdfs)(listed.json).pdfs).toEqual([
					{ ...pdf, createdAt: expect.any(String) },
				]);
				const link = yield* send(ownerApp, "GET", `/report-pdfs/${pdf.id}`);
				const { url } = Schema.decodeUnknownSync(ReportPdfLink)(link.json);
				const key = new URL(url).pathname.slice(1);
				expect(key).toBe(
					`report-pdfs/${familyId}/${owner.identity}/${pdf.id}.pdf`,
				);
				const text = new TextDecoder("latin1").decode(objects.get(key));
				expect(text.startsWith("%PDF-1.4")).toBe(true);
				expect(text).toContain(`(Layout version 2 - report ${report.id})`);

				// Another member of the same family sees none of it, even with the exact id.
				const relativeApp = familyApp(relative, familyId, reportRoutes(bucket));
				const theirs = yield* send(relativeApp, "GET", "/report-pdfs");
				expect(theirs.json).toEqual({ pdfs: [] });
				const taken = yield* send(relativeApp, "GET", `/report-pdfs/${pdf.id}`);
				expect(failure(taken)).toEqual([404, "not_found"]);
				const climb = yield* send(relativeApp, "GET", "/report-pdfs/..%2F..");
				expect(failure(climb)).toEqual([404, "not_found"]);

				const unset = familyApp(owner, familyId, reportRoutes());
				const none = yield* send(unset, "GET", "/report-pdfs");
				expect(failure(none)).toEqual([503, "unavailable"]);
			}),
		));
});
