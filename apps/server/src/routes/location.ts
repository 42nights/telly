// Family location routes (issue #40), mounted at `/api/families/:familyId`. The module's reducers
// and views enforce membership, per-person shares, and revocation, so these handlers add no rule.
import { IdentityHex } from "@health/contracts/families";
import {
	type FamilyLocations,
	LocationReport,
	type LocationStatus,
	type SharedLocation,
} from "@health/contracts/location";
import { Schema } from "effect";
import type { Context } from "hono";
import { Hono } from "hono";
import { Identity, Timestamp } from "spacetimedb";
import { ApiFailure, callReducer, decodeBody, type FamilyEnv } from "../http";

const status = {
	Fix: "fix",
	GpsDenied: "gps_denied",
	NoFix: "no_fix",
} as const satisfies Record<string, LocationStatus>;

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
				fix:
					row.fix === undefined
						? null
						: { ...row.fix, fixTime: row.fix.fixTime.toISOString() },
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
