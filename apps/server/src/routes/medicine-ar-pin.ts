// The AR pin of a remembered object (contract telly-ar-pin; docs/board.html#hud-marker; #301),
// relative to `/api/families/:familyId`. The object id is the sighting id. The world map goes to
// private R2 storage; the module keeps one row per pinned object and checks membership, the member
// rule, the memory permission, and the sighting again. A world map is a scan of the person's home:
// no handler logs it or puts any part of it in a message.
import {
	MAX_WORLD_MAP_BYTES,
	type MedicineArPin,
	SaveMedicineArPin,
	type StoredMedicineArPin,
} from "@health/contracts/medicine-ar-pin";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Identity } from "spacetimedb";
import { DbUnavailable } from "../db";
import {
	ApiFailure,
	callReducer,
	decodeBody,
	type FamilyEnv,
	type FamilyRoutes,
} from "../http";
import type { R2Bucket } from "../integrations/r2";

type Ctx = Context<FamilyEnv>;

// Every world map of a family is under `ar-pins/<familyId>/`, one folder per member (#301). A pin
// saved before #301 has the zero identity and its map at the first key, without the member.
const mapKey = (familyId: bigint, personId: Identity, objectId: bigint) =>
	personId.isEqual(Identity.zero())
		? `ar-pins/${familyId}/${objectId}.worldmap`
		: `ar-pins/${familyId}/${personId.toHexString()}/${objectId}.worldmap`;

// The base64 of the largest map, and room for the anchor id and the JSON around them.
const MAX_BODY_BYTES = Math.ceil(MAX_WORLD_MAP_BYTES / 3) * 4 + 4096;
const TOO_LARGE = "The world map is larger than 16 MB";

const rows = (c: Ctx) => {
	const { connection } = c.var.db;
	if (!connection.isActive)
		throw new DbUnavailable({
			reason: "connection closed; cached rows are stale",
		});
	return connection.db;
};

/**
 * The object the path names. The sightings view holds only the objects the caller may open (their
 * own, or every member's for a manager), so another member's object is `404` here, as missing.
 */
const objectOf = (c: Ctx) => {
	const id = c.req.param("objectId") ?? "";
	const sighting = /^\d{1,19}$/.test(id)
		? [...rows(c).myMedicineSightings.iter()].find(
				(row) => row.id === BigInt(id) && row.familyId === c.var.familyId,
			)
		: undefined;
	if (sighting === undefined)
		throw new ApiFailure("not_found", "No such object for this person");
	return sighting;
};

const readPin = (c: Ctx, objectId: bigint) => {
	const { familyId } = c.var;
	const row = [...rows(c).myMedicineArPins.iter()].find(
		(pin) => pin.containerId === objectId && pin.familyId === familyId,
	);
	return (
		row && {
			key: mapKey(familyId, row.personId, objectId),
			pin: {
				familyId: row.familyId.toString(),
				objectId: row.containerId.toString(),
				personId: row.personId.toHexString(),
				anchorId: row.anchorId,
				mapBytes: row.mapBytes,
				createdAt: row.createdAt.toISOString(),
				updatedAt: row.updatedAt.toISOString(),
			} satisfies MedicineArPin,
		}
	);
};

const decodeMap = (base64: string) => {
	let map: Uint8Array;
	try {
		map = Uint8Array.fromBase64(base64);
	} catch {
		throw new ApiFailure("invalid_request", "The world map is not base64");
	}
	if (map.length === 0)
		throw new ApiFailure("invalid_request", "The world map is empty");
	if (map.length > MAX_WORLD_MAP_BYTES)
		throw new ApiFailure("invalid_request", TOO_LARGE);
	return map;
};

const needStorage = (storage: R2Bucket | undefined) => {
	if (storage === undefined)
		throw new ApiFailure(
			"unavailable",
			"AR pin storage is not set up on this server",
		);
	return storage;
};

const routes = (storage: R2Bucket | undefined, path: string) =>
	new Hono<FamilyEnv>()
		.get(path, async (c) => {
			const found = readPin(c, objectOf(c).id);
			const map = found && (await needStorage(storage).get(found.key));
			if (found === undefined || map === undefined)
				throw new ApiFailure("not_found", "This object has no AR pin");
			return c.json({
				...found.pin,
				worldMap: map.toBase64(),
			} satisfies StoredMedicineArPin);
		})
		.put(
			path,
			bodyLimit({
				maxSize: MAX_BODY_BYTES,
				onError: () => {
					throw new ApiFailure("invalid_request", TOO_LARGE);
				},
			}),
			async (c) => {
				const { id: objectId, personId } = objectOf(c);
				const { anchorId, worldMap } = await decodeBody(c, SaveMedicineArPin);
				const map = decodeMap(worldMap);
				const bucket = needStorage(storage);
				const { db, familyId } = c.var;
				const before = readPin(c, objectId)?.key;
				// The map first: a refused row leaves only an unread object, which forgetting the
				// member's things deletes with the others.
				const key = mapKey(familyId, personId, objectId);
				await bucket.put(key, map, "application/octet-stream");
				await callReducer(db, (connection) =>
					connection.reducers.saveMedicineArPin({
						familyId,
						objectId,
						anchorId: anchorId.trim(),
						mapBytes: map.length,
					}),
				);
				// A pin saved before #301 moves to the member's folder.
				if (before !== undefined && before !== key) await bucket.remove(before);
				const saved = readPin(c, objectId);
				if (saved === undefined)
					throw new ApiFailure("internal", "The AR pin was not saved");
				return c.json(saved.pin);
			},
		)
		// The row first, so the module's member check runs before any object is deleted.
		.delete(path, async (c) => {
			const object = objectOf(c);
			const { db, familyId } = c.var;
			await callReducer(db, (connection) =>
				connection.reducers.deleteMedicineArPin({
					familyId,
					objectId: object.id,
				}),
			);
			await deleteArPins(storage, familyId, [object]);
			return c.body(null, 204);
		});

// The object path, and the first one (`containers`), which still names the same pins.
export const medicineArPinRoutes = (storage?: R2Bucket): FamilyRoutes =>
	new Hono<FamilyEnv>()
		.route("/", routes(storage, "/medicine-memory/objects/:objectId/ar-pin"))
		.route(
			"/",
			routes(storage, "/medicine-memory/containers/:objectId/ar-pin"),
		);

/**
 * Deletes the world maps of these objects of the family, at the member's key and at the key of a
 * pin saved before #301; the module deletes the rows.
 */
export const deleteArPins = async (
	storage: R2Bucket | undefined,
	familyId: bigint,
	objects: readonly { readonly id: bigint; readonly personId: Identity }[],
) => {
	if (storage === undefined) return;
	for (const { id, personId } of objects) {
		await storage.remove(mapKey(familyId, personId, id));
		await storage.remove(mapKey(familyId, Identity.zero(), id));
	}
};

/** Deletes every stored world map of the family; the module deletes the rows. */
export const deleteFamilyArPins = async (
	storage: R2Bucket | undefined,
	familyId: bigint,
) => {
	if (storage === undefined) return;
	for (const { key } of await storage.list(`ar-pins/${familyId}/`))
		await storage.remove(key);
};
