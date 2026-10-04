// Alert, acknowledgement, threshold, and monitoring routes (issue #5), mounted at
// `/api/families/:familyId`. The database raises alerts itself when a sample is recorded; these
// handlers read the caller's views and call reducers that check membership again.
import type {
	AcknowledgedAlert,
	AlertThreshold,
	AlertThresholds,
	FamilyAlerts,
	Monitoring,
} from "@health/contracts/alerts";
import { AlertThresholdInput } from "@health/contracts/alerts";
import { Hono } from "hono";
import { monitor, readAlerts, readThresholds } from "../alerts/records";
import { readFamilyRecords } from "../db";
import { ApiFailure, callReducer, decodeBody, type FamilyEnv } from "../http";

const directionTag = { above: "Above", below: "Below" } as const;

export const alertRoutes = () =>
	new Hono<FamilyEnv>()
		.get("/alerts", (c) =>
			c.json({
				alerts: readAlerts(c.var.db, c.var.familyId.toString()),
			} satisfies FamilyAlerts),
		)
		// Idempotent: acknowledging again returns the first acknowledgement. Delivery is unaffected.
		.post("/alerts/:alertId/acknowledgements", async (c) => {
			const { db } = c.var;
			const alertId = c.req.param("alertId");
			const found = readAlerts(db, c.var.familyId.toString()).some(
				({ alert }) => alert.id === alertId,
			);
			if (!found)
				throw new ApiFailure("not_found", "No such alert in this family");
			await callReducer(db, (connection) =>
				connection.reducers.acknowledgeAlert({ alertId: BigInt(alertId) }),
			);
			const acknowledgement = readFamilyRecords(db).acknowledgements.find(
				(ack) => ack.alertId === alertId && ack.member === db.identity,
			);
			if (acknowledgement === undefined)
				throw new Error("the acknowledgement is not visible to its author");
			return c.json({ acknowledgement } satisfies AcknowledgedAlert);
		})
		.get("/alert-thresholds", (c) =>
			c.json({
				thresholds: readThresholds(c.var.db, c.var.familyId.toString()),
			} satisfies AlertThresholds),
		)
		.put("/alert-thresholds", async (c) => {
			const { db, familyId } = c.var;
			const input = await decodeBody(c, AlertThresholdInput);
			await callReducer(db, (connection) =>
				connection.reducers.setAlertThreshold({
					...input,
					familyId,
					direction: { tag: directionTag[input.direction] },
				}),
			);
			const saved = readThresholds(db, familyId.toString()).find(
				(rule) =>
					rule.metric === input.metric && rule.direction === input.direction,
			);
			if (saved === undefined)
				throw new Error("the threshold is not visible to its author");
			return c.json(saved satisfies AlertThreshold);
		})
		.delete("/alert-thresholds/:thresholdId", async (c) => {
			const { db } = c.var;
			const thresholdId = c.req.param("thresholdId");
			const found = readThresholds(db, c.var.familyId.toString()).some(
				(rule) => rule.id === thresholdId,
			);
			if (!found)
				throw new ApiFailure("not_found", "No such threshold in this family");
			await callReducer(db, (connection) =>
				connection.reducers.removeAlertThreshold({
					thresholdId: BigInt(thresholdId),
				}),
			);
			return c.body(null, 204);
		})
		.get("/monitoring", (c) => {
			const { db, familyId } = c.var;
			return c.json(
				monitor(
					readThresholds(db, familyId.toString()),
					readFamilyRecords(db).samples,
					new Date(),
				) satisfies Monitoring,
			);
		});
