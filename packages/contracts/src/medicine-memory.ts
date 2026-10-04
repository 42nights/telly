// Where a medicine container was last seen (issue #29; docs/board.html#hud-marker). A sighting is a
// past observation, never the container's current place: a current place comes only from a new
// camera check (`./vision`). Remembering or finding a container never records a dose.
import { Schema } from "effect";
import { MedicineDetection, UtcTime } from "./vision";

const Text = Schema.String.check(
	Schema.isPattern(/\S/),
	Schema.isMaxLength(120),
);

/**
 * `PUT /medicine-memory`: turn remembering on, with the agreed familiar places to search when a
 * container moved, or off. Turning it off deletes every stored sighting of the family.
 */
export const SetMedicineMemory = Schema.Struct({
	enabled: Schema.Boolean,
	places: Schema.Array(Text).check(Schema.isMaxLength(12)),
});
export type SetMedicineMemory = typeof SetMedicineMemory.Type;

/**
 * `POST /medicine-memory/sightings`: a container found in a camera check and confirmed by the
 * person, and the room or landmark where it is. It replaces the stored sighting of the same
 * container only when it is newer. Refused (409) while remembering is off.
 */
export const RememberMedicine = Schema.Struct({
	/** What the container is, such as its label: "Lisinopril bottle". */
	container: Text,
	/** A room or landmark the person knows: "kitchen counter, by the kettle". */
	place: Text,
	/** The checked frame's `capturedAt`; it must be at most 15 minutes old. */
	seenAt: UtcTime,
	source: Schema.Literal("camera_check"),
	/** The detection's confidence. Below 0.7, or without a read label, the sighting shows as unsure. */
	confidence: MedicineDetection.fields.confidence,
	/** The picture check read a label on the container. */
	labelRead: Schema.Boolean,
});
export type RememberMedicine = typeof RememberMedicine.Type;

export const MedicineSighting = Schema.Struct({
	...RememberMedicine.fields,
	id: Schema.String,
	familyId: Schema.String,
	savedBy: Schema.String,
	/** When the person looked at `place` and the container was not there: the place is outdated. */
	notFoundAt: Schema.NullOr(Schema.String),
});
export type MedicineSighting = typeof MedicineSighting.Type;

/** `GET /medicine-memory`, and the reply of every change to it. */
export const MedicineMemory = Schema.Struct({
	/** `null`: remembering is off, and no sighting is stored. */
	permission: Schema.NullOr(
		Schema.Struct({
			places: Schema.Array(Schema.String),
			setBy: Schema.String,
			setAt: Schema.String,
		}),
	),
	/** Newest first. */
	sightings: Schema.Array(MedicineSighting),
});
export type MedicineMemory = typeof MedicineMemory.Type;
