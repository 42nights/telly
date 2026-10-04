// Medicine last-seen memory (issue #29; docs/board.html#hud-marker), relative to
// `/api/families/:familyId`. Each member has their own (#291): `?person=<identity>` names the member,
// and the caller is the default. The module's reducers check membership, the member rule, the
// permission, and sighting freshness again; the member check here only turns an empty view into an
// honest `403`. Nothing here records or changes a dose. Turning a member's memory off also deletes
// the AR pins of that member's sightings (`./medicine-ar-pin`) and their maps.
import { IdentityHex } from "@health/contracts/families";
import {
	type MedicineMemory,
	RememberMedicine,
	SetMedicineMemory,
} from "@health/contracts/medicine-memory";
import { Schema } from "effect";
import type { Context } from "hono";
import { Hono } from "hono";
import { Identity, Timestamp } from "spacetimedb";
import { DbUnavailable } from "../db";
import {
	ApiFailure,
	callReducer,
	decodeBody,
	type FamilyEnv,
	type FamilyRoutes,
} from "../http";
import type { R2Bucket } from "../integrations/r2";
import { readAccess } from "./care-profile";
import { deleteArPinMaps, medicineArPinRoutes } from "./medicine-ar-pin";

type Ctx = Context<FamilyEnv>;

/** The members whose medicine the caller may open: the caller, and every member for a manager. */
const readPeople = (c: Ctx): string[] => {
	const me = c.var.db.identity;
	const { mine } = readAccess(c);
	if (!mine.includes("family_access") && !mine.includes("care_plan_edit"))
		return [me];
	const others = [...c.var.db.connection.db.myFamilyMembers.iter()]
		.filter((row) => row.familyId === c.var.familyId)
		.map((row) => row.member.toHexString())
		.filter((member) => member !== me);
	return [me, ...others];
};

/** The member `?person=` names, or the caller; `403` for a member the caller may not open. */
const readPerson = (c: Ctx) => {
	const person = c.req.query("person") ?? c.var.db.identity;
	if (!Schema.is(IdentityHex)(person))
		throw new ApiFailure("invalid_request", "person must be 64 hex characters");
	const people = readPeople(c);
	if (!people.includes(person))
		throw new ApiFailure(
			"forbidden",
			"You may open only your own medicines in this family",
		);
	return { person, people };
};

const readMemory = (c: Ctx): MedicineMemory => {
	const { connection } = c.var.db;
	if (!connection.isActive)
		throw new DbUnavailable({
			reason: "connection closed; cached rows are stale",
		});
	const { familyId } = c.var;
	const { person, people } = readPerson(c);
	const mine = (row: { familyId: bigint; personId: Identity }) =>
		row.familyId === familyId && row.personId.toHexString() === person;
	const permission = [...connection.db.myMedicinePlaces.iter()].find(mine);
	return {
		personId: person,
		people,
		permission:
			permission === undefined
				? null
				: {
						places: permission.places,
						setBy: permission.setBy.toHexString(),
						setAt: permission.setAt.toISOString(),
					},
		sightings: [...connection.db.myMedicineSightings.iter()]
			.filter(mine)
			.map((row) => ({
				id: row.id.toString(),
				familyId: row.familyId.toString(),
				personId: person,
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

export const medicineMemoryRoutes = (storage?: R2Bucket): FamilyRoutes =>
	new Hono<FamilyEnv>()
		.route("/", medicineArPinRoutes(storage))
		.get("/medicine-memory", (c) => c.json(readMemory(c)))
		.put("/medicine-memory", async (c) => {
			const { enabled, places } = await decodeBody(c, SetMedicineMemory);
			const { person } = readPerson(c);
			const { db, familyId } = c.var;
			// The member's sightings are the containers whose pins go with the memory.
			const containers = enabled
				? []
				: readMemory(c).sightings.map((sighting) => BigInt(sighting.id));
			await callReducer(db, (connection) =>
				connection.reducers.setMedicineMemory({
					familyId,
					personId: Identity.fromString(person),
					enabled,
					places: places.map((place) => place.trim()),
				}),
			);
			// After the module's member check; the module has deleted the pin rows.
			await deleteArPinMaps(storage, familyId, containers);
			return c.json(readMemory(c));
		})
		.post("/medicine-memory/sightings", async (c) => {
			const seen = await decodeBody(c, RememberMedicine);
			const memory = readMemory(c);
			if (memory.permission === null)
				throw new ApiFailure(
					"conflict",
					"Remembering where medicine was seen is off for this person",
				);
			const { db, familyId } = c.var;
			await callReducer(db, (connection) =>
				connection.reducers.rememberMedicine({
					...seen,
					familyId,
					personId: Identity.fromString(memory.personId),
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
