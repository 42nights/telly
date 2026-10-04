// Home-speaker reminder handoff (issue #46), mounted at `/api/families/:familyId`. The only speaker
// is a simulator: it never plays sound, and its state lives in this process. A spoken prompt records
// `delivered` from `speaker` on the #28 occurrence; every other outcome leaves the prompt due for the
// phone, so the person hears the reminder once.
import type { ReminderOccurrence } from "@health/contracts/reminders";
import {
	DEFAULT_SPEAKER_SETTINGS,
	SavedSpeakerSettings,
	SimulatedSpeakerInput,
	type SimulatedSpeakerMode,
	type SpeakerAnnouncement,
	type SpeakerHandoff,
	SpeakerHandoffInput,
	SpeakerSettings,
	type SpeakerStatus,
} from "@health/contracts/speaker";
import { Schema } from "effect";
import { type Context, Hono } from "hono";
import type { FamilyDb } from "../db";
import { ApiFailure, callReducer, decodeBody, type FamilyEnv } from "../http";
import { readReminderHistory, views } from "../reminders/records";

const ANNOUNCEMENTS_KEPT = 20;
const GENERIC_NUDGE = "You have a reminder. Please check your phone.";

/** What the speaker says. In a shared room, a title is said only for a kind the wearer allowed. */
const announcementFor = (
	settings: SpeakerSettings,
	occurrence: Pick<ReminderOccurrence, "kind" | "title">,
) =>
	settings.room === "private" ||
	settings.sharedRoomKinds.includes(occurrence.kind)
		? `Reminder: ${occurrence.title}.`
		: GENERIC_NUDGE;

const decodeSaved = Schema.decodeUnknownSync(SavedSpeakerSettings);

const readSpeakerSettings = (
	db: FamilyDb,
	familyId: string,
): SavedSpeakerSettings => {
	const row = [...views(db).mySpeakerSettings.iter()].find(
		(s) => s.familyId.toString() === familyId,
	);
	if (row === undefined)
		return {
			settings: DEFAULT_SPEAKER_SETTINGS,
			updatedBy: null,
			updatedAt: null,
		};
	return decodeSaved({
		settings: {
			enabled: row.enabled,
			room: row.room,
			sharedRoomKinds: row.sharedRoomKinds,
		},
		updatedBy: row.updatedBy.toHexString(),
		updatedAt: row.updatedAt.toISOString(),
	});
};

type Simulator = {
	mode: SimulatedSpeakerMode;
	announcements: SpeakerAnnouncement[];
};

export const speakerRoutes = () => {
	// ponytail: the simulator and the in-flight guard are per process. A real provider behind more than
	// one server needs the delivery claimed in the database before it speaks.
	const simulators = new Map<string, Simulator>();
	const inFlight = new Set<string>();
	const simulatorOf = (familyId: string) => {
		let found = simulators.get(familyId);
		if (found === undefined) {
			found = { mode: "online", announcements: [] };
			simulators.set(familyId, found);
		}
		return found;
	};
	const status = (c: Context<FamilyEnv>) => {
		const { mode, announcements } = simulatorOf(c.var.familyId.toString());
		return c.json({
			provider: "simulated",
			mode,
			announcements,
		} satisfies SpeakerStatus);
	};

	return new Hono<FamilyEnv>()
		.get("/speaker-settings", (c) =>
			c.json(readSpeakerSettings(c.var.db, c.var.familyId.toString())),
		)
		.put("/speaker-settings", async (c) => {
			const { db, familyId } = c.var;
			const input = await decodeBody(c, SpeakerSettings);
			await callReducer(db, (connection) =>
				connection.reducers.setSpeakerSettings({
					familyId,
					enabled: input.enabled,
					room: input.room,
					sharedRoomKinds: [...input.sharedRoomKinds],
				}),
			);
			return c.json(readSpeakerSettings(db, familyId.toString()));
		})
		.get("/speaker", status)
		.put("/speaker/simulator", async (c) => {
			const { mode } = await decodeBody(c, SimulatedSpeakerInput);
			simulatorOf(c.var.familyId.toString()).mode = mode;
			return status(c);
		})
		.post("/reminder-occurrences/:occurrenceId/speaker-handoffs", async (c) => {
			const { db } = c.var;
			const familyId = c.var.familyId.toString();
			const occurrenceId = c.req.param("occurrenceId");
			const { clientId } = await decodeBody(c, SpeakerHandoffInput);
			const read = () => {
				const found = readReminderHistory(db, familyId, occurrenceId)[0];
				if (found === undefined)
					throw new ApiFailure(
						"not_found",
						"No such reminder occurrence in this family",
					);
				return found;
			};
			const reply = (
				outcome: SpeakerHandoff["outcome"],
				reason: SpeakerHandoff["reason"],
				announcement: string | null,
			) =>
				c.json({
					outcome,
					reason,
					announcement,
					detail: read(),
				} satisfies SpeakerHandoff);

			const before = read();
			// Another device gave the prompt, or another handoff is saying it now.
			if (!before.occurrence.promptDue || inFlight.has(occurrenceId))
				return reply("nothing_due", null, null);
			const { settings } = readSpeakerSettings(db, familyId);
			if (!settings.enabled) return reply("use_phone", "disabled", null);
			const speaker = simulatorOf(familyId);
			if (speaker.mode !== "online")
				return reply("use_phone", speaker.mode, null);

			const text = announcementFor(settings, before.occurrence);
			inFlight.add(occurrenceId);
			try {
				// Claim the prompt first: when this fails, nothing was said and the prompt stays due.
				await callReducer(db, (connection) =>
					connection.reducers.recordReminderDelivery({
						occurrenceId: BigInt(occurrenceId),
						clientId,
						source: "speaker",
					}),
				);
			} finally {
				inFlight.delete(occurrenceId);
			}
			const after = read();
			const last = after.events.at(-1);
			// A reused clientId records nothing, so nothing is said.
			if (
				after.events.length === before.events.length ||
				last?.state !== "delivered" ||
				last.source !== "speaker"
			)
				return reply("nothing_due", null, null);
			speaker.announcements = [
				{ occurrenceId, text, at: new Date().toISOString() },
				...speaker.announcements,
			].slice(0, ANNOUNCEMENTS_KEPT);
			return reply("spoken", null, text);
		});
};
