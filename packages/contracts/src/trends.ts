// Trend explanations (docs/board.html#db-hrv, #ph-chat), under `/api/families/:familyId`. The server
// builds them from dated records without a model: every observation keeps its source, period, unit,
// quality, and sync age, and each kind of evidence stays separate. An explanation never diagnoses,
// never starts an alert or a nudge, and offers only a check-in or a review.
import { Schema } from "effect";

/** `POST /trends` body: a wearer's or family member's question about how something changed. */
export const TrendQuestion = Schema.Struct({
	question: Schema.String.check(
		Schema.isPattern(/\S/),
		Schema.isMaxLength(2000),
	),
	/** How many days of wearable history to read, 1 to 90. Default 7. Labs keep their own dates. */
	days: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 90 })),
	),
});
export type TrendQuestion = typeof TrendQuestion.Type;

/**
 * `reported`: what a person said. `measured`: device or laboratory values. `derived`: scores a
 * device computes from measurements (recovery, strain). `nutrition_estimate`: estimated intake.
 */
export const EvidenceKind = Schema.Literals([
	"reported",
	"measured",
	"derived",
	"nutrition_estimate",
]);
export type EvidenceKind = typeof EvidenceKind.Type;

/** One series from one source: a metric's samples, one lab test's results, or one report. */
export const TrendObservation = Schema.Struct({
	kind: EvidenceKind,
	/** Metric name, lab test name, or `question` for the asker's own report. */
	label: Schema.String,
	source: Schema.String,
	/** Synthetic demo data, never a real measurement. */
	synthetic: Schema.Boolean,
	/** Sample quality; `source_reported` for labs as the source sent them; `self_reported` for reports. */
	quality: Schema.Literals([
		"validated",
		"unvalidated",
		"source_reported",
		"self_reported",
	]),
	unit: Schema.NullOr(Schema.String),
	/** Source time of the first and the last value: the measurement period. A lab keeps its own date. */
	from: Schema.String,
	to: Schema.String,
	first: Schema.Union([Schema.String, Schema.Finite]),
	last: Schema.Union([Schema.String, Schema.Finite]),
	count: Schema.Int,
	/** `single`: one value. `text`: values that are not numbers. `flat`: within 5% of the first value. */
	direction: Schema.Literals(["up", "down", "flat", "single", "text"]),
	/** When the server last received this source's data, and how many minutes before the answer. */
	lastSyncAt: Schema.NullOr(Schema.String),
	lastSyncMinutes: Schema.NullOr(Schema.Int),
	/** The last value is over 24 hours old, or a lab is older than the requested period. */
	stale: Schema.Boolean,
});
export type TrendObservation = typeof TrendObservation.Type;

/** `POST /trends` reply. A missing source is listed in `unknown`, never read as normal. */
export const TrendExplanation = Schema.Struct({
	question: Schema.String,
	/** The requested period. */
	from: Schema.String,
	to: Schema.String,
	observations: Schema.Array(TrendObservation),
	/** What the explanation could not use, in plain words. */
	unknown: Schema.Array(Schema.String),
	/** Sources that disagree about the same thing in this period. */
	conflicts: Schema.Array(Schema.String),
	/**
	 * Routines come only from a saved, verified care plan. None exists yet (issue #26), so the
	 * explanation offers no routine.
	 */
	carePlan: Schema.Struct({
		status: Schema.Literal("unavailable"),
		message: Schema.String,
	}),
	/** Only a check-in or a review. Never diet, medicine, fluid, or exercise advice. */
	nextSteps: Schema.Array(
		Schema.Struct({
			kind: Schema.Literals(["check_in", "review"]),
			text: Schema.String,
		}),
	),
	cautions: Schema.Array(Schema.String),
	generatedAt: Schema.String,
});
export type TrendExplanation = typeof TrendExplanation.Type;
