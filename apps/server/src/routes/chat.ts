// Family chat routes, relative to `/api/families/:familyId`, behind the API core's sign-in and
// family membership check. Messages persist in the family database.
import { type FamilyMessages, SendFamilyMessage } from "@health/contracts/chat";
import { Hono } from "hono";
import { readFamilyRecords } from "../db";
import {
	ApiFailure,
	callReducer,
	decodeBody,
	type FamilyEnv,
	type FamilyRoutes,
} from "../http";

const PAGE = 200;

export const chatRoutes = (): FamilyRoutes =>
	new Hono<FamilyEnv>()
		.get("/messages", (c) => {
			const after = c.req.query("after") ?? "0";
			if (!/^\d+$/.test(after))
				throw new ApiFailure("invalid_request", "after must be a message id");
			const familyId = c.var.familyId.toString();
			const messages = readFamilyRecords(c.var.db)
				.messages.filter(
					(m) => m.familyId === familyId && BigInt(m.id) > BigInt(after),
				)
				.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
				.slice(0, PAGE);
			return c.json({ messages } satisfies FamilyMessages);
		})
		.post("/messages", async (c) => {
			const message = await decodeBody(c, SendFamilyMessage);
			const { db, familyId } = c.var;
			await callReducer(db, (connection) =>
				connection.reducers.sendMessage({ familyId, ...message }),
			);
			const stored = readFamilyRecords(db).messages.find(
				(m) =>
					m.familyId === familyId.toString() &&
					m.sender === db.identity &&
					m.clientId === message.clientId,
			);
			if (stored === undefined)
				throw new Error("the sent message is not visible to its sender");
			return c.json(stored, 201);
		});
