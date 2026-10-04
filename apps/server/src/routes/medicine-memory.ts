// Medicine last-seen memory (issue #29; docs/board.html#hud-marker), relative to
// `/api/families/:familyId`. The module's reducers check membership, the permission, and sighting
// freshness again, so these handlers add no access rule. Nothing here records or changes a dose.
import {
	type MedicineMemory,
	RememberMedicine,
	SetMedicineMemory,
} from "@health/contracts/medicine-memory";
import type { Context } from "hono";
import { Hono } from "hono";
import { Timestamp } from "spacetimedb";
import { DbUnavailable } from "../db";
import {
	ApiFailure,
	callReducer,
	decodeBody,
	type FamilyEnv,
	type FamilyRoutes,
} from "../http";

const readMemory = (c: Context<FamilyEnv>): MedicineMemory => {
	const { connection } = c.var.db;
	if (!connection.isActive)
		throw new DbUnavailable({
			reason: "connection closed; cached rows are stale",
		});
	const { familyId } = c.var;
	const permission = [...connection.db.myMedicineMemory.iter()].find(
		(row) => row.familyId === familyId,
	);
	return {
		permission:
			permission === undefined
				? null
				: {
						places: permission.places,
						setBy: permission.setBy.toHexString(),
						setAt: permission.setAt.toISOString(),
					},
		sightings: [...connection.db.myMedicineSightings.iter()]
			.filter((row) => row.familyId === familyId)
			.map((row) => ({
				id: row.id.toString(),
				familyId: row.familyId.toString(),
				container: row.container,
				place: row.place,
				seenAt: row.seenAt.toISOString(),
				source: "camera_check" as const,
				confidence: row.confidence,
				labelRead: row.labelRead,
				savedBy: row.savedBy.toHexString(),
				notFoundAt: row.notFoundAt?.toISOString() ?? null,
			}))
			.sort((a, b) => b.seenAt.localeCompare(a.seenAt)),
	};
};

export const medicineMemoryRoutes = (): FamilyRoutes =>
	new Hono<FamilyEnv>()
		.get("/medicine-memory", (c) => c.json(readMemory(c)))
		.put("/medicine-memory", async (c) => {
			const { enabled, places } = await decodeBody(c, SetMedicineMemory);
			const { db, familyId } = c.var;
			await callReducer(db, (connection) =>
				connection.reducers.setMedicineMemory({
					familyId,
					enabled,
					places: places.map((place) => place.trim()),
				}),
			);
			return c.json(readMemory(c));
		})
		.post("/medicine-memory/sightings", async (c) => {
			const seen = await decodeBody(c, RememberMedicine);
			if (readMemory(c).permission === null)
				throw new ApiFailure(
					"conflict",
					"Remembering where medicine was seen is off for this person",
				);
			const { db, familyId } = c.var;
			await callReducer(db, (connection) =>
				connection.reducers.rememberMedicine({
					...seen,
					familyId,
					container: seen.container.trim(),
					place: seen.place.trim(),
					seenAt: Timestamp.fromDate(new Date(seen.seenAt)),
				}),
			);
			return c.json(readMemory(c), 201);
		})
		.post("/medicine-memory/sightings/:sightingId/not-found", async (c) => {
			const id = c.req.param("sightingId");
			if (!readMemory(c).sightings.some((s) => s.id === id))
				throw new ApiFailure("not_found", "No such sighting for this person");
			await callReducer(c.var.db, (connection) =>
				connection.reducers.markMedicineNotFound({ id: BigInt(id) }),
			);
			return c.json(readMemory(c));
		});
