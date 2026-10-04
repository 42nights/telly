import { Schema } from "effect";
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

/** `POST /api/families/:familyId/reports/:reportId/fields`. `null` means not filled in. */
export const ReportFields = Schema.Struct({
	patientName: FieldText,
	dateOfBirth: FieldText,
	patientId: FieldText,
	physician: FieldText,
	hospital: FieldText,
	notes: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4000))),
});
export type ReportFields = typeof ReportFields.Type;

/** A family member confirmed the report. Review is not clinician review. */
export const ReportReview = Schema.Struct({
	reviewedBy: Schema.String,
	reviewedAt: Schema.String,
});
export type ReportReview = typeof ReportReview.Type;

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
});
export type Report = typeof Report.Type;

/** `GET /api/families/:familyId/reports`, newest first. */
export const Reports = Schema.Struct({ reports: Schema.Array(Report) });
export type Reports = typeof Reports.Type;

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
