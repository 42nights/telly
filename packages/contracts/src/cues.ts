import { Schema } from "effect";
import cueFormat from "./cue-format.json" with { type: "json" };
import { DbId } from "./families";

/**
 * The prompt and output format that `training/qwen/train.py` trains and the server sends. Both
 * sides read this one file, so a format change is a new `version` and a new trained checkpoint.
 */
export { cueFormat };

export const CueKind = Schema.Literals(["walk", "hydrate", "rest", "none"]);
export type CueKind = typeof CueKind.Type;

/** What the model must reply with, exactly. Anything else is an upstream error, never a cue. */
export const CueOutput = Schema.Struct({
	kind: CueKind,
	text: Schema.NonEmptyString.check(
		Schema.isMaxLength(cueFormat.maxTextLength),
	),
});
export type CueOutput = typeof CueOutput.Type;

/** `POST /api/families/:familyId/cues`: validated samples of that family to turn into one cue. */
export const CueRequest = Schema.Struct({
	sampleIds: Schema.NonEmptyArray(DbId).check(
		Schema.isMaxLength(cueFormat.maxReadings),
		Schema.isUnique(),
	),
});
export type CueRequest = typeof CueRequest.Type;

/**
 * One model cue with its provenance. A cue is advice only: it never feeds threshold evaluation or
 * alert delivery, and `input.synthetic` is true when any input sample is synthetic demo data.
 */
export const HealthCue = Schema.Struct({
	...CueOutput.fields,
	format: Schema.Literal("health-cue-v1"),
	model: Schema.Struct({
		provider: Schema.Literal("river"),
		/** River base model of the checkpoint, such as `Qwen/Qwen3.5-9B`. */
		baseModel: Schema.NonEmptyString,
		/** `river://` checkpoint that answered; the trained model version. */
		checkpoint: Schema.NonEmptyString,
	}),
	input: Schema.Struct({
		sampleIds: Schema.NonEmptyArray(Schema.String),
		sources: Schema.NonEmptyArray(Schema.NonEmptyString),
		synthetic: Schema.Boolean,
	}),
	generatedAt: Schema.String,
});
export type HealthCue = typeof HealthCue.Type;
