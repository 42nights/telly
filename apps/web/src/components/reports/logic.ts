import type {
	FinchnodeLab,
	ReportFields,
	ReportMarker,
} from "@health/contracts/reports";

export type FieldName = keyof ReportFields;

/** Field limits from the `ReportFields` contract. */
export const FIELD_LIMITS: Record<FieldName, number> = {
	patientName: 200,
	dateOfBirth: 200,
	patientId: 200,
	physician: 200,
	hospital: 200,
	notes: 4000,
};

export const FIELD_LABELS: Record<FieldName, string> = {
	patientName: "Name",
	dateOfBirth: "Date of birth",
	patientId: "Patient ID",
	physician: "Physician",
	hospital: "Hospital",
	notes: "Notes for the physician",
};

/** Form text for each field; a contract `null` (not filled in) is an empty box. */
export type FieldDraft = Record<FieldName, string>;

export const draftOf = (fields: ReportFields): FieldDraft => ({
	patientName: fields.patientName ?? "",
	dateOfBirth: fields.dateOfBirth ?? "",
	patientId: fields.patientId ?? "",
	physician: fields.physician ?? "",
	hospital: fields.hospital ?? "",
	notes: fields.notes ?? "",
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
});

/** One message per field that is longer than the contract allows. */
export const fieldErrors = (
	draft: FieldDraft,
): Partial<Record<FieldName, string>> => {
	const errors: Partial<Record<FieldName, string>> = {};
	for (const name of Object.keys(FIELD_LIMITS) as FieldName[]) {
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

export const formatTime = (iso: string | number): string => {
	const date = new Date(iso);
	return Number.isNaN(date.getTime())
		? String(iso)
		: date.toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			});
};
