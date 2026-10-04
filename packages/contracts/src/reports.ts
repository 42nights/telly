import { Effect, Schema } from "effect";
import { HealthSample } from "./index";

// Lab reports (docs/board.html#wf-lab). A report holds generated markers, which are evidence and
// never change, and fillable fields that a family member completes before the review. There are no
// reference ranges or flags: no validated laboratory range exists for these signals, and the board's
// wireframe ranges are not clinical thresholds.

/** The latest sample of one metric, or `null` when the family has none: unavailable, never normal. */
export const ReportMarker = Schema.Struct({
	metric: Schema.NonEmptyString,
	sample: Schema.NullOr(HealthSample),
});
export type ReportMarker = typeof ReportMarker.Type;

const FieldText = Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)));
const LongText = Schema.NullOr(Schema.String.check(Schema.isMaxLength(4000)));
/** Keys added after the first reports were stored decode as not filled in. */
const added = <S extends Schema.Top>(schema: S, empty: S["Encoded"]) =>
	schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(empty)));

/**
 * A family member's correction of one marker's value, in the marker's own unit. The generated
 * sample stays in the report unchanged beside it. Only a marker with a sample can be corrected:
 * an unavailable marker never gets a value.
 */
export const ReportCorrection = Schema.Struct({
	metric: Schema.NonEmptyString,
	value: Schema.Finite,
	/** Why the source value is wrong, such as a typing error. */
	reason: Schema.String.check(
		Schema.isTrimmed(),
		Schema.isNonEmpty(),
		Schema.isMaxLength(200),
	),
});
export type ReportCorrection = typeof ReportCorrection.Type;

/** `POST /api/families/:familyId/reports/:reportId/fields`. `null` means not filled in. */
export const ReportFields = Schema.Struct({
	patientName: FieldText,
	dateOfBirth: FieldText,
	patientId: FieldText,
	physician: FieldText,
	hospital: FieldText,
	notes: LongText,
	/** What a caregiver saw. Separate from measured values. */
	observations: added(LongText, null),
	/** Questions the family wants a clinician to answer. */
	questions: added(LongText, null),
	/** At most one correction per marker. */
	corrections: added(
		Schema.Array(ReportCorrection).check(
			Schema.makeFilter(
				(list) => new Set(list.map((c) => c.metric)).size === list.length,
				{ expected: "at most one correction per marker" },
			),
		),
		[],
	),
});
export type ReportFields = typeof ReportFields.Type;

/** A family member confirmed the report. Review is not clinician review. */
export const ReportReview = Schema.Struct({
	reviewedBy: Schema.String,
	reviewedAt: Schema.String,
});
export type ReportReview = typeof ReportReview.Type;

/** The latest email of a report (#8). `failed` carries the reason; `queued` means not answered yet. */
export const ReportEmail = Schema.Struct({
	status: Schema.Literals(["queued", "sent", "failed"]),
	recipient: Schema.String,
	reason: Schema.NullOr(Schema.String),
	/** Sent because the report was reviewed while automatic email was on. */
	automatic: Schema.Boolean,
	updatedAt: Schema.String,
});
export type ReportEmail = typeof ReportEmail.Type;

export const Report = Schema.Struct({
	id: Schema.String,
	familyId: Schema.String,
	createdBy: Schema.String,
	/** When the markers were generated. Generation never makes an old sample current. */
	createdAt: Schema.String,
	markers: Schema.Array(ReportMarker),
	fields: ReportFields,
	/** `null` while the report is a draft. A reviewed report no longer changes. */
	review: Schema.NullOr(ReportReview),
	/** `null` until the report is emailed. */
	email: Schema.NullOr(ReportEmail),
});
export type Report = typeof Report.Type;

export const EmailAddress = Schema.String.check(
	Schema.isMaxLength(254),
	Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
);

/**
 * `GET` and `PUT /api/families/:familyId/report-email`: email each report to `recipient` when a
 * member marks it as reviewed. Only a family admin (`family_access`) can change it.
 */
export const ReportEmailSettings = Schema.Struct({
	enabled: Schema.Boolean,
	recipient: Schema.NullOr(EmailAddress),
}).check(
	Schema.makeFilter(
		(s) =>
			!s.enabled ||
			s.recipient !== null ||
			"Automatic email needs a recipient address",
	),
);
export type ReportEmailSettings = typeof ReportEmailSettings.Type;

/** `GET /api/families/:familyId/reports`, newest first. */
export const Reports = Schema.Struct({ reports: Schema.Array(Report) });
export type Reports = typeof Reports.Type;

/**
 * `POST /api/families/:familyId/reports/:reportId/pdfs`: a PDF the caller made of one report, kept
 * in private storage. Only the person who made it can list or download it, and only while they
 * are a member of the report's family.
 */
export const ReportPdf = Schema.Struct({
	id: Schema.String,
	reportId: Schema.String,
	createdAt: Schema.String,
	bytes: Schema.Number,
});
export type ReportPdf = typeof ReportPdf.Type;

/** `GET /api/families/:familyId/report-pdfs`: the caller's PDFs in this family, newest first. */
export const ReportPdfs = Schema.Struct({ pdfs: Schema.Array(ReportPdf) });
export type ReportPdfs = typeof ReportPdfs.Type;

/** `GET …/report-pdfs/:id`: a presigned download link for one of the caller's PDFs. */
export const ReportPdfLink = Schema.Struct({
	url: Schema.String,
	expiresAt: Schema.String,
});
export type ReportPdfLink = typeof ReportPdfLink.Type;

// FinchNode (https://finchnode.com/docs): read-only, patient-authorized health records. A patient
// connects a health system and approves sharing in FinchNode Connect; FinchNode checks that consent
// on every read. Values, units, ranges, and interpretations are the source's, unchanged.

/**
 * `POST /api/families/:familyId/finchnode/sessions` and `…/sessions/:sessionId/link`. `linked` is
 * true once the family may read the session's subject. The keyless demo links at once.
 */
export const FinchnodeSession = Schema.Struct({
	sessionId: Schema.String,
	/** Where the patient signs in and approves sharing. `null` on the link response. */
	url: Schema.NullOr(Schema.String),
	linked: Schema.Boolean,
	/** Fictional patients: the keyless demo or a sandbox key. */
	synthetic: Schema.Boolean,
});
export type FinchnodeSession = typeof FinchnodeSession.Type;

/** One laboratory result exactly as the source reported it. */
export const FinchnodeLab = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	value: Schema.NullOr(Schema.Union([Schema.String, Schema.Finite])),
	unit: Schema.NullOr(Schema.String),
	status: Schema.NullOr(Schema.String),
	/** When the specimen or observation was taken, as the source dated it. */
	date: Schema.NullOr(Schema.String),
	/** The source's own range text. Show it only with its source. */
	referenceRange: Schema.NullOr(Schema.String),
	interpretation: Schema.NullOr(Schema.String),
	source: Schema.NullOr(Schema.String),
	sourceName: Schema.NullOr(Schema.String),
	sourceRecordId: Schema.NullOr(Schema.String),
	codes: Schema.Array(
		Schema.Struct({
			system: Schema.NullOr(Schema.String),
			code: Schema.NullOr(Schema.String),
			display: Schema.NullOr(Schema.String),
		}),
	),
	sourceUpdatedAt: Schema.NullOr(Schema.String),
	syncedAt: Schema.NullOr(Schema.String),
});
export type FinchnodeLab = typeof FinchnodeLab.Type;

/**
 * One linked subject's laboratory results. `inactive`: the patient revoked sharing. `not_granted`:
 * the consent does not cover labs. Neither carries results.
 */
export const FinchnodeSubjectLabs = Schema.Struct({
	subject: Schema.String,
	synthetic: Schema.Boolean,
	access: Schema.Literals(["granted", "inactive", "not_granted"]),
	/** FinchNode's sync state, such as `complete` or `partial`; `null` without access. */
	syncStatus: Schema.NullOr(Schema.String),
	dataAsOf: Schema.NullOr(Schema.String),
	/** FinchNode warning codes, such as `source_unavailable`. */
	warnings: Schema.Array(Schema.String),
	sources: Schema.Array(
		Schema.Struct({
			system: Schema.String,
			organization: Schema.NullOr(Schema.String),
			lastSyncedAt: Schema.NullOr(Schema.String),
		}),
	),
	labs: Schema.Array(FinchnodeLab),
});
export type FinchnodeSubjectLabs = typeof FinchnodeSubjectLabs.Type;

/** `GET /api/families/:familyId/finchnode/labs`: every subject linked to the family. */
export const FinchnodeLabs = Schema.Struct({
	subjects: Schema.Array(FinchnodeSubjectLabs),
});
export type FinchnodeLabs = typeof FinchnodeLabs.Type;
