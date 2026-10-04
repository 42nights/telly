import { Schema } from "effect";
import { UtcTime } from "./families";

// Lab report (#17, docs/board.html#wf-lab). Results are evidence and never change; a reviewer's
// corrections and notes sit beside them. Ranges are the source record's own, never generic ones.
// Separate from `./reports` (#64) until the server maps FinchnodeLab to LabReport; follow-up:
// prefer the source's own interpretation when present, and persist reviews through #64's routes.

/** A range exactly as the source record gave it. Bounds are inclusive; at least one is set. */
export const ReferenceRange = Schema.Struct({
	low: Schema.NullOr(Schema.Finite),
	high: Schema.NullOr(Schema.Finite),
	/** The record's own wording, shown as written. */
	text: Schema.NonEmptyString,
}).check(
	Schema.makeFilter(
		({ low, high }) =>
			(low !== null || high !== null) &&
			(low === null || high === null || low <= high),
	),
);
export type ReferenceRange = typeof ReferenceRange.Type;

/** HL7 v3 ObservationInterpretation: below (L), within (N), or above (H) the record's range. */
type LabFlag = "L" | "N" | "H";

/** The only flag rule. */
export const classify = (
	value: number,
	{ low, high }: ReferenceRange,
): LabFlag => {
	if (low !== null && value < low) return "L";
	if (high !== null && value > high) return "H";
	return "N";
};

const LabResult = Schema.Struct({
	/** The source record's id: the evidence this row came from. */
	id: Schema.NonEmptyString,
	loinc: Schema.String.check(Schema.isPattern(/^\d{1,7}-\d$/)),
	/** The record's test name, verbatim. */
	name: Schema.NonEmptyString,
	/** A number gets a flag; a text result (such as "Negative") is shown as written. */
	value: Schema.Union([Schema.Finite, Schema.NonEmptyString]),
	/** UCUM, verbatim. `null`: the record gives no unit (usual for text results). */
	unit: Schema.NullOr(Schema.NonEmptyString),
	/** Specimen collection time. */
	collectedAt: UtcTime,
	/** `null`: the record has no range, so no flag is shown. */
	referenceRange: Schema.NullOr(ReferenceRange),
});

/** Layout version 1. A newer version fails decoding instead of rendering wrongly. */
export const LabReport = Schema.Struct({
	layoutVersion: Schema.Literal(1),
	/** `true` shows the synthetic banner and captions; a real record renders without them. */
	synthetic: Schema.Boolean,
	source: Schema.Struct({
		name: Schema.NonEmptyString,
		url: Schema.NonEmptyString,
		fetchedAt: UtcTime,
		sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
	}),
	patient: Schema.Struct({
		name: Schema.NonEmptyString,
		sex: Schema.NonEmptyString,
		birthDate: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
		recordId: Schema.NonEmptyString,
	}),
	/** At least one: without results there is no report, so an empty record fails decoding. */
	results: Schema.NonEmptyArray(LabResult),
});
export type LabReport = typeof LabReport.Type;

const Text = (maxLength: number) =>
	Schema.String.check(
		Schema.isTrimmed(),
		Schema.isNonEmpty(),
		Schema.isMaxLength(maxLength),
	);

/** Who reviewed or filled the report, as typed. Sign-in (#4) replaces this. */
export const ReviewerName = Text(80);

/** A reviewer's correction of one result's value. The original result is kept unchanged. */
export const LabCorrection = Schema.Struct({
	resultId: Schema.NonEmptyString,
	value: Schema.Finite,
	correctedBy: ReviewerName,
	correctedAt: UtcTime,
});
export type LabCorrection = typeof LabCorrection.Type;

/** A caregiver observation or a question for a clinician, with who wrote it and when. */
export const ReviewNote = Schema.Struct({
	text: Text(500),
	by: ReviewerName,
	at: UtcTime,
});
export type ReviewNote = typeof ReviewNote.Type;
