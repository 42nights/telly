// Runs against a real local SpacetimeDB with the module published (`bun run db:test`). Every
// connection is a separate identity issued by that database; all coordinates are synthetic.
import { describe, expect, test } from "bun:test";
import {
	FamilyLocations,
	HomeWatch,
	SharedLocation,
} from "@health/contracts/location";
import { Effect, Schema } from "effect";
import { Identity } from "spacetimedb";
import { openFamilyDb } from "../db";
import { locationRoutes } from "./location";
import {
	dbConfig,
	failure,
	familyApp,
	openFamily,
	send,
	withDb,
} from "./test-family";

const fix = {
	latitude: 37.7749,
	longitude: -122.4194,
	accuracyMeters: 12,
	fixTime: "2026-01-01T08:00:00.000000Z",
};

describe.skipIf(dbConfig === undefined)("family location", () => {
	test("a location needs both the person's share and the viewer's location scope; sharing grants the scope, and revoking either hides it", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const wearer = yield* openFamily(config, "Location family");
				const shared = yield* openFamilyDb(config);
				const notShared = yield* openFamilyDb(config);
				const outsider = yield* openFamilyDb(config);
				for (const member of [shared, notShared])
					yield* Effect.promise(() =>
						wearer.db.connection.reducers.addFamilyMember({
							familyId: BigInt(wearer.familyId),
							member: Identity.fromString(member.identity),
						}),
					);
				const app = familyApp(wearer.db, wearer.familyId, locationRoutes());
				// The founder may set grants until someone holds `family_access` (#26).
				const grantLocation = (member: typeof shared, granted: boolean) =>
					Effect.promise(() =>
						wearer.db.connection.reducers.setCareGrant({
							familyId: BigInt(wearer.familyId),
							member: Identity.fromString(member.identity),
							scope: "location",
							granted,
						}),
					);
				// Like the server, which opens a connection per request, each read connects anew.
				const read = (db: typeof shared) =>
					Effect.gen(function* () {
						const fresh = yield* openFamilyDb({ ...config, token: db.token });
						const got = yield* send(
							familyApp(fresh, wearer.familyId, locationRoutes()),
							"GET",
							"/location",
						);
						return Schema.decodeUnknownSync(FamilyLocations)(got.json);
					});
				const seenBy = (db: typeof shared) =>
					Effect.map(read(db), (got) => got.locations);

				// Nothing is collected before the wearer shares with someone.
				const early = yield* send(app, "POST", "/location", {
					status: "fix",
					fix,
				});
				expect(failure(early)).toEqual([400, "invalid_request"]);

				// A share needs another member of this family.
				const toOutsider = yield* send(
					app,
					"PUT",
					`/location/shares/${outsider.identity}`,
				);
				expect(failure(toOutsider)).toEqual([400, "invalid_request"]);
				const shares = yield* send(
					app,
					"PUT",
					`/location/shares/${shared.identity}`,
				);
				expect(shares.status).toBe(200);
				expect(
					Schema.decodeUnknownSync(FamilyLocations)(shares.json).shares,
				).toMatchObject([
					{ sharer: wearer.db.identity, viewer: shared.identity },
				]);

				const reported = yield* send(app, "POST", "/location", {
					status: "fix",
					fix,
				});
				expect(reported.status).toBe(200);
				expect(
					Schema.decodeUnknownSync(SharedLocation)(reported.json),
				).toMatchObject({ status: "fix", fix });

				// Sharing also granted the viewer the `location` scope: visible at once.
				expect(yield* read(shared)).toMatchObject({
					locations: [{ sharer: wearer.db.identity, status: "fix", fix }],
					seesShared: true,
				});
				// The wearer always sees their own location, even without the `location` scope.
				yield* grantLocation(wearer.db, false);
				expect(yield* read(wearer.db)).toMatchObject({
					locations: [{ sharer: wearer.db.identity, status: "fix", fix }],
					seesShared: false,
				});

				yield* grantLocation(notShared, true);
				// Share and scope: visible.
				expect(yield* read(shared)).toMatchObject({
					locations: [{ sharer: wearer.db.identity, status: "fix", fix }],
					seesShared: true,
				});
				// Scope without a share: hidden.
				expect(yield* read(notShared)).toMatchObject({
					locations: [],
					seesShared: true,
				});

				// Revoking the scope hides the location at once; the share stays.
				yield* grantLocation(shared, false);
				expect(yield* read(shared)).toMatchObject({
					locations: [],
					shares: [{ sharer: wearer.db.identity, viewer: shared.identity }],
					seesShared: false,
				});
				yield* grantLocation(shared, true);

				// GPS turned off: the status changes and the last fix stays as last known.
				const denied = yield* send(app, "POST", "/location", {
					status: "gps_denied",
				});
				expect(denied.json).toMatchObject({ status: "gps_denied", fix });
				expect(yield* seenBy(shared)).toMatchObject([
					{ status: "gps_denied", fix },
				]);

				// Revoking the last share hides the location at once and deletes it.
				const revoked = yield* send(
					app,
					"DELETE",
					`/location/shares/${shared.identity}`,
				);
				expect(Schema.decodeUnknownSync(FamilyLocations)(revoked.json)).toEqual(
					{ locations: [], shares: [], seesShared: false, events: [] },
				);
				expect(yield* seenBy(shared)).toEqual([]);
				const late = yield* send(app, "POST", "/location", {
					status: "no_fix",
				});
				expect(failure(late)).toEqual([400, "invalid_request"]);

				// A share target must be a 64-hex identity; nothing is changed for a malformed one.
				for (const method of ["PUT", "DELETE"]) {
					const malformed = yield* send(
						app,
						method,
						"/location/shares/not-an-identity",
					);
					expect(failure(malformed)).toEqual([400, "invalid_request"]);
					expect(malformed.json).toMatchObject({
						message: "identity must be 64 hex characters",
					});
				}
				const after = yield* send(app, "GET", "/location");
				expect(Schema.decodeUnknownSync(FamilyLocations)(after.json)).toEqual({
					locations: [],
					shares: [],
					seesShared: false,
					events: [],
				});
			}),
		));

	test("the home stays private, and a trip start reaches the people the wearer shares with", () =>
		withDb((config) =>
			Effect.gen(function* () {
				const wearer = yield* openFamily(config, "Home family");
				const viewer = yield* openFamilyDb(config);
				const familyId = BigInt(wearer.familyId);
				yield* Effect.promise(async () => {
					const { reducers } = wearer.db.connection;
					const member = Identity.fromString(viewer.identity);
					await reducers.addFamilyMember({ familyId, member });
					await reducers.shareLocation({ familyId, viewer: member });
					await reducers.setCareGrant({
						familyId,
						member,
						scope: "location",
						granted: true,
					});
				});
				const app = familyApp(wearer.db, wearer.familyId, locationRoutes());
				const home = { latitude: 37.7749, longitude: -122.4194 };

				const saved = yield* send(app, "PUT", "/location/home", {
					home,
					radiusMeters: 200,
					autoTrip: true,
				});
				expect(Schema.decodeUnknownSync(HomeWatch)(saved.json)).toEqual({
					home,
					radiusMeters: 200,
					autoTrip: true,
					awaySince: null,
					distanceMeters: null,
					sharing: true,
				});
				const tooSmall = yield* send(app, "PUT", "/location/home", {
					home,
					radiusMeters: 50,
					autoTrip: true,
				});
				expect(failure(tooSmall)).toEqual([400, "invalid_request"]);

				const out = yield* send(app, "POST", "/location/away", { away: true });
				expect(
					Schema.decodeUnknownSync(HomeWatch)(out.json).awaySince,
				).not.toBeNull();

				const fresh = yield* openFamilyDb({ ...config, token: viewer.token });
				const viewerApp = familyApp(fresh, wearer.familyId, locationRoutes());
				// The viewer reads only their own (default) home, never the wearer's.
				const theirs = yield* send(viewerApp, "GET", "/location/home");
				expect(
					Schema.decodeUnknownSync(HomeWatch)(theirs.json).home,
				).toBeNull();
				const seen = yield* send(viewerApp, "GET", "/location");
				expect(
					Schema.decodeUnknownSync(FamilyLocations)(seen.json).events,
				).toMatchObject([
					{ sharer: wearer.db.identity, kind: "left", manual: true, fix: null },
				]);
			}),
		));
});
