// Appointment preparation and clinician-update consent (#44, docs/plan.md "Reports"), mounted at
// `/api/families/:familyId`. The module's reducers check membership and every state rule again:
// only a requested visit takes a provider confirmation, and a share sends only inside its consent.
// Nothing here books a visit or reaches a clinician; every send is simulated.
import {
	type Appointment,
	AppointmentPrep,
	AppointmentRequest,
	type Appointments,
	AppointmentVisit,
	type ClinicianShare,
	type ClinicianShares,
	NewAppointment,
	NewClinicianShare,
	PrepSummary,
	ProviderConfirmation,
	SummarySection,
} from "@health/contracts/appointments";
import { Schema } from "effect";
import type { Context } from "hono";
import { Hono } from "hono";
import { ApiFailure, callReducer, decodeBody, type FamilyEnv } from "../http";
import type { Finchnode } from "../integrations/finchnode";
import { familyLabs } from "./finchnode";
import { readReports } from "./reports";

const Visit = Schema.fromJsonString(AppointmentVisit);
const Prep = Schema.fromJsonString(AppointmentPrep);
const Summary = Schema.fromJsonString(PrepSummary);
const Confirmation = Schema.fromJsonString(ProviderConfirmation);
const Recipient = Schema.fromJsonString(NewClinicianShare.fields.recipient);
const Sections = Schema.fromJsonString(Schema.Array(SummarySection));
const Source = Schema.Literals(["model", "member"]);
const Consent = Schema.Literals(["explicit", "standing"]);

/** Days between sends of a standing arrangement. Keep in step with `intervalMicros` in the module. */
const shareIntervalDays = { weekly: 7, monthly: 30 } as const;

type Stamped = { toHexString(): string } | undefined;
const stamp = (by: Stamped, at: { toISOString(): string } | undefined) =>
	by === undefined || at === undefined
		? null
		: { by: by.toHexString(), at: at.toISOString() };

const readAppointments = (c: Context<FamilyEnv>): Appointment[] =>
	[...c.var.db.connection.db.myAppointments.iter()]
		.filter((row) => row.familyId === c.var.familyId)
		.map((row) => {
			const confirmation = stamp(row.confirmedBy, row.confirmedAt);
			const summary = stamp(row.summaryReviewedBy, row.summaryReviewedAt);
			const request = stamp(row.requestedBy, row.requestedAt);
			const cancellation = stamp(row.cancelledBy, row.cancelledAt);
			return {
				id: row.id,
				familyId: row.familyId.toString(),
				status:
					cancellation !== null
						? "cancelled"
						: confirmation !== null
							? "confirmed"
							: request !== null
								? "requested"
								: "suggested",
				visit: Schema.decodeUnknownSync(Visit)(row.visit),
				prep: Schema.decodeUnknownSync(Prep)(row.prep),
				suggestion: {
					by: row.suggestedBy.toHexString(),
					at: row.suggestedAt.toISOString(),
					source: Schema.decodeUnknownSync(Source)(row.source),
				},
				request,
				confirmation:
					confirmation === null || row.confirmation === undefined
						? null
						: {
								...confirmation,
								...Schema.decodeUnknownSync(Confirmation)(row.confirmation),
							},
				cancellation,
				summary:
					summary === null || row.summary === undefined
						? null
						: {
								...summary,
								content: Schema.decodeUnknownSync(Summary)(row.summary),
							},
			} satisfies Appointment;
		})
		// UTC instants share one format, so they order as strings.
		.sort((a, b) => a.visit.startsAt.localeCompare(b.visit.startsAt));

const findAppointment = (
	c: Context<FamilyEnv>,
	id = c.req.param("appointmentId"),
) => {
	const found = readAppointments(c).find((row) => row.id === id);
	if (found === undefined)
		throw new ApiFailure("not_found", "No such appointment in this family");
	return found;
};

const readShares = (
	c: Context<FamilyEnv>,
	appointmentId: string,
): ClinicianShare[] =>
	[...c.var.db.connection.db.myClinicianShares.iter()]
		.filter(
			(row) =>
				row.familyId === c.var.familyId && row.appointmentId === appointmentId,
		)
		.map((row) => {
			const revocation = stamp(row.revokedBy, row.revokedAt);
			const kind = Schema.decodeUnknownSync(Consent)(row.consent);
			const consent =
				kind === "explicit"
					? ({ kind, frequency: "once" } as const)
					: {
							kind,
							frequency: Schema.decodeUnknownSync(
								Schema.Literals(["weekly", "monthly"]),
							)(row.frequency),
						};
			const last = row.lastSentAt?.toDate();
			const nextSendAt =
				revocation !== null
					? null
					: consent.kind === "explicit"
						? row.sends === 0
							? row.approvedAt.toISOString()
							: null
						: last === undefined
							? row.approvedAt.toISOString()
							: new Date(
									last.getTime() +
										shareIntervalDays[consent.frequency] * 86_400_000,
								).toISOString();
			return {
				id: row.id,
				appointmentId: row.appointmentId,
				recipient: Schema.decodeUnknownSync(Recipient)(row.recipient),
				sections: Schema.decodeUnknownSync(Sections)(row.sections),
				consent,
				approval: {
					by: row.approvedBy.toHexString(),
					at: row.approvedAt.toISOString(),
				},
				revocation,
				delivery: "simulated",
				sends: row.sends,
				lastSentAt: last?.toISOString() ?? null,
				nextSendAt,
			} satisfies ClinicianShare;
		})
		.sort((a, b) => b.approval.at.localeCompare(a.approval.at));

const findShare = (c: Context<FamilyEnv>, id = c.req.param("shareId")) => {
	const found = readShares(c, findAppointment(c).id).find(
		(row) => row.id === id,
	);
	if (found === undefined)
		throw new ApiFailure("not_found", "No such share for this appointment");
	return found;
};

/**
 * The summary as it stands now: the latest reviewed lab report's markers (#17), the Finchnode labs
 * of linked subjects (#8), and the recorded concerns. A source that is off, unlinked, or has no
 * reviewed report is `null`, never an empty "all clear".
 */
const draftSummary = async (
	c: Context<FamilyEnv>,
	finchnode: Finchnode | undefined,
): Promise<PrepSummary> => {
	const { prep } = findAppointment(c);
	const report = readReports(c)
		.filter((row) => row.review !== null)
		.sort((a, b) =>
			(b.review?.reviewedAt ?? "").localeCompare(a.review?.reviewedAt ?? ""),
		)[0];
	const subjects =
		finchnode === undefined
			? []
			: await familyLabs(finchnode, c.var.db, c.var.familyId, c.req.raw.signal);
	const granted = subjects.filter((subject) => subject.access === "granted");
	return {
		labs: granted.length === 0 ? null : granted.flatMap((s) => s.labs),
		observations:
			report === undefined || report.review === null
				? null
				: {
						reportId: report.id,
						reviewedAt: report.review.reviewedAt,
						markers: report.markers,
					},
		symptoms: prep.symptoms,
		medication: prep.medication,
		eatingSleep: prep.eatingSleep,
		questions: prep.questions,
	};
};

/** Suggest, prepare, request, confirm, and cancel visits; review summaries; consent to shares. */
export const appointmentRoutes = (finchnode: Finchnode | undefined) =>
	new Hono<FamilyEnv>()
		.get("/appointments", (c) =>
			c.json({ appointments: readAppointments(c) } satisfies Appointments),
		)
		.post("/appointments", async (c) => {
			const { source, visit, prep } = await decodeBody(c, NewAppointment);
			const id = crypto.randomUUID();
			await callReducer(c.var.db, (connection) =>
				connection.reducers.suggestAppointment({
					id,
					familyId: c.var.familyId,
					visit: Schema.encodeSync(Visit)(visit),
					prep: Schema.encodeSync(Prep)(prep),
					source,
				}),
			);
			return c.json(findAppointment(c, id) satisfies Appointment, 201);
		})
		.get("/appointments/:appointmentId", (c) =>
			c.json(findAppointment(c) satisfies Appointment),
		)
		.put("/appointments/:appointmentId/prep", async (c) => {
			const prep = await decodeBody(c, AppointmentPrep);
			const { id } = findAppointment(c);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.updateAppointmentPrep({
					id,
					prep: Schema.encodeSync(Prep)(prep),
				}),
			);
			return c.json(findAppointment(c) satisfies Appointment);
		})
		.post("/appointments/:appointmentId/request", async (c) => {
			await decodeBody(c, AppointmentRequest);
			const { id } = findAppointment(c);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.requestAppointment({ id }),
			);
			return c.json(findAppointment(c) satisfies Appointment);
		})
		.post("/appointments/:appointmentId/confirmation", async (c) => {
			const confirmation = await decodeBody(c, ProviderConfirmation);
			const { id } = findAppointment(c);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.confirmAppointment({
					id,
					confirmation: Schema.encodeSync(Confirmation)(confirmation),
				}),
			);
			return c.json(findAppointment(c) satisfies Appointment);
		})
		.post("/appointments/:appointmentId/cancel", async (c) => {
			const { id } = findAppointment(c);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.cancelAppointment({ id }),
			);
			return c.json(findAppointment(c) satisfies Appointment);
		})
		.get("/appointments/:appointmentId/summary", async (c) =>
			c.json((await draftSummary(c, finchnode)) satisfies PrepSummary),
		)
		// The body is the draft the member read. A draft that no longer matches the records is not
		// the one they reviewed, so it is refused rather than saved.
		.post("/appointments/:appointmentId/summary", async (c) => {
			const seen = await decodeBody(c, PrepSummary);
			const current = await draftSummary(c, finchnode);
			const summary = Schema.encodeSync(Summary)(current);
			if (Schema.encodeSync(Summary)(seen) !== summary)
				throw new ApiFailure(
					"conflict",
					"The records changed since this summary was read; review it again",
				);
			const { id } = findAppointment(c);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.reviewAppointmentSummary({ id, summary }),
			);
			return c.json(findAppointment(c) satisfies Appointment);
		})
		.get("/appointments/:appointmentId/shares", (c) =>
			c.json({
				shares: readShares(c, findAppointment(c).id),
			} satisfies ClinicianShares),
		)
		.post("/appointments/:appointmentId/shares", async (c) => {
			const { recipient, sections, consent } = await decodeBody(
				c,
				NewClinicianShare,
			);
			const appointmentId = findAppointment(c).id;
			const id = crypto.randomUUID();
			await callReducer(c.var.db, (connection) =>
				connection.reducers.approveClinicianShare({
					id,
					appointmentId,
					recipient: Schema.encodeSync(Recipient)(recipient),
					sections: Schema.encodeSync(Sections)([...new Set(sections)]),
					consent: consent.kind,
					frequency: consent.frequency,
				}),
			);
			return c.json(findShare(c, id) satisfies ClinicianShare, 201);
		})
		.post("/appointments/:appointmentId/shares/:shareId/send", async (c) => {
			const { id } = findShare(c);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.sendClinicianShare({ id }),
			);
			return c.json(findShare(c) satisfies ClinicianShare);
		})
		.post("/appointments/:appointmentId/shares/:shareId/revoke", async (c) => {
			const { id } = findShare(c);
			await callReducer(c.var.db, (connection) =>
				connection.reducers.revokeClinicianShare({ id }),
			);
			return c.json(findShare(c) satisfies ClinicianShare);
		});
