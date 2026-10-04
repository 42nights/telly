// Emergency help, "Call my family", and the suspected-event check-in (issue #34), relative to
// `/api/families/:familyId`. No code here places a call: the wearer's phone dials from a `tel:`
// link. Explicit help alerts the family at once, with no questionnaire and no wait for wearable
// data. An "ouch" or possible fall gets one short check-in. The family hears through the durable
// alert path (issue #5).
import {
	CheckIn,
	type EmergencyOutcome,
	EmergencyRequest,
	type FamilyNotice,
	type Handoff,
	type LocationReading,
	type Wearer,
} from "@health/contracts/emergency";
import type { Context } from "hono";
import { Hono } from "hono";
import { readFamilyRecords } from "../db";
import {
	ApiFailure,
	callReducer,
	decodeBody,
	type FamilyEnv,
	type FamilyRoutes,
} from "../http";
import { readInstructions, readProfile } from "./care-profile";

type Caller = { var: FamilyEnv["Variables"] };

const PROMPT = "Are you hurt? Do you need help?";
const PROMPT_AGAIN = "I didn't catch that. Do you need help? Say yes or no.";
/** A fix older than this is reported as last known, with its age. */
const CURRENT_FIX_SECONDS = 120;

const NO_HELP = /\b(no|don'?t|do not) (need )?(any )?help\b/;
const NOT_OK = /\bnot (ok|okay|fine|alright|all right|good)\b/;
const HELP =
	/\b(yes|yeah|help|hurt|hurts|pain|fell|fallen|can'?t get up|ambulance|911|emergency|bleeding|dizzy)\b/;
const DENIED = /\b(no|nope|ok|okay|fine|alright|all right|i'?m good)\b/;

/** The wearer's answer to the check-in. Help wins over a stray "ok" ("I'm not ok"). */
const checkInIntent = (text: string): "help" | "denied" | "unclear" => {
	const said = text.toLowerCase();
	if (NO_HELP.test(said)) return "denied";
	if (NOT_OK.test(said) || HELP.test(said)) return "help";
	return DENIED.test(said) ? "denied" : "unclear";
};

const eventLabel = {
	ouch: "Said “ouch” or similar",
	possible_fall: "Possible fall",
} as const;

const NOT_AN_EMERGENCY = {
	action: "none",
	reason: "not_an_emergency",
	safety: "unconfirmed",
	family: null,
} as const satisfies EmergencyOutcome;

/**
 * The care facts for the handoff, read as the caller: the module shows the profile only to members
 * with `health_records`. Any failure is reported as unavailable; it never holds back the call.
 */
const careFacts = (
	c: Context<FamilyEnv>,
): { care: Handoff["care"]; name: string | null } => {
	try {
		const { profile, editedAt } = readProfile(c);
		return {
			name: profile.preferredName,
			care: {
				status: "available",
				conditions: profile.diagnoses,
				allergies: profile.allergies,
				medications: readInstructions(c, profile.timeZone)
					.filter(
						(i) => i.kind === "medication" && i.verification === "verified",
					)
					.map((i) => i.name),
				savedAt: editedAt,
			},
		};
	} catch (error) {
		return {
			name: null,
			care: {
				status: "unavailable",
				reason:
					error instanceof ApiFailure && error.code === "forbidden"
						? "Your care access does not include health records."
						: "The care profile could not be read.",
			},
		};
	}
};

const handoff = (
	c: Context<FamilyEnv>,
	wearer: Wearer,
	event: string,
	report: string | null,
	responsiveness: Handoff["responsiveness"],
	reading: LocationReading,
): Handoff => {
	let location: Handoff["location"];
	if (reading.status !== "fix") location = { status: reading.status };
	else {
		const ageSeconds = Math.max(
			0,
			Math.round((Date.now() - Date.parse(reading.capturedAt)) / 1000),
		);
		location = {
			status: ageSeconds <= CURRENT_FIX_SECONDS ? "current" : "last_known",
			latitude: reading.latitude,
			longitude: reading.longitude,
			accuracyMeters: reading.accuracyMeters,
			ageSeconds,
		};
	}
	const { care, name } = careFacts(c);
	return {
		name: wearer.name ?? name,
		callback: wearer.callback,
		event,
		report,
		responsiveness,
		care,
		location,
	};
};

/** Raises a family alert (issue #5). A failure is reported; the phone still dials. */
const tellFamily = async (
	c: Caller,
	summary: string,
): Promise<FamilyNotice> => {
	const { db, familyId } = c.var;
	try {
		await callReducer(db, (connection) =>
			connection.reducers.raiseAlert({
				familyId,
				sampleId: undefined,
				summary,
			}),
		);
	} catch (error) {
		return {
			status: "failed",
			message:
				error instanceof Error ? error.message : "The alert was not raised",
		};
	}
	const raised = readFamilyRecords(db)
		.alerts.filter(
			(a) =>
				a.familyId === familyId.toString() &&
				a.raisedBy === db.identity &&
				a.summary === summary,
		)
		.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1))[0];
	return raised === undefined
		? { status: "failed", message: "The alert is not visible to its author" }
		: { status: "raised", alertId: raised.id, summary };
};

const quoted = (report: string | null) =>
	report === null ? "" : ` “${report}”`;

/** The family alert for a help request, with what to tell the emergency operator. */
const askForHelp = async (
	c: Caller,
	details: Handoff,
): Promise<EmergencyOutcome> => ({
	action: "help",
	handoff: details,
	family: await tellFamily(
		c,
		`Emergency help requested: ${details.event}${quoted(details.report)}. ${
			details.responsiveness === "responding" ? "Responding" : "Not responding"
		}.`,
	),
});

export const emergencyRoutes = (): FamilyRoutes =>
	new Hono<FamilyEnv>()
		.post("/emergency", async (c) => {
			const request = await decodeBody(c, EmergencyRequest);
			let outcome: EmergencyOutcome = NOT_AN_EMERGENCY;
			if (request.kind === "help")
				outcome = await askForHelp(
					c,
					handoff(
						c,
						request.wearer,
						"Asked for emergency help",
						request.report,
						"responding",
						request.location,
					),
				);
			else if (request.kind === "family")
				outcome = {
					action: "family",
					family: await tellFamily(
						c,
						`Asked to reach the family${quoted(request.report)}.`,
					),
				};
			else if (
				request.event.kind === "ouch" ||
				request.event.kind === "possible_fall"
			)
				outcome = {
					action: "check_in",
					prompt: PROMPT,
					event: { ...request.event, kind: request.event.kind },
					reason: null,
				};
			// A missed reminder or an unheard vibration alone never asks for help.
			return c.json(outcome);
		})
		.post("/emergency/check-in", async (c) => {
			const { event, reply, wearer, location } = await decodeBody(c, CheckIn);
			const label = eventLabel[event.kind];
			let outcome: EmergencyOutcome;
			if (reply.kind === "no_response")
				outcome = await askForHelp(
					c,
					handoff(c, wearer, label, event.report, "not_responding", location),
				);
			else if (reply.speaker === "other")
				outcome = {
					action: "check_in",
					prompt: PROMPT_AGAIN,
					event,
					reason: "other_voice",
				};
			else {
				const intent = checkInIntent(reply.text);
				if (intent === "help")
					outcome = await askForHelp(
						c,
						handoff(
							c,
							wearer,
							label,
							`${event.report} / reply: ${reply.text}`,
							"responding",
							location,
						),
					);
				else if (intent === "unclear")
					outcome = {
						action: "check_in",
						prompt: PROMPT_AGAIN,
						event,
						reason: "unclear",
					};
				else
					outcome = {
						action: "none",
						reason: "denied",
						safety: "unconfirmed",
						family: await tellFamily(
							c,
							`${label}${quoted(event.report)}. Said they are OK: “${reply.text}”. Not confirmed safe.`,
						),
					};
			}
			return c.json(outcome);
		});
