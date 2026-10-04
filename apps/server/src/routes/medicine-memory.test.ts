// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). All records
// are synthetic. Each connection is a separate identity issued by that database.
import { describe, expect, test } from "bun:test";
import { MedicineMemory } from "@health/contracts/medicine-memory";
import { Effect, Schema } from "effect";
import { Timestamp } from "spacetimedb";
import { DbUnavailable, openFamilyDb } from "../db";
import { dbProxy } from "../db-proxy";
import { medicineMemoryRoutes } from "./medicine-memory";
import {
	dbConfig,
	failure,
	familyApp,
	openFamily,
	send,
	withDb,
} from "./test-family";

const decode = Schema.decodeUnknownSync(MedicineMemory);
const minutesAgo = (minutes: number) =>
	new Date(Date.now() - minutes * 60_000).toISOString();
const sighting = (place: string, seenAt: string) => ({
	container: "Synthetic Lisinopril bottle",
	place,
	seenAt,
	source: "camera_check",
	confidence: 0.92,
	labelRead: true,
});

describe.skipIf(dbConfig === undefined)("medicine memory", () => {
	test("a place is stored only with permission and replaced only by a newer current sighting", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db, familyId } = yield* openFamily(config, "Memory family");
				const app = familyApp(db, familyId, medicineMemoryRoutes());
				const path = "/medicine-memory/sightings";

				const off = yield* send(
					app,
					"POST",
					path,
					sighting("Kitchen", minutesAgo(1)),
				);
				expect(failure(off)).toEqual([409, "conflict"]);
				const direct = yield* Effect.promise(() =>
					db.connection.reducers
						.rememberMedicine({
							familyId: BigInt(familyId),
							...sighting("Kitchen", ""),
							seenAt: Timestamp.now(),
						})
						.then(String, String),
				);
				expect(direct).toBe(
					"SenderError: medicine memory is off for this family",
				);

				const places = ["Kitchen counter", "Bedside table"];
				yield* send(app, "PUT", "/medicine-memory", { enabled: true, places });

				// An old frame cannot become a sighting.
				const old = yield* send(
					app,
					"POST",
					path,
					sighting("Kitchen", minutesAgo(30)),
				);
				expect(failure(old)).toEqual([400, "invalid_request"]);

				const first = yield* send(
					app,
					"POST",
					path,
					sighting("Kitchen counter", minutesAgo(2)),
				);
				expect(first.status).toBe(201);
				const [stored] = decode(first.json).sightings;
				if (stored === undefined)
					throw new Error("the sighting was not stored");
				expect(stored.place).toBe("Kitchen counter");
				expect(stored.notFoundAt).toBeNull();

				// The person looked and it was not there: the place stays, marked outdated.
				const missing = yield* send(
					app,
					"POST",
					`${path}/${stored.id}/not-found`,
				);
				const outdated = decode(missing.json).sightings[0];
				expect(outdated?.place).toBe("Kitchen counter");
				expect(outdated?.notFoundAt).not.toBeNull();

				const earlier = yield* send(
					app,
					"POST",
					path,
					sighting("Hall", minutesAgo(3)),
				);
				expect(failure(earlier)).toEqual([400, "invalid_request"]);

				const moved = yield* send(app, "POST", path, {
					...sighting("Bedside table", minutesAgo(1)),
					container: " synthetic lisinopril BOTTLE ",
				});
				const memory = decode(moved.json);
				expect(memory.permission?.places).toEqual(places);
				expect(
					memory.sightings.map((s) => [s.id, s.place, s.notFoundAt]),
				).toEqual([[stored.id, "Bedside table", null]]);

				// Another container is its own sighting; the most recently seen lists first.
				const second = yield* send(app, "POST", path, {
					...sighting("Kitchen counter", minutesAgo(2)),
					container: "Synthetic Metformin box",
				});
				expect(
					decode(second.json).sightings.map((s) => [s.container, s.place]),
				).toEqual([
					[expect.stringMatching(/lisinopril/i), "Bedside table"],
					["Synthetic Metformin box", "Kitchen counter"],
				]);

				// Turning the permission off deletes what was remembered.
				const cleared = yield* send(app, "PUT", "/medicine-memory", {
					enabled: false,
					places: [],
				});
				expect(decode(cleared.json)).toEqual({
					permission: null,
					sightings: [],
				});
			}),
		));

	test("another family's identity cannot read or change a sighting", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db: owner, familyId } = yield* openFamily(
					config,
					"Private memory",
				);
				const ownerApp = familyApp(owner, familyId, medicineMemoryRoutes());
				yield* send(ownerApp, "PUT", "/medicine-memory", {
					enabled: true,
					places: [],
				});
				const saved = yield* send(
					ownerApp,
					"POST",
					"/medicine-memory/sightings",
					sighting("Kitchen", minutesAgo(1)),
				);
				const [stored] = decode(saved.json).sightings;

				const outsider = yield* openFamilyDb(config);
				const outsiderApp = familyApp(
					outsider,
					familyId,
					medicineMemoryRoutes(),
				);
				const read = yield* send(outsiderApp, "GET", "/medicine-memory");
				expect(decode(read.json)).toEqual({ permission: null, sightings: [] });

				const theirs = outsider.connection.reducers;
				const writes = [
					theirs.setMedicineMemory({
						familyId: BigInt(familyId),
						enabled: false,
						places: [],
					}),
					theirs.rememberMedicine({
						familyId: BigInt(familyId),
						...sighting("Garage", ""),
						seenAt: Timestamp.now(),
					}),
					theirs.markMedicineNotFound({ id: BigInt(stored?.id ?? "0") }),
					theirs.saveMedicineArPin({
						familyId: BigInt(familyId),
						containerId: BigInt(stored?.id ?? "0"),
						anchorId: "outsider-anchor",
						mapBytes: 1,
					}),
					theirs.deleteMedicineArPin({
						familyId: BigInt(familyId),
						containerId: BigInt(stored?.id ?? "0"),
					}),
				];
				const results = yield* Effect.promise(() => Promise.allSettled(writes));
				expect(
					results.map((r) =>
						r.status === "rejected" ? String(r.reason) : r.status,
					),
				).toEqual(writes.map(() => "SenderError: not a member of this family"));

				const after = yield* send(ownerApp, "GET", "/medicine-memory");
				expect(after.json).toEqual(saved.json);
			}),
		));

	test("a dropped connection serves no stale memory", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const link = yield* Effect.acquireRelease(
					Effect.promise(() => dbProxy(config.uri)),
					(proxy) => Effect.sync(() => proxy.close()),
				);
				const { db, familyId } = yield* openFamily(
					{ ...config, uri: link.uri },
					"Dropped memory",
				);
				const app = familyApp(db, familyId, medicineMemoryRoutes());
				const permission = { enabled: true, places: ["Kitchen"] };
				const saved = yield* send(app, "PUT", "/medicine-memory", permission);
				expect(saved.status).toBe(200);

				// The write fails once the socket is gone; `app.ts` answers both errors as 503.
				link.drop();
				const write = yield* Effect.promise(() =>
					Promise.resolve(
						app.request("/medicine-memory", {
							method: "PUT",
							body: JSON.stringify(permission),
							headers: { "content-type": "application/json" },
						}),
					).then(
						() => undefined,
						(caught: unknown) => caught,
					),
				);
				expect(write).toBeInstanceOf(DbUnavailable);
				// The cached permission is stale now and never leaves the server.
				const read = yield* Effect.promise(() =>
					Promise.resolve(app.request("/medicine-memory")).then(
						() => undefined,
						(caught: unknown) => caught,
					),
				);
				expect(read).toEqual(
					new DbUnavailable({
						reason: "connection closed; cached rows are stale",
					}),
				);
			}),
		));
});
