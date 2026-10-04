// Family messages and family questions. Paths are relative to `/api/families/:familyId`; the family
// middleware has already checked the caller's identity and membership and opened `db` as that identity.
import type { ApiError } from "@health/contracts";
import {
	type FamilyMessages,
	FamilyQuestion,
	SendFamilyMessage,
} from "@health/contracts/family";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import type { Context } from "hono";
import { Hono } from "hono";
import { type FamilyDb, readFamilyRecords } from "../db";
import { answerQuestion } from "../family-agent";
import type { GrokbotConfig } from "../integrations/grokbot";

// ponytail: local copy of the API core's FamilyEnv; import it from ../http when that lands.
type FamilyEnv = {
	Variables: { readonly db: FamilyDb; readonly familyId: string };
};

const PAGE = 200;

const fail = (
	c: Context<FamilyEnv>,
	status: 400 | 403 | 502 | 503,
	error: ApiError["error"],
	message: string,
) => c.json({ error, message } satisfies ApiError, status);

/** Decodes a JSON body with a contract, or describes why it does not match. */
const readBody = async <T>(
	c: Context<FamilyEnv>,
	schema: Schema.Decoder<T>,
) => {
	const json: unknown = await c.req.json().catch(() => undefined);
	const exit = Schema.decodeUnknownExit(schema)(json, {
		onExcessProperty: "error",
	});
	return Exit.isSuccess(exit)
		? ({ ok: true, value: exit.value } as const)
		: ({
				ok: false,
				message: "request body does not match the contract",
			} as const);
};

export const familyRoutes = (grokbot: GrokbotConfig | undefined) =>
	new Hono<FamilyEnv>()
		.get("/messages", (c) => {
			const after = c.req.query("after") ?? "0";
			if (!/^\d+$/.test(after))
				return fail(c, 400, "invalid_request", "after must be a message id");
			const familyId = c.get("familyId");
			const messages = readFamilyRecords(c.get("db"))
				.messages.filter(
					(m) => m.familyId === familyId && BigInt(m.id) > BigInt(after),
				)
				.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
				.slice(0, PAGE);
			return c.json({ messages } satisfies FamilyMessages);
		})
		.post("/messages", async (c) => {
			const body = await readBody(c, SendFamilyMessage);
			if (!body.ok) return fail(c, 400, "invalid_request", body.message);
			const db = c.get("db");
			const familyId = c.get("familyId");
			const { clientId } = body.value;
			try {
				await db.connection.reducers.sendMessage({
					familyId: BigInt(familyId),
					...body.value,
				});
			} catch (error) {
				// The module's own checks; anything else is an internal failure.
				if (!(error instanceof Error) || error.name !== "SenderError")
					throw error;
				return error.message === "not a member of this family"
					? fail(c, 403, "forbidden", "not a member of this family")
					: fail(c, 400, "invalid_request", error.message);
			}
			const stored = readFamilyRecords(db).messages.find(
				(m) =>
					m.familyId === familyId &&
					m.sender === db.identity &&
					m.clientId === clientId,
			);
			if (stored === undefined)
				throw new Error("sent message is missing from the view");
			return c.json(stored, 201);
		})
		.post("/ask", async (c) => {
			const body = await readBody(c, FamilyQuestion);
			if (!body.ok) return fail(c, 400, "invalid_request", body.message);
			if (grokbot === undefined)
				return fail(
					c,
					503,
					"unavailable",
					"Grokbot is not configured (XAI_API_KEY is unset)",
				);
			const familyId = c.get("familyId");
			const samples = readFamilyRecords(c.get("db")).samples.filter(
				(s) => s.familyId === familyId,
			);
			const exit = await Effect.runPromiseExit(
				answerQuestion(grokbot, samples, body.value, new Date()),
				{ signal: c.req.raw.signal },
			);
			if (Exit.isSuccess(exit)) return c.json(exit.value);
			const failure = Cause.findErrorOption(exit.cause);
			// Interruption or a defect: not a provider answer, so the generic 500 handler reports it.
			if (Option.isNone(failure)) throw Cause.squash(exit.cause);
			const { reason, status } = failure.value;
			console.error(`grokbot failed: ${reason} ${status ?? ""}`);
			return fail(
				c,
				502,
				"upstream_error",
				`Grokbot did not answer (${reason})`,
			);
		});
