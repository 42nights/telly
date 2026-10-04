// The AR pin of a remembered object (contract telly-ar-pin; docs/board.html#hud-marker; #301). The
// iOS shell pins the object with ARKit and returns the room's ARWorldMap; the server keeps it in
// private storage under the member access rules of the object (#291). A world map is a scan of the
// person's home: it is never logged and goes nowhere but the family's own server and phone.
import { Schema } from "effect";
import { IdentityHex } from "./families";

/** The largest world map the server keeps, decoded. */
export const MAX_WORLD_MAP_BYTES = 16 * 1024 * 1024;

/**
 * `PUT /medicine-memory/objects/:objectId/ar-pin`, where `objectId` is the sighting id. The first
 * path, `/medicine-memory/containers/:containerId/ar-pin`, still works and names the same pin.
 * Replaces the object's pin.
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
	objectId: Schema.String,
	/** The member whose object this is; the zero identity for a pin saved before #301. */
	personId: IdentityHex,
	anchorId: Schema.String,
	/** The decoded size of the stored world map. */
	mapBytes: Schema.Number,
	createdAt: Schema.String,
	updatedAt: Schema.String,
});
export type MedicineArPin = typeof MedicineArPin.Type;

/** `GET .../ar-pin`: the pin and its world map (base64), or 404 when the object has none. */
export const StoredMedicineArPin = Schema.Struct({
	...MedicineArPin.fields,
	worldMap: Schema.String,
});
export type StoredMedicineArPin = typeof StoredMedicineArPin.Type;
