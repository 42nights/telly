// FinchNode record routes, mounted at `/api/families/:familyId`. A family reads only subjects that
// it linked from its own Connect session; FinchNode checks the patient's consent on every read.
import type {
	FinchnodeLabs,
	FinchnodeSession,
} from "@health/contracts/reports";
import { Hono } from "hono";
import type { FamilyDb } from "../db";
import { ApiFailure, callReducer, type FamilyEnv } from "../http";
import {
	createSession,
	type Finchnode,
	sessionSubject,
	subjectLabs,
} from "../integrations/finchnode";

const link = (
	db: FamilyDb,
	familyId: bigint,
	subject: string,
	synthetic: boolean,
) =>
	callReducer(db, (connection) =>
		connection.reducers.linkFinchnodeSubject({
			familyId,
			subject,
			synthetic,
		}),
	);

const connectedRoutes = (finchnode: Finchnode) =>
	new Hono<FamilyEnv>()
		.post("/finchnode/sessions", async (c) => {
			const { db, familyId } = c.var;
			const session = await createSession(
				finchnode,
				familyId.toString(),
				c.req.raw.signal,
			);
			if (session.subject !== null)
				await link(db, familyId, session.subject, finchnode.synthetic);
			return c.json(
				{
					sessionId: session.sessionId,
					url: session.url,
					linked: session.subject !== null,
					synthetic: finchnode.synthetic,
				} satisfies FinchnodeSession,
				201,
			);
		})
		.post("/finchnode/sessions/:sessionId/link", async (c) => {
			const { db, familyId } = c.var;
			const sessionId = c.req.param("sessionId");
			const subject = await sessionSubject(
				finchnode,
				sessionId,
				familyId.toString(),
				c.req.raw.signal,
			);
			if (subject === undefined)
				throw new ApiFailure(
					"not_found",
					"No such Finchnode session for this family",
				);
			if (subject !== null)
				await link(db, familyId, subject, finchnode.synthetic);
			return c.json({
				sessionId,
				url: null,
				linked: subject !== null,
				synthetic: finchnode.synthetic,
			} satisfies FinchnodeSession);
		})
		.get("/finchnode/labs", async (c) =>
			c.json({
				subjects: await familyLabs(
					finchnode,
					c.var.db,
					c.var.familyId,
					c.req.raw.signal,
				),
			} satisfies FinchnodeLabs),
		);

/** The labs of every subject the family linked under this configuration. */
export const familyLabs = (
	finchnode: Finchnode,
	db: FamilyDb,
	familyId: bigint,
	signal: AbortSignal,
) =>
	Promise.all(
		// A subject linked under another configuration (demo, sandbox, live) never reaches this one.
		[...db.connection.db.myFinchnodeLinks.iter()]
			.filter(
				(row) =>
					row.familyId === familyId && row.synthetic === finchnode.synthetic,
			)
			.map((row) => subjectLabs(finchnode, row.subject, signal)),
	);

/** Family routes for FinchNode records. Without a configuration every route is `unavailable`. */
export const finchnodeRoutes = (finchnode: Finchnode | undefined) =>
	finchnode === undefined
		? new Hono<FamilyEnv>().all("/finchnode/*", () => {
				throw new ApiFailure(
					"unavailable",
					"Finchnode is off: set FINCHNODE_MODE",
				);
			})
		: connectedRoutes(finchnode);
