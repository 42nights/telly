// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). All records
// are synthetic. Each connection is a separate identity issued by that database.
import { describe, expect, test } from "bun:test";
import { MedicineMemory } from "@health/contracts/medicine-memory";
import { Effect, Schema } from "effect";
import type { Hono } from "hono";
import { Identity, Timestamp } from "spacetimedb";
import { DbUnavailable, openFamilyDb } from "../db";
import { dbProxy } from "../db-proxy";
import type { FamilyEnv } from "../http";
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

/** Another identity's views update asynchronously; polls `path` until `done` holds. */
const until = (
	app: Hono<FamilyEnv>,
	path: string,
	done: (response: { status: number; json: unknown }) => boolean,
) =>
	Effect.gen(function* () {
		for (let tries = 0; ; tries++) {
			const response = yield* send(app, "GET", path);
			if (done(response) || tries === 100) return response;
			yield* Effect.sleep("20 millis");
		}
	});
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
							personId: Identity.fromString(db.identity),
							...sighting("Kitchen", ""),
							seenAt: Timestamp.now(),
						})
						.then(String, String),
				);
				expect(direct).toBe(
					"SenderError: medicine memory is off for this member",
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
					personId: db.identity,
					people: [db.identity],
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
				expect(decode(read.json)).toEqual({
					personId: outsider.identity,
					people: [outsider.identity],
					permission: null,
					sightings: [],
				});
				const asked = yield* send(
					outsiderApp,
					"GET",
					`/medicine-memory?person=${owner.identity}`,
				);
				expect(failure(asked)).toEqual([403, "forbidden"]);

				const theirs = outsider.connection.reducers;
				const writes = [
					theirs.setMedicineMemory({
						familyId: BigInt(familyId),
						personId: Identity.fromString(owner.identity),
						enabled: false,
						places: [],
					}),
					theirs.rememberMedicine({
						familyId: BigInt(familyId),
						personId: Identity.fromString(owner.identity),
						...sighting("Garage", ""),
						seenAt: Timestamp.now(),
					}),
					theirs.markMedicineNotFound({ id: BigInt(stored?.id ?? "0") }),
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

	test("each member has their own; a caregiver opens every member's; others get 403", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const { db: owner, familyId } = yield* openFamily(config, "Members");
				const relative = yield* openFamilyDb(config);
				yield* Effect.promise(() =>
					owner.connection.reducers.addFamilyMember({
						familyId: BigInt(familyId),
						member: Identity.fromString(relative.identity),
					}),
				);
				const ownerApp = familyApp(owner, familyId, medicineMemoryRoutes());
				const theirs = familyApp(relative, familyId, medicineMemoryRoutes());
				const ofOwner = `/medicine-memory?person=${owner.identity}`;
				const ofRelative = `/medicine-memory?person=${relative.identity}`;

				// The relative keeps their own pills in their own places.
				yield* send(theirs, "PUT", "/medicine-memory", {
					enabled: true,
					places: ["Bathroom shelf"],
				});
				const saved = yield* send(
					theirs,
					"POST",
					"/medicine-memory/sightings",
					sighting("Bathroom shelf", minutesAgo(1)),
				);
				expect(decode(saved.json)).toMatchObject({
					personId: relative.identity,
					people: [relative.identity],
					sightings: [{ personId: relative.identity }],
				});

				// The founder (every scope, #188) sees only their own by default, and the relative's on
				// request; the relative cannot open the founder's.
				expect(
					decode((yield* send(ownerApp, "GET", "/medicine-memory")).json),
				).toMatchObject({
					personId: owner.identity,
					permission: null,
					sightings: [],
				});
				const opened = decode(
					(yield* until(
						ownerApp,
						ofRelative,
						(r) => r.status === 200 && decode(r.json).sightings.length === 1,
					)).json,
				);
				expect(opened.people).toEqual([owner.identity, relative.identity]);
				expect(opened.permission?.places).toEqual(["Bathroom shelf"]);
				for (const [method, body] of [
					["GET", undefined],
					["PUT", { enabled: false, places: [] }],
				] as const)
					expect(failure(yield* send(theirs, method, ofOwner, body))).toEqual([
						403,
						"forbidden",
					]);
				expect(
					failure(yield* send(theirs, "GET", "/medicine-memory?person=me")),
				).toEqual([400, "invalid_request"]);

				// A caregiver scope opens the founder's too; the founder's own stays separate.
				yield* Effect.promise(() =>
					owner.connection.reducers.setCareGrant({
						familyId: BigInt(familyId),
						member: Identity.fromString(relative.identity),
						scope: "care_plan_edit",
						granted: true,
					}),
				);
				yield* until(theirs, ofOwner, (r) => r.status === 200);
				yield* send(theirs, "PUT", ofOwner, {
					enabled: true,
					places: ["Desk"],
				});
				const own = decode(
					(yield* until(
						ownerApp,
						"/medicine-memory",
						(r) => decode(r.json).permission !== null,
					)).json,
				);
				expect(own.permission?.places).toEqual(["Desk"]);
				expect(own.sightings).toEqual([]);
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
