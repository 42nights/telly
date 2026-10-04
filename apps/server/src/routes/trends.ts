// Trend explanations, relative to `/api/families/:familyId` behind sign-in and the membership check.
// Read-only: no reducer call, so no record can start an alert, a delivery, or a nudge from here.
import { type TrendExplanation, TrendQuestion } from "@health/contracts/trends";
import { Hono } from "hono";
import { readFamilyRecords } from "../db";
import { ApiFailure, decodeBody, type FamilyEnv } from "../http";
import type { Finchnode } from "../integrations/finchnode";
import { explainTrend } from "../trends";
import { familyLabs } from "./finchnode";

export const trendRoutes = (finchnode: Finchnode | undefined) =>
	new Hono<FamilyEnv>().post("/trends", async (c) => {
		const { question, days = 7 } = await decodeBody(c, TrendQuestion);
		const { db, familyId } = c.var;
		// A lab outage leaves the labs unknown; the other records still answer.
		const labs =
			finchnode === undefined
				? "FinchNode is not set up on this server."
				: await familyLabs(finchnode, db, familyId, c.req.raw.signal).catch(
						(error: unknown) => {
							if (error instanceof ApiFailure) return error.message;
							throw error;
						},
					);
		return c.json(
			explainTrend({
				question,
				days,
				now: new Date(),
				samples: readFamilyRecords(db).samples.filter(
					(sample) => sample.familyId === familyId.toString(),
				),
				labs,
				asker: db.identity,
			}) satisfies TrendExplanation,
		);
	});
