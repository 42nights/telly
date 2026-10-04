// Proves two family paths through the real server and a real local SpacetimeDB: per-member care
// access (the founder sets up sharing, grants and revokes a member's scope, and history keeps
// both) and location sharing (one member shares, another reads, a revoke hides it). Only the
// OIDC issuer is fake; these paths call no other provider.
import { describe, expect, test } from "bun:test";
import {
	CareAccess,
	CareProfileRecord,
	type CareScope,
} from "@health/contracts/care-profile";
import { FamilyLocations, SharedLocation } from "@health/contracts/location";
import {
	addMember,
	createFamily,
	errorOf,
	integration,
	json,
	startIntegration,
	type User,
} from "./harness";

const it = integration ? await startIntegration() : undefined;

const allScopes: CareScope[] = [
	"health_records",
	"care_plan_edit",
	"family_access",
	"location",
	"media",
	"clinician_delivery",
	"purchases",
];

const fix = {
	latitude: 37.7749,
	longitude: -122.4194,
	accuracyMeters: 12,
	fixTime: "2026-01-01T08:00:00.000000Z",
};

const user = async (role: string) => {
	if (it === undefined) throw new Error("integration is off");
	return it.signIn(`care-location-${role}-${crypto.randomUUID()}`);
};

const accessOf = async (who: User, path: string) =>
	json(CareAccess, await who.call("GET", `${path}/care-access`));

const grant = (
	by: User,
	path: string,
	to: User,
	scope: CareScope,
	granted: boolean,
) =>
	by.call("POST", `${path}/care-access`, {
		identity: to.identity,
		scope,
		granted,
	});

describe.skipIf(!integration)("care access", () => {
	// #188: a new family has no care grants; flip to test() when #188 merges.
	test.failing("a family's creator can use its care features at once", async () => {
		const owner = await user("founder");
		const { path } = await createFamily(owner);
		expect((await accessOf(owner, path)).mine).toEqual(
			expect.arrayContaining(allScopes),
		);
		await json(
			CareProfileRecord,
			await owner.call("GET", `${path}/care-profile`),
		);
	});

	test("the founder sets up sharing, then grants and revokes a member's scope", async () => {
		const owner = await user("owner");
		const member = await user("member");
		const { path } = await createFamily(owner);
		await addMember(owner, path, member);

		// The web Sharing window's set-up button: the founder grants these to themself.
		for (const scope of [
			"family_access",
			"health_records",
			"care_plan_edit",
		] as const)
			expect((await grant(owner, path, owner, scope, true)).status).toBe(204);
		// At least these; after #188 the founder also holds every other scope.
		expect((await accessOf(owner, path)).mine).toEqual(
			expect.arrayContaining([
				"care_plan_edit",
				"family_access",
				"health_records",
			]),
		);
		// With health_records the creator can read the care profile.
		await json(
			CareProfileRecord,
			await owner.call("GET", `${path}/care-profile`),
		);

		// Membership alone grants nothing, and a member without family_access cannot grant.
		expect((await accessOf(member, path)).mine).toEqual([]);
		expect(
			await errorOf(await grant(member, path, member, "health_records", true)),
		).toEqual([403, "forbidden"]);
		expect(
			await errorOf(await member.call("GET", `${path}/care-profile`)),
		).toEqual([403, "forbidden"]);

		expect(
			(await grant(owner, path, member, "health_records", true)).status,
		).toBe(204);
		expect((await accessOf(member, path)).mine).toEqual(["health_records"]);
		await json(
			CareProfileRecord,
			await member.call("GET", `${path}/care-profile`),
		);

		expect(
			(await grant(owner, path, member, "health_records", false)).status,
		).toBe(204);
		const after = await accessOf(member, path);
		expect(after.mine).toEqual([]);
		expect(after.grants.filter((g) => g.identity === member.identity)).toEqual(
			[],
		);
		// Newest first: the revoke, then the grant, both by the owner.
		expect(
			after.history.filter((change) => change.identity === member.identity),
		).toMatchObject([
			{ scope: "health_records", granted: false, changedBy: owner.identity },
			{ scope: "health_records", granted: true, changedBy: owner.identity },
		]);
		expect(
			await errorOf(await member.call("GET", `${path}/care-profile`)),
		).toEqual([403, "forbidden"]);
	});

	test("a non-member can neither read nor change the family's care access", async () => {
		const owner = await user("owner");
		const outsider = await user("outsider");
		const { path } = await createFamily(owner);
		const before = await accessOf(owner, path);
		expect(
			await errorOf(await outsider.call("GET", `${path}/care-access`)),
		).toEqual([403, "forbidden"]);
		expect(
			await errorOf(
				await grant(outsider, path, outsider, "family_access", true),
			),
		).toEqual([403, "forbidden"]);
		// The refused grant changed nothing.
		expect(await accessOf(owner, path)).toEqual(before);
	});
});

describe.skipIf(!integration)("location sharing", () => {
	test("a member shares their location, another reads it, and a revoke hides it", async () => {
		const owner = await user("loc-owner");
		const sharer = await user("loc-sharer");
		const outsider = await user("loc-outsider");
		const { id, path } = await createFamily(owner);
		await addMember(owner, path, sharer);
		// Seeing another person's location needs the viewer's `location` care scope (#26); the
		// founder sets it up the way the web Sharing window does.
		expect((await grant(owner, path, owner, "location", true)).status).toBe(
			204,
		);

		const shared = await json(
			FamilyLocations,
			await sharer.call("PUT", `${path}/location/shares/${owner.identity}`),
		);
		expect(shared.shares).toMatchObject([
			{ familyId: id, sharer: sharer.identity, viewer: owner.identity },
		]);
		const reported = await json(
			SharedLocation,
			await sharer.call("POST", `${path}/location`, { status: "fix", fix }),
		);
		expect(reported).toMatchObject({
			sharer: sharer.identity,
			status: "fix",
			fix,
		});

		const seen = await json(
			FamilyLocations,
			await owner.call("GET", `${path}/location`),
		);
		expect(seen.locations).toMatchObject([
			{ sharer: sharer.identity, status: "fix", fix },
		]);
		expect(
			await errorOf(await outsider.call("GET", `${path}/location`)),
		).toEqual([403, "forbidden"]);

		expect(
			await json(
				FamilyLocations,
				await sharer.call(
					"DELETE",
					`${path}/location/shares/${owner.identity}`,
				),
			),
		).toEqual({ locations: [], shares: [] });
		expect(
			await json(FamilyLocations, await owner.call("GET", `${path}/location`)),
		).toEqual({ locations: [], shares: [] });
	});
});
