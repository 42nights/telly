import type {
	FinchnodeLab,
	ReportCorrection,
	ReportFields,
	ReportMarker,
} from "@health/contracts/reports";

/** The text fields of `ReportFields`. */
export type FieldName = Exclude<keyof ReportFields, "corrections">;

/** Field limits from the `ReportFields` contract. */
export const FIELD_LIMITS: Record<FieldName, number> = {
	patientName: 200,
	dateOfBirth: 200,
	patientId: 200,
	physician: 200,
	hospital: 200,
	notes: 4000,
	observations: 4000,
	questions: 4000,
};

export const FIELD_LABELS: Record<FieldName, string> = {
	patientName: "Name",
	dateOfBirth: "Date of birth",
	patientId: "Patient ID",
	physician: "Physician",
	hospital: "Hospital",
	notes: "Notes for the physician",
	observations: "Caregiver observations",
	questions: "Questions for a clinician",
};

const FIELD_NAMES = Object.keys(FIELD_LIMITS) as FieldName[];

/** Form text for each field; a contract `null` (not filled in) is an empty box. */
export type FieldDraft = Record<FieldName, string> & {
	readonly corrections: readonly ReportCorrection[];
};

export const draftOf = (fields: ReportFields): FieldDraft => ({
	patientName: fields.patientName ?? "",
	dateOfBirth: fields.dateOfBirth ?? "",
	patientId: fields.patientId ?? "",
	physician: fields.physician ?? "",
	hospital: fields.hospital ?? "",
	notes: fields.notes ?? "",
	observations: fields.observations ?? "",
	questions: fields.questions ?? "",
	corrections: fields.corrections,
});

const orNull = (text: string) => (text.trim() === "" ? null : text.trim());

/** The request body: an empty box is `null`, never an empty string. */
export const fieldsOf = (draft: FieldDraft): ReportFields => ({
	patientName: orNull(draft.patientName),
	dateOfBirth: orNull(draft.dateOfBirth),
	patientId: orNull(draft.patientId),
	physician: orNull(draft.physician),
	hospital: orNull(draft.hospital),
	notes: orNull(draft.notes),
	observations: orNull(draft.observations),
	questions: orNull(draft.questions),
	corrections: draft.corrections,
});

/** The form would save something other than `saved`. */
export const draftChanged = (draft: FieldDraft, saved: FieldDraft): boolean =>
	FIELD_NAMES.some((name) => draft[name].trim() !== saved[name]) ||
	JSON.stringify(draft.corrections) !== JSON.stringify(saved.corrections);

/** One message per field that is longer than the contract allows. */
export const fieldErrors = (
	draft: FieldDraft,
): Partial<Record<FieldName, string>> => {
	const errors: Partial<Record<FieldName, string>> = {};
	for (const name of FIELD_NAMES) {
		const length = draft[name].trim().length;
		if (length > FIELD_LIMITS[name])
			errors[name] =
				`${FIELD_LABELS[name]} is ${length} characters. The limit is ${FIELD_LIMITS[name]}.`;
	}
	return errors;
};

/** `heart_rate` → `Heart rate`. */
export const metricLabel = (metric: string): string => {
	const words = metric.replace(/_/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A marker without a sample is unavailable, never normal. */
export const markerValue = (marker: ReportMarker): string =>
	marker.sample === null
		? "Unavailable"
		: `${marker.sample.value} ${marker.sample.unit}`;

/** A lab value with its unit, exactly as the source reported it. */
export const labValue = (lab: FinchnodeLab): string => {
	if (lab.value === null) return "No value reported";
	return lab.unit === null ? String(lab.value) : `${lab.value} ${lab.unit}`;
};

/** The source's range text, only with the source that gave it. */
export const labRange = (lab: FinchnodeLab): string | null => {
	const source = lab.sourceName ?? lab.source;
	if (lab.referenceRange === null || source === null) return null;
	return `${lab.referenceRange} (range from ${source})`;
};

/** FinchNode's demo text with the word "synthetic" (any case) said as "demo", in the same case. */
export const demoText = (text: string): string =>
	text === "synthetic_data"
		? "Demo records, not real patient data"
		: text.replace(/synthetic/gi, (word) =>
				word === word.toUpperCase()
					? "DEMO"
					: word[0] === "S"
						? "Demo"
						: "demo",
			);

export const formatTime = (iso: string | number): string => {
	const date = new Date(iso);
	return Number.isNaN(date.getTime())
		? String(iso)
		: date.toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			});
};
