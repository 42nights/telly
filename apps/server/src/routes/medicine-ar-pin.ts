// The AR pin of a remembered medicine container (contract telly-ar-pin; docs/board.html#hud-marker),
// relative to `/api/families/:familyId`. The container id is the sighting id. The world map goes to
// private R2 storage; the module keeps one row per pinned sighting and checks membership, the
// medicine-memory permission, and the sighting again. A world map is a scan of the person's home:
// no handler logs it or puts any part of it in a message.
import {
	MAX_WORLD_MAP_BYTES,
	type MedicineArPin,
	SaveMedicineArPin,
	type StoredMedicineArPin,
} from "@health/contracts/medicine-ar-pin";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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

// Every world map of a family is under `ar-pins/<familyId>/`; turning medicine memory off deletes them.
const mapKey = (familyId: bigint, containerId: bigint) =>
	`ar-pins/${familyId}/${containerId}.worldmap`;

// The base64 of the largest map, and room for the anchor id and the JSON around them.
const MAX_BODY_BYTES = Math.ceil(MAX_WORLD_MAP_BYTES / 3) * 4 + 4096;
const TOO_LARGE = "The world map is larger than 16 MB";

const PATH = "/medicine-memory/containers/:containerId/ar-pin";

const rows = (c: Ctx) => {
	const { connection } = c.var.db;
	if (!connection.isActive)
		throw new DbUnavailable({
			reason: "connection closed; cached rows are stale",
		});
	return connection.db;
};

const containerOf = (c: Ctx) => {
	const id = c.req.param("containerId") ?? "";
	if (!/^\d{1,19}$/.test(id))
		throw new ApiFailure("not_found", "No such sighting for this person");
	return BigInt(id);
};

const readPin = (c: Ctx, containerId: bigint): MedicineArPin | undefined => {
	const { familyId } = c.var;
	const row = [...rows(c).myMedicineArPins.iter()].find(
		(pin) => pin.containerId === containerId && pin.familyId === familyId,
	);
	return (
		row && {
			familyId: row.familyId.toString(),
			containerId: row.containerId.toString(),
			anchorId: row.anchorId,
			mapBytes: row.mapBytes,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
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

export const medicineArPinRoutes = (storage?: R2Bucket): FamilyRoutes =>
	new Hono<FamilyEnv>()
		.get(PATH, async (c) => {
			const containerId = containerOf(c);
			const pin = readPin(c, containerId);
			const map =
				pin &&
				(await needStorage(storage).get(mapKey(c.var.familyId, containerId)));
			if (pin === undefined || map === undefined)
				throw new ApiFailure("not_found", "This container has no AR pin");
			return c.json({
				...pin,
				worldMap: map.toBase64(),
			} satisfies StoredMedicineArPin);
		})
		.put(
			PATH,
			bodyLimit({
				maxSize: MAX_BODY_BYTES,
				onError: () => {
					throw new ApiFailure("invalid_request", TOO_LARGE);
				},
			}),
			async (c) => {
				const containerId = containerOf(c);
				const { anchorId, worldMap } = await decodeBody(c, SaveMedicineArPin);
				const map = decodeMap(worldMap);
				const bucket = needStorage(storage);
				const { db, familyId } = c.var;
				const memory = rows(c);
				// The views hold only the sightings and places the caller may open (#291).
				const sighting = [...memory.myMedicineSightings.iter()].find(
					(row) => row.id === containerId && row.familyId === familyId,
				);
				if (sighting === undefined)
					throw new ApiFailure("not_found", "No such sighting for this person");
				if (
					![...memory.myMedicinePlaces.iter()].some(
						(row) =>
							row.familyId === familyId &&
							row.personId.isEqual(sighting.personId),
					)
				)
					throw new ApiFailure(
						"conflict",
						"Remembering where medicine was seen is off for this person",
					);
				// The map first: a refused row leaves only an unread object, which turning medicine
				// memory off deletes with the others.
				await bucket.put(
					mapKey(familyId, containerId),
					map,
					"application/octet-stream",
				);
				await callReducer(db, (connection) =>
					connection.reducers.saveMedicineArPin({
						familyId,
						containerId,
						anchorId: anchorId.trim(),
						mapBytes: map.length,
					}),
				);
				const pin = readPin(c, containerId);
				if (pin === undefined)
					throw new ApiFailure("internal", "The AR pin was not saved");
				return c.json(pin);
			},
		)
		// The row first, so the module's membership check runs before any object is deleted.
		.delete(PATH, async (c) => {
			const containerId = containerOf(c);
			const { db, familyId } = c.var;
			await callReducer(db, (connection) =>
				connection.reducers.deleteMedicineArPin({ familyId, containerId }),
			);
			await storage?.remove(mapKey(familyId, containerId));
			return c.body(null, 204);
		});

/** Deletes every stored world map of the family; the module deletes the rows. */
export const deleteFamilyArPins = async (
	storage: R2Bucket | undefined,
	familyId: bigint,
) => {
	if (storage === undefined) return;
	for (const { key } of await storage.list(`ar-pins/${familyId}/`))
		await storage.remove(key);
};
