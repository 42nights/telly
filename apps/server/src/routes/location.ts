// Family location routes (issues #40 and #302), mounted at `/api/families/:familyId`. The module's
// reducers and views enforce membership, per-person shares, revocation, the `location` care scope
// (#26), and when a trip starts or ends, so these handlers add no rule.
import { IdentityHex } from "@health/contracts/families";
import {
	AwayInput,
	type FamilyLocations,
	HOME_RADIUS,
	HomeInput,
	type HomeWatch,
	LocationReport,
	type LocationStatus,
	type SharedLocation,
} from "@health/contracts/location";
import { Schema } from "effect";
import type { Context } from "hono";
import { Hono } from "hono";
import { Identity, Timestamp } from "spacetimedb";
import { ApiFailure, callReducer, decodeBody, type FamilyEnv } from "../http";
import { readAccess } from "./care-profile";

const status = {
	Fix: "fix",
	GpsDenied: "gps_denied",
	NoFix: "no_fix",
} as const satisfies Record<string, LocationStatus>;

type FixRow = {
	readonly latitude: number;
	readonly longitude: number;
	readonly accuracyMeters: number;
	readonly fixTime: Timestamp;
};

const fixOf = (fix: FixRow | undefined) =>
	fix === undefined ? null : { ...fix, fixTime: fix.fixTime.toISOString() };

const readLocations = (c: Context<FamilyEnv>): FamilyLocations => {
	const { db } = c.var.db.connection;
	const familyId = c.var.familyId;
	return {
		locations: [...db.myLocations.iter()]
			.filter((row) => row.familyId === familyId)
			.map((row) => ({
				familyId: row.familyId.toString(),
				sharer: row.sharer.toHexString(),
				status: status[row.status.tag],
				fix: fixOf(row.fix),
				reportedAt: row.reportedAt.toISOString(),
			})),
		shares: [...db.myLocationShares.iter()]
			.filter((row) => row.familyId === familyId)
			.map((row) => ({
				familyId: row.familyId.toString(),
				sharer: row.sharer.toHexString(),
				viewer: row.viewer.toHexString(),
				sharedAt: row.sharedAt.toISOString(),
			})),
		seesShared: readAccess(c).mine.includes("location"),
		events: [...db.myAwayEvents.iter()]
			.filter((row) => row.familyId === familyId)
			.sort((a, b) => (a.id < b.id ? 1 : -1))
			.map((row) => ({
				id: row.id.toString(),
				familyId: row.familyId.toString(),
				sharer: row.sharer.toHexString(),
				kind: row.kind.tag === "Left" ? "left" : "back",
				manual: row.manual,
				fix: fixOf(row.fix),
				at: row.at.toISOString(),
			})),
	};
};

/** The caller's home settings; the defaults before the first save. */
const readHome = (c: Context<FamilyEnv>): HomeWatch => {
	const { db, familyId } = c.var;
	const row = [...db.connection.db.myHomeWatch.iter()].find(
		(r) => r.familyId === familyId,
	);
	return {
		home:
			row?.home === undefined
				? null
				: { latitude: row.home.latitude, longitude: row.home.longitude },
		radiusMeters: row?.radiusMeters ?? HOME_RADIUS.default,
		autoTrip: row?.autoTrip ?? false,
		awaySince: row?.awaySince?.toISOString() ?? null,
		distanceMeters: row?.distanceMeters ?? null,
		sharing: [...db.connection.db.myLocationShares.iter()].some(
			(s) => s.familyId === familyId && s.sharer.toHexString() === db.identity,
		),
	};
};

const viewerParam = (c: Context<FamilyEnv>) => {
	const viewer = c.req.param("identity");
	if (viewer === undefined || !Schema.is(IdentityHex)(viewer))
		throw new ApiFailure(
			"invalid_request",
			"identity must be 64 hex characters",
		);
	return Identity.fromString(viewer);
};

export const locationRoutes = () =>
	new Hono<FamilyEnv>()
		.get("/location", (c) => c.json(readLocations(c) satisfies FamilyLocations))
		.post("/location", async (c) => {
			const report = await decodeBody(c, LocationReport);
			const { db, familyId } = c.var;
			await callReducer(db, (connection) =>
				connection.reducers.reportLocation({
					familyId,
					status: {
						tag:
							report.status === "fix"
								? "Fix"
								: report.status === "gps_denied"
									? "GpsDenied"
									: "NoFix",
					},
					fix:
						report.status === "fix"
							? {
									...report.fix,
									fixTime: Timestamp.fromDate(new Date(report.fix.fixTime)),
								}
							: undefined,
				}),
			);
			const own = readLocations(c).locations.find(
				(row) => row.sharer === db.identity,
			);
			if (own === undefined)
				throw new Error("the reported location is not visible to its sharer");
			return c.json(own satisfies SharedLocation);
		})
		.get("/location/home", (c) => c.json(readHome(c) satisfies HomeWatch))
		.put("/location/home", async (c) => {
			const input = await decodeBody(c, HomeInput);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.setHome({
					familyId: c.var.familyId,
					home: input.home ?? undefined,
					radiusMeters: input.radiusMeters,
					autoTrip: input.autoTrip,
				}),
			);
			return c.json(readHome(c) satisfies HomeWatch);
		})
		.post("/location/away", async (c) => {
			const { away } = await decodeBody(c, AwayInput);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.setAway({ familyId: c.var.familyId, away }),
			);
			return c.json(readHome(c) satisfies HomeWatch);
		})
		.put("/location/shares/:identity", async (c) => {
			const viewer = viewerParam(c);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.shareLocation({ familyId: c.var.familyId, viewer }),
			);
			return c.json(readLocations(c) satisfies FamilyLocations);
		})
		.delete("/location/shares/:identity", async (c) => {
			const viewer = viewerParam(c);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.revokeLocationShare({
					familyId: c.var.familyId,
					viewer,
				}),
			);
			return c.json(readLocations(c) satisfies FamilyLocations);
		});
