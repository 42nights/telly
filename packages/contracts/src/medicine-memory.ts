// Where a member's things were last seen: medicine containers (issue #29; docs/board.html#hud-marker)
// and any other personal object, such as keys or glasses (#301). A sighting is a past observation,
// never the object's current place: a current place comes only from a new camera check
// (`./vision`). Remembering or finding medicine never records a dose. Remembering is on for every
// member (#301); the member, or a manager, can forget one thing or everything.
//
// Each member has their own medicines and places (#291). Every route takes `?person=<identity>`,
// the member whose things it reads or changes; without it, the caller's own. A member opens their
// own; a member with `family_access` or `care_plan_edit` opens every member's; anyone else gets 403.
import { Schema } from "effect";
import { IdentityHex } from "./families";
import { ObjectCategory, ObjectDetection, UtcTime } from "./vision";

const Text = Schema.String.check(
	Schema.isPattern(/\S/),
	Schema.isMaxLength(120),
);

/**
 * `PUT /medicine-memory`: `enabled: true` sets the member's agreed familiar places to search when
 * a thing moved. `enabled: false` is "Forget everything": it deletes the member's places, every
 * saved thing and sighting, and their AR pins and room maps.
 */
export const SetMedicineMemory = Schema.Struct({
	enabled: Schema.Boolean,
	places: Schema.Array(Text).check(Schema.isMaxLength(12)),
});
export type SetMedicineMemory = typeof SetMedicineMemory.Type;

/** Base64 JPEG thumbnail of the object, cut from the checked picture; at most 64 KiB of text. */
const Thumbnail = Schema.String.check(
	Schema.isMaxLength(64 * 1024),
	Schema.isBase64(),
);

/**
 * `POST /medicine-memory/sightings`: an object found in a camera check and confirmed by the
 * person, and the room or landmark where it is. It replaces the stored sighting of the same object
 * only when it is newer, and keeps the earlier places for "usually kept".
 * `DELETE /medicine-memory/sightings/:id` forgets one thing, with its AR pin and room map.
 */
export const RememberMedicine = Schema.Struct({
	/** What the object is: the medicine's label ("Lisinopril bottle") or a short name ("keys"). */
	container: Text,
	/** A room or landmark the person knows: "kitchen counter, by the kettle". */
	place: Text,
	/** The checked frame's `capturedAt`; it must be at most 15 minutes old. */
	seenAt: UtcTime,
	source: Schema.Literal("camera_check"),
	/** The detection's confidence. Below 0.7, or without a read label, the sighting shows as unsure. */
	confidence: ObjectDetection.fields.confidence,
	/** The picture check read a label on the container, or named the object. */
	labelRead: Schema.Boolean,
	/** The detection's category. Clients from before #301 send none: their sightings are medicine. */
	category: Schema.optionalKey(ObjectCategory),
	thumbnail: Schema.optionalKey(Thumbnail),
});
export type RememberMedicine = typeof RememberMedicine.Type;

export const MedicineSighting = Schema.Struct({
	...RememberMedicine.fields,
	category: ObjectCategory,
	/** Empty for sightings saved before #301. */
	thumbnail: Schema.String,
	id: Schema.String,
	familyId: Schema.String,
	/** The member whose object this is. */
	personId: IdentityHex,
	savedBy: Schema.String,
	/** When the person looked at `place` and the object was not there: the place is outdated. */
	notFoundAt: Schema.NullOr(Schema.String),
	/**
	 * Where the object is usually kept: the place it was seen most often, counting `place` and up to
	 * 19 earlier ones, once it was seen there at least twice. `null` until there is that history.
	 */
	usualPlace: Schema.NullOr(Schema.String),
	/** The object has an AR pin (`./medicine-ar-pin`), so the iPhone app can show it in AR. */
	pinned: Schema.Boolean,
});
export type MedicineSighting = typeof MedicineSighting.Type;

/** `GET /medicine-memory`, and the reply of every change to it: one member's memory. */
export const MedicineMemory = Schema.Struct({
	/** The member whose things these are. */
	personId: IdentityHex,
	/** The members whose things the caller may open: the caller first, then the others. */
	people: Schema.Array(IdentityHex),
	/** The member's agreed places to search when a thing moved; empty when none were set. */
	places: Schema.Array(Schema.String),
	/** Newest first. */
	sightings: Schema.Array(MedicineSighting),
});
export type MedicineMemory = typeof MedicineMemory.Type;
