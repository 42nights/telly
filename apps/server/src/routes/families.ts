// Family and health-data routes. Every write goes through a module reducer that checks membership
// for the caller's database identity again. Only the family delete checks access here as well, so a
// refused caller never deletes stored files.
import type { Family, FamilyRecords, HealthSample } from "@health/contracts";
import {
	DeleteFamily,
	type FamilyList,
	type Me,
	NewFamily,
	NewFamilyMember,
	NewHealthSample,
} from "@health/contracts/families";
import { Hono } from "hono";
import { Identity, Timestamp } from "spacetimedb";
import { readFamilyRecords } from "../db";
import {
	ApiFailure,
	type AuthEnv,
	callReducer,
	decodeBody,
	type FamilyEnv,
} from "../http";
import type { R2Bucket } from "../integrations/r2";
import { requireScope } from "./care-profile";
import { familyPdfPrefix } from "./reports";

// ponytail: a reducer returns no row, so the new row is the one that appeared during the call. Two
// concurrent creates by the same caller can swap rows; return ids from a procedure if that matters.
const added = <T extends { id: string }>(
	before: readonly T[],
	after: readonly T[],
) => {
	const seen = new Set(before.map((row) => row.id));
	const row = after.find((candidate) => !seen.has(candidate.id));
	if (row === undefined)
		throw new Error("the created row is not visible to its creator");
	return row;
};

/** Signed-in routes outside one family, mounted at `/api`. */
export const accountRoutes = () =>
	new Hono<AuthEnv>()
		.get("/me", (c) =>
			c.json({ ...c.var.identity, identity: c.var.db.identity } satisfies Me),
		)
		.get("/families", (c) =>
			c.json({
				families: readFamilyRecords(c.var.db).families,
			} satisfies FamilyList),
		)
		.post("/families", async (c) => {
			const { name } = await decodeBody(c, NewFamily);
			const before = readFamilyRecords(c.var.db).families;
			await callReducer(c.var.db, (db) => db.reducers.createFamily({ name }));
			const family: Family = added(
				before,
				readFamilyRecords(c.var.db).families,
			);
			return c.json(family, 201);
		});

/** One family's routes, mounted at `/api/families/:familyId` behind the membership check. */
export const familyRoutes = (storage?: R2Bucket) =>
	new Hono<FamilyEnv>()
		.get("/", (c) => {
			const id = c.var.familyId.toString();
			const all = readFamilyRecords(c.var.db);
			return c.json({
				families: all.families.filter((row) => row.id === id),
				samples: all.samples.filter((row) => row.familyId === id),
				alerts: all.alerts.filter((row) => row.familyId === id),
				messages: all.messages.filter((row) => row.familyId === id),
				acknowledgements: all.acknowledgements.filter(
					(row) => row.familyId === id,
				),
			} satisfies FamilyRecords);
		})
		// Checks access and the name before it touches storage, deletes the stored PDFs, then the
		// records. The module checks both again. A failure after the PDFs leaves the records, so a
		// retry finishes the job.
		.delete("/", async (c) => {
			const { name } = await decodeBody(c, DeleteFamily);
			const { db, familyId } = c.var;
			requireScope(c, "family_access");
			const family = readFamilyRecords(db).families.find(
				(row) => row.id === familyId.toString(),
			);
			if (family?.name !== name)
				throw new ApiFailure(
					"invalid_request",
					"the name does not match this family",
				);
			if (storage !== undefined)
				for (const { key } of await storage.list(familyPdfPrefix(familyId)))
					await storage.remove(key);
			await callReducer(db, (connection) =>
				connection.reducers.deleteFamily({ familyId, name }),
			);
			return c.body(null, 204);
		})
		.post("/members", async (c) => {
			const { identity } = await decodeBody(c, NewFamilyMember);
			await callReducer(c.var.db, (db) =>
				db.reducers.addFamilyMember({
					familyId: c.var.familyId,
					member: Identity.fromString(identity),
				}),
			);
			return c.body(null, 204);
		})
		.post("/samples", async (c) => {
			const sample = await decodeBody(c, NewHealthSample);
			const before = readFamilyRecords(c.var.db).samples;
			await callReducer(c.var.db, (db) =>
				db.reducers.recordSample({
					...sample,
					familyId: c.var.familyId,
					sourceTime: Timestamp.fromDate(new Date(sample.sourceTime)),
					quality: {
						tag: sample.quality === "validated" ? "Validated" : "Unvalidated",
					},
				}),
			);
			const created: HealthSample = added(
				before,
				readFamilyRecords(c.var.db).samples,
			);
			return c.json(created, 201);
		});
