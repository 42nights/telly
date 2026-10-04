// Family contact ladder routes (issue #30), mounted at `/api/families/:familyId/care`. The database
// runs the ladder on its own timers, so a server restart neither loses nor repeats a step; these
// handlers read the caller's views and call reducers that check membership and the contact again.
import {
	type CareNeed,
	type CareNeeds,
	CareResponse,
	type ContactAttempt,
	type ContactLadder,
	ContactLadderInput,
	type ContactLadderReply,
	type LadderContact,
	NewCareNeed,
} from "@health/contracts/care";
import { Hono } from "hono";
import { Identity, Timestamp } from "spacetimedb";
import type { FamilyDb } from "../db";
import {
	ApiFailure,
	callReducer,
	decodeBody,
	type FamilyEnv,
	type FamilyRoutes,
} from "../http";

const kinds = {
	Alert: "alert",
	Help: "help",
	CallReminder: "call_reminder",
} as const;
const kindTags = {
	alert: "Alert",
	help: "Help",
	call_reminder: "CallReminder",
} as const;
const details = {
	Minimal: "minimal",
	Summary: "summary",
	Facts: "facts",
} as const;
const detailTags = {
	minimal: "Minimal",
	summary: "Summary",
	facts: "Facts",
} as const;
const attemptStatus = {
	Queued: "queued",
	Sent: "sent",
	Delivered: "delivered",
	Answered: "answered",
	Accepted: "accepted",
	Declined: "declined",
	NoAnswer: "no_answer",
	FollowUpExpired: "follow_up_expired",
} as const;
const needStatus = {
	Open: "open",
	Accepted: "accepted",
	Resolved: "resolved",
	Unresolved: "unresolved",
} as const;
const responseTags = {
	seen: "Seen",
	answer: "Answer",
	accept: "Accept",
	decline: "Decline",
	help_confirmed: "ConfirmHelp",
} as const;

type StepRow = {
	member: Identity;
	name: string;
	timeZone: string;
	detail: { tag: keyof typeof details };
	callFor: { tag: keyof typeof kinds }[];
};

const fromStep = (step: StepRow): LadderContact => ({
	member: step.member.toHexString(),
	name: step.name,
	timeZone: step.timeZone,
	detail: details[step.detail.tag],
	callFor: step.callFor.map((kind) => kinds[kind.tag]),
});

const toStep = (contact: LadderContact) => {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: contact.timeZone });
	} catch {
		throw new ApiFailure(
			"invalid_request",
			`${contact.timeZone} is not a known time zone`,
		);
	}
	return {
		member: Identity.fromString(contact.member),
		name: contact.name,
		timeZone: contact.timeZone,
		detail: { tag: detailTags[contact.detail] },
		callFor: contact.callFor.map((kind) => ({ tag: kindTags[kind] })),
	};
};

/** `at` on the contact's own clock, so the family sees when it reached them. */
const localTime = (at: Date, timeZone: string) => {
	try {
		const time = new Intl.DateTimeFormat("en-US", {
			timeZone,
			weekday: "short",
			hour: "numeric",
			minute: "2-digit",
		}).format(at);
		return `${time} (${timeZone})`;
	} catch {
		return `unknown time zone ${timeZone}`;
	}
};

const readLadder = (
	{ connection }: FamilyDb,
	familyId: bigint,
): ContactLadder | null => {
	const row = [...connection.db.myContactLadders.iter()].find(
		(ladder) => ladder.familyId === familyId,
	);
	if (row === undefined) return null;
	return {
		contacts: row.contacts.map(fromStep),
		backup: row.backup === undefined ? null : fromStep(row.backup),
		answerSeconds: row.answerSeconds,
		followUpSeconds: row.followUpSeconds,
		updatedBy: row.updatedBy.toHexString(),
		updatedAt: row.updatedAt.toISOString(),
	};
};

const readNeeds = ({ connection }: FamilyDb, familyId: bigint): CareNeed[] => {
	const attempts = [...connection.db.myContactAttempts.iter()];
	return [...connection.db.myCareNeeds.iter()]
		.filter((need) => need.familyId === familyId)
		.sort((a, b) => (a.id < b.id ? 1 : -1))
		.map((need) => {
			const backupStep = need.hasBackup ? need.steps.length - 1 : -1;
			const mine = attempts
				.filter((attempt) => attempt.needId === need.id)
				.sort((a, b) => a.step - b.step)
				.map((attempt): ContactAttempt => {
					const contact = need.steps[attempt.step];
					const updatedAt = attempt.updatedAt.toDate();
					return {
						step: attempt.step,
						member: attempt.member.toHexString(),
						name: contact?.name ?? "",
						backup: attempt.step === backupStep,
						channel: attempt.channel.tag === "Call" ? "call" : "message",
						status: attemptStatus[attempt.status.tag],
						body: attempt.body,
						createdAt: attempt.createdAt.toISOString(),
						updatedAt: updatedAt.toISOString(),
						contactLocalTime: localTime(updatedAt, contact?.timeZone ?? "UTC"),
					};
				});
			return {
				id: need.id.toString(),
				familyId: need.familyId.toString(),
				kind: kinds[need.kind.tag],
				summary: need.summary,
				facts: need.facts.map((fact) => ({
					...fact,
					observedAt: fact.observedAt.toISOString(),
				})),
				alertId: need.alertId?.toString() ?? null,
				dueAt: need.dueAt.toISOString(),
				status: needStatus[need.status.tag],
				acceptedBy: need.acceptedBy?.toHexString() ?? null,
				followUpBy: need.followUpBy?.toISOString() ?? null,
				raisedBy: need.raisedBy.toHexString(),
				clientId: need.clientId,
				createdAt: need.createdAt.toISOString(),
				updatedAt: need.updatedAt.toISOString(),
				attempts: mine,
				remaining: need.steps.slice(mine.length).map((step) => step.name),
			};
		});
};

const findNeed = (db: FamilyDb, familyId: bigint, needId: string) => {
	const need = readNeeds(db, familyId).find((row) => row.id === needId);
	if (need === undefined)
		throw new ApiFailure("not_found", "No such care need in this family");
	return need;
};

export const careRoutes = (): FamilyRoutes =>
	new Hono<FamilyEnv>()
		.get("/ladder", (c) =>
			c.json({
				ladder: readLadder(c.var.db, c.var.familyId),
			} satisfies ContactLadderReply),
		)
		.put("/ladder", async (c) => {
			const { db, familyId } = c.var;
			const input = await decodeBody(c, ContactLadderInput);
			const contacts = input.contacts.map(toStep);
			const backup = input.backup === null ? undefined : toStep(input.backup);
			await callReducer(db, (connection) =>
				connection.reducers.setContactLadder({
					familyId,
					contacts,
					backup,
					answerSeconds: input.answerSeconds,
					followUpSeconds: input.followUpSeconds,
				}),
			);
			const saved = readLadder(db, familyId);
			if (saved === null)
				throw new Error("the ladder is not visible to its author");
			return c.json({ ladder: saved } satisfies ContactLadderReply);
		})
		.get("/needs", (c) =>
			c.json({
				needs: readNeeds(c.var.db, c.var.familyId),
			} satisfies CareNeeds),
		)
		.post("/needs", async (c) => {
			const { db, familyId } = c.var;
			const input = await decodeBody(c, NewCareNeed);
			await callReducer(db, (connection) =>
				connection.reducers.openCareNeed({
					familyId,
					clientId: input.clientId,
					kind: { tag: kindTags[input.kind] },
					summary: input.summary,
					sampleIds: input.sampleIds.map(BigInt),
					dueAt:
						input.dueAt === null
							? undefined
							: Timestamp.fromDate(new Date(input.dueAt)),
				}),
			);
			const stored = readNeeds(db, familyId).find(
				(need) =>
					need.raisedBy === db.identity && need.clientId === input.clientId,
			);
			if (stored === undefined)
				throw new Error("the care need is not visible to its author");
			return c.json(stored satisfies CareNeed, 201);
		})
		.get("/needs/:needId", (c) =>
			c.json(
				findNeed(
					c.var.db,
					c.var.familyId,
					c.req.param("needId"),
				) satisfies CareNeed,
			),
		)
		.post("/needs/:needId/responses", async (c) => {
			const { db, familyId } = c.var;
			const needId = c.req.param("needId");
			const { response } = await decodeBody(c, CareResponse);
			const need = findNeed(db, familyId, needId);
			const allowed =
				response === "help_confirmed"
					? need.acceptedBy === db.identity
					: need.attempts.at(-1)?.member === db.identity;
			if (!allowed)
				throw new ApiFailure(
					"forbidden",
					response === "help_confirmed"
						? "Only the member who accepted this need can confirm help"
						: "Only the current contact can answer this need",
				);
			await callReducer(db, (connection) =>
				connection.reducers.respondToCareNeed({
					needId: BigInt(needId),
					response: { tag: responseTags[response] },
				}),
			);
			return c.json(findNeed(db, familyId, needId) satisfies CareNeed);
		});
