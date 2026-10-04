// Demo data (#334), mounted at `/api/families/:familyId`. The database replays a real WHOOP
// recording as live while it is on; any member of the family may switch it.
import { DemoDataInput } from "@health/contracts";
import { Hono } from "hono";
import { callReducer, decodeBody, type FamilyEnv } from "../http";

export const demoRoutes = () =>
	new Hono<FamilyEnv>()
		.put("/demo-data", async (c) => {
			const { on } = await decodeBody(c, DemoDataInput);
			await callReducer(c.var.db, (db) =>
				db.reducers.setDemoData({ familyId: c.var.familyId, on }),
			);
			return c.body(null, 204);
		})
		.post("/demo-data/alert", async (c) => {
			await callReducer(c.var.db, (db) =>
				db.reducers.showDemoAlert({ familyId: c.var.familyId }),
			);
			return c.body(null, 204);
		});
