// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). All records
// are synthetic. Each connection is a separate identity issued by that database.
import { describe, expect, test } from "bun:test";
import { ReminderHistory } from "@health/contracts/reminders";
import {
	Report,
	ReportPdf,
	ReportPdfLink,
	ReportPdfs,
	Reports,
} from "@health/contracts/reports";
import { Effect, Schema } from "effect";
import type { Hono } from "hono";
import { Identity, Timestamp } from "spacetimedb";
import type { FamilyDb } from "../db";
import { openFamilyDb, readFamilyRecords } from "../db";
import type { FamilyEnv } from "../http";
import type { R2Bucket } from "../integrations/r2";
import type { Mail, Mailer } from "../integrations/resend";
import { reportPdfLinkRoutes } from "../report-pdf-links";
import { familyRoutes } from "./families";
import { reminderRoutes } from "./reminders";
import { reportRoutes } from "./reports";
import {
	dbConfig,
	failure,
	familyApp,
	joinFamily,
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

// The storage stand-in keeps objects by key; the routes alone decide the keys.
const memoryBucket = () => {
	const objects = new Map<string, { body: Uint8Array; at: string }>();
	const bucket: R2Bucket = {
		put: async (key, body) =>
			void objects.set(key, { body, at: new Date().toISOString() }),
		exists: async (key) => objects.has(key),
		get: async (key) => objects.get(key)?.body,
		presign: async (key) => `https://storage.test/${key}?signed`,
		list: async (prefix) =>
			[...objects]
				.filter(([key]) => key.startsWith(prefix))
				.map(([key, { body, at }]) => ({
					key,
					size: body.length,
					lastModified: at,
				})),
		remove: async (key) => void objects.delete(key),
	};
	return { objects, bucket };
};

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

	test("a report lists only the reminders that ended unresolved", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Unresolved");
				const reminders = familyApp(db, familyId, reminderRoutes());
				yield* send(reminders, "PUT", "/reminder-settings", {
					timeZone: "UTC",
					quietHours: null,
					repeatEveryMinutes: 1,
					maxPrompts: 1,
					snoozeMinutes: 1,
				});
				// Hours away, so no database timer settles either occurrence during the test.
				const hoursAhead = (hours: number) =>
					new Date(Date.now() + hours * 3_600_000).toISOString().slice(11, 16);
				yield* send(reminders, "POST", "/reminders", {
					kind: "meal",
					subjectId: null,
					title: "Synthetic lunch",
					times: [hoursAhead(3), hoursAhead(4)],
				});
				const [unsure, open] = Schema.decodeUnknownSync(ReminderHistory)(
					(yield* send(reminders, "GET", "/reminder-occurrences")).json,
				).occurrences.map((d) => d.occurrence.id);
				if (unsure === undefined || open === undefined)
					throw new Error("expected one occurrence per reminder time");
				yield* send(
					reminders,
					"POST",
					`/reminder-occurrences/${unsure}/answers`,
					{
						clientId: "unsure-1",
						source: "phone",
						response: "unsure",
						wording: "I don't remember if I ate",
					},
				);

				const app = familyApp(db, familyId, reportRoutes());
				const report = Schema.decodeUnknownSync(Report)(
					(yield* send(app, "POST", "/reports")).json,
				);
				expect(report.unresolved?.map((d) => d.occurrence.id)).toEqual([
					unsure,
				]);
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
				expect(failure(read)).toEqual([403, "forbidden"]);

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
				const { objects, bucket } = memoryBucket();
				const { db: owner, familyId } = yield* openFamily(config, "Pdf");
				const relative = yield* joinFamily(config, owner, familyId, [
					"health_records",
				]);
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
				const text = new TextDecoder("latin1").decode(objects.get(key)?.body);
				expect(text.startsWith("%PDF-1.4")).toBe(true);
				expect(text).toContain(`(Layout version 2 - report ${report.id})`);

				// A later PDF of the same report lists first.
				yield* Effect.sleep("5 millis");
				const later = Schema.decodeUnknownSync(ReportPdf)(
					(yield* send(ownerApp, "POST", `/reports/${report.id}/pdfs`)).json,
				);
				const both = yield* send(ownerApp, "GET", "/report-pdfs");
				expect(
					Schema.decodeUnknownSync(ReportPdfs)(both.json).pdfs.map((p) => p.id),
				).toEqual([later.id, pdf.id]);

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

	test("deleting a family deletes its records and every member's PDFs, and nothing else", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { objects, bucket } = memoryBucket();
				const { db: owner, familyId } = yield* openFamily(config, "Doomed");
				const relative = yield* openFamilyDb(config);
				yield* Effect.promise(() =>
					owner.connection.reducers.addFamilyMember({
						familyId: BigInt(familyId),
						member: Identity.fromString(relative.identity),
					}),
				);
				yield* recordSamples(owner, familyId);
				const kept = yield* openFamily(config, "Kept");
				for (const [db, id] of [
					[owner, familyId],
					[kept.db, kept.familyId],
				] as const) {
					const app = familyApp(db, id, reportRoutes(bucket));
					const created = yield* send(app, "POST", "/reports");
					const report = Schema.decodeUnknownSync(Report)(created.json);
					yield* send(app, "POST", `/reports/${report.id}/pdfs`);
				}
				const keys = () => [...objects.keys()].map((key) => key.split("/")[1]);
				expect(keys().sort()).toEqual([familyId, kept.familyId].sort());

				// A member without family_access, or the wrong name, deletes nothing.
				const relativeApp = familyApp(relative, familyId, familyRoutes(bucket));
				const refused = yield* send(relativeApp, "DELETE", "/", {
					name: "Doomed",
				});
				expect(failure(refused)).toEqual([403, "forbidden"]);
				const ownerApp = familyApp(owner, familyId, familyRoutes(bucket));
				const wrong = yield* send(ownerApp, "DELETE", "/", { name: "doomed" });
				expect(failure(wrong)).toEqual([400, "invalid_request"]);
				expect(keys()).toHaveLength(2);

				const deleted = yield* send(ownerApp, "DELETE", "/", {
					name: "Doomed",
				});
				expect(deleted.status).toBe(204);
				expect(keys()).toEqual([kept.familyId]);
				// The caller's own view is current when the reducer returns; another member's view
				// follows over its own connection.
				const left = readFamilyRecords(owner);
				expect(left.families.map((f) => f.id)).not.toContain(familyId);
				expect(left.samples).toEqual([]);
				const other = familyApp(kept.db, kept.familyId, reportRoutes(bucket));
				const reports = yield* send(other, "GET", "/reports");
				expect(
					Schema.decodeUnknownSync(Reports)(reports.json).reports,
				).toHaveLength(1);
			}),
		));
});

describe.skipIf(dbConfig === undefined)("report email", () => {
	const recipient = "family@example.com";
	/** A mailer that records each email; it fails while `failWith` is set. */
	const spyMailer = () => {
		const sent: Mail[] = [];
		const state = { failWith: null as string | null };
		const mailer: Mailer = async (mail) => {
			if (state.failWith !== null) throw new Error(state.failWith);
			sent.push(mail);
		};
		return { sent, state, mailer };
	};
	const reviewedReport = (app: Hono<FamilyEnv>) =>
		Effect.gen(function* () {
			const created = yield* send(app, "POST", "/reports");
			const { id } = Schema.decodeUnknownSync(Report)(created.json);
			const reviewed = yield* send(app, "POST", `/reports/${id}/review`);
			expect(reviewed.status).toBe(200);
			return Schema.decodeUnknownSync(Report)(reviewed.json);
		});

	test("with automatic email off, a review sends nothing", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Email off");
				const { sent, mailer } = spyMailer();
				const app = familyApp(db, familyId, reportRoutes(undefined, mailer));
				expect((yield* send(app, "GET", "/report-email")).json).toEqual({
					enabled: false,
					recipient: null,
				});
				// An address alone does not turn automatic email on.
				const saved = yield* send(app, "PUT", "/report-email", {
					enabled: false,
					recipient,
				});
				expect(saved.json).toEqual({ enabled: false, recipient });

				const report = yield* reviewedReport(app);
				expect(report.email).toBeNull();
				expect(sent).toEqual([]);
			}),
		));

	test("a review sends the PDF once, and only a family admin changes the setting", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db: owner, familyId } = yield* openFamily(config, "Email on");
				const relative = yield* joinFamily(config, owner, familyId, [
					"health_records",
				]);
				const { sent, mailer } = spyMailer();
				const app = familyApp(owner, familyId, reportRoutes(undefined, mailer));
				const relativeApp = familyApp(
					relative,
					familyId,
					reportRoutes(undefined, mailer),
				);

				const settings = { enabled: true, recipient };
				const notAdmin = yield* send(
					relativeApp,
					"PUT",
					"/report-email",
					settings,
				);
				expect(failure(notAdmin)).toEqual([403, "forbidden"]);
				const noAddress = { enabled: true, recipient: null };
				const missing = yield* send(app, "PUT", "/report-email", noAddress);
				expect(failure(missing)).toEqual([400, "invalid_request"]);
				const bad = { enabled: true, recipient: "not an address" };
				const invalid = yield* send(app, "PUT", "/report-email", bad);
				expect(failure(invalid)).toEqual([400, "invalid_request"]);
				const saved = yield* send(app, "PUT", "/report-email", settings);
				expect(saved.json).toEqual(settings);
				// Every member sees the setting, once their view catches up.
				let seen = yield* send(relativeApp, "GET", "/report-email");
				for (
					let tries = 0;
					tries < 50 && !Bun.deepEquals(seen.json, settings);
					tries++
				) {
					yield* Effect.sleep("100 millis");
					seen = yield* send(relativeApp, "GET", "/report-email");
				}
				expect(seen.json).toEqual(settings);

				// The relative reviews; the email goes to the family address once.
				const report = yield* reviewedReport(relativeApp);
				expect(report.email).toMatchObject({
					status: "sent",
					recipient,
					reason: null,
					automatic: true,
				});
				const again = yield* send(app, "POST", `/reports/${report.id}/review`);
				expect(again.status).toBe(200);
				expect(sent.map((mail) => mail.to)).toEqual([recipient]);
				const pdf = new TextDecoder("latin1").decode(
					sent[0]?.attachment.content,
				);
				expect(pdf).toContain(`report ${report.id}`);

				// A draft cannot be emailed by hand.
				const created = yield* send(app, "POST", "/reports");
				const draft = Schema.decodeUnknownSync(Report)(created.json);
				const early = yield* send(app, "POST", `/reports/${draft.id}/email`);
				expect(failure(early)).toEqual([400, "invalid_request"]);
				expect(sent).toHaveLength(1);
			}),
		));

	test("a failed send shows its reason, and a manual send retries it", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Email fails");
				const { sent, state, mailer } = spyMailer();
				const app = familyApp(db, familyId, reportRoutes(undefined, mailer));
				yield* send(app, "PUT", "/report-email", { enabled: true, recipient });

				state.failWith = "The email service refused the email (HTTP 422)";
				const report = yield* reviewedReport(app);
				expect(report.email).toMatchObject({
					status: "failed",
					reason: "The email service refused the email (HTTP 422)",
					automatic: true,
				});

				state.failWith = null;
				const retried = yield* send(app, "POST", `/reports/${report.id}/email`);
				expect(
					Schema.decodeUnknownSync(Report)(retried.json).email,
				).toMatchObject({ status: "sent", reason: null, automatic: false });
				expect(sent).toHaveLength(1);

				// Without email on the server, a manual send is unavailable, not a false receipt.
				const unset = familyApp(db, familyId, reportRoutes());
				const none = yield* send(unset, "POST", `/reports/${report.id}/email`);
				expect(failure(none)).toEqual([503, "unavailable"]);
			}),
		));

	test("the preview is the PDF every email attaches, and only health records holders see it", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db: owner, familyId } = yield* openFamily(config, "Preview");
				const relative = yield* joinFamily(config, owner, familyId, []);
				const outsider = yield* openFamilyDb(config);
				const { sent, mailer } = spyMailer();
				const app = familyApp(owner, familyId, reportRoutes(undefined, mailer));
				yield* send(app, "PUT", "/report-email", { enabled: true, recipient });
				const report = yield* reviewedReport(app);
				yield* send(app, "POST", `/reports/${report.id}/email`);
				expect(sent).toHaveLength(2);

				const preview = yield* Effect.promise(async () =>
					app.request(`/reports/${report.id}/pdf`),
				);
				expect(preview.status).toBe(200);
				expect(preview.headers.get("content-type")).toBe("application/pdf");
				const bytes = new Uint8Array(
					yield* Effect.promise(() => preview.arrayBuffer()),
				);
				for (const mail of sent) expect(mail.attachment.content).toEqual(bytes);

				// The iOS app's one-use link answers the same bytes, under the report's date.
				const link = yield* send(app, "POST", `/reports/${report.id}/pdf-link`);
				const { url } = Schema.decodeUnknownSync(ReportPdfLink)(link.json);
				const linked = yield* Effect.promise(async () =>
					reportPdfLinkRoutes().request(
						url.replace("/api/report-pdf-links", ""),
					),
				);
				expect(linked.headers.get("content-disposition")).toBe(
					`inline; filename="Telly lab report ${report.createdAt.slice(0, 10)}.pdf"`,
				);
				expect(
					new Uint8Array(yield* Effect.promise(() => linked.arrayBuffer())),
				).toEqual(bytes);

				// A draft previews as it stands; only a member with health records sees any of it.
				const draft = Schema.decodeUnknownSync(Report)(
					(yield* send(app, "POST", "/reports")).json,
				);
				const drafted = yield* Effect.promise(async () =>
					app.request(`/reports/${draft.id}/pdf`),
				);
				expect(drafted.status).toBe(200);
				expect(
					new TextDecoder("latin1").decode(
						yield* Effect.promise(() => drafted.arrayBuffer()),
					),
				).toContain("Draft: not reviewed.");
				for (const caller of [relative, outsider]) {
					const callerApp = familyApp(caller, familyId, reportRoutes());
					for (const path of ["pdf", "pdf-link"]) {
						const refused = yield* send(
							callerApp,
							path === "pdf" ? "GET" : "POST",
							`/reports/${report.id}/${path}`,
						);
						expect(failure(refused)).toEqual([403, "forbidden"]);
					}
				}
			}),
		));
});
