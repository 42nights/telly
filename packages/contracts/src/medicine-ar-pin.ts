// The AR pin of a remembered medicine container (contract telly-ar-pin; docs/board.html#hud-marker).
// The iOS shell pins the container with ARKit and returns the room's ARWorldMap; the server keeps it
// in private storage under the medicine-memory permission. A world map is a scan of the person's
// home: it is never logged and goes nowhere but the family's own server and phone.
import { Schema } from "effect";

/** The largest world map the server keeps, decoded. */
export const MAX_WORLD_MAP_BYTES = 16 * 1024 * 1024;

/**
 * `PUT /medicine-memory/containers/:containerId/ar-pin`, where `containerId` is the sighting id.
 * Replaces the container's pin. Refused (409) while medicine memory is off.
 */
export const SaveMedicineArPin = Schema.Struct({
	/** The ARKit anchor's identifier in the world map. */
	anchorId: Schema.String.check(
		Schema.isPattern(/\S/),
		Schema.isMaxLength(120),
	),
	/** Base64 of the zlib-compressed, archived ARWorldMap; at most `MAX_WORLD_MAP_BYTES` decoded. */
	worldMap: Schema.String,
});
export type SaveMedicineArPin = typeof SaveMedicineArPin.Type;

/** The reply of `PUT .../ar-pin`. */
export const MedicineArPin = Schema.Struct({
	familyId: Schema.String,
	containerId: Schema.String,
	anchorId: Schema.String,
	/** The decoded size of the stored world map. */
	mapBytes: Schema.Number,
	createdAt: Schema.String,
	updatedAt: Schema.String,
});
export type MedicineArPin = typeof MedicineArPin.Type;

/** `GET .../ar-pin`: the pin and its world map (base64), or 404 when the container has none. */
export const StoredMedicineArPin = Schema.Struct({
	...MedicineArPin.fields,
	worldMap: Schema.String,
});
export type StoredMedicineArPin = typeof StoredMedicineArPin.Type;
