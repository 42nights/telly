import { Schema } from "effect";
import { IdentityHex, UtcTime } from "./families";
import { ReminderKind, ReminderOccurrenceDetail } from "./reminders";

// Home-speaker reminder handoff (issue #46), under `/api/families/:familyId`. When the glasses are
// charging, the device that holds a due #28 prompt can ask a home speaker to say it. No real speaker
// is chosen yet: the only provider is `simulated`, and it never plays sound. Evidence for Amazon
// Echo and Google Nest is on #46. Both can only speak. Neither reports that the prompt was heard
// or that the task was done, so acknowledged and completed still come from the phone or the web.

/**
 * `private`: the speaker is in a room only the wearer uses, so it says the reminder title.
 * `shared`: other people can hear it, so it says only a generic nudge, except for the kinds in
 * `sharedRoomKinds`.
 */
export const SpeakerRoom = Schema.Literals(["private", "shared"]);
export type SpeakerRoom = typeof SpeakerRoom.Type;

/** `PUT /speaker-settings`. Before the first save the channel is off, in a shared room, with no kinds. */
export const SpeakerSettings = Schema.Struct({
	enabled: Schema.Boolean,
	room: SpeakerRoom,
	/** Reminder kinds whose title the wearer allows the speaker to say in a shared room. */
	sharedRoomKinds: Schema.Array(ReminderKind).check(Schema.isMaxLength(6)),
});
export type SpeakerSettings = typeof SpeakerSettings.Type;

export const DEFAULT_SPEAKER_SETTINGS: SpeakerSettings = {
	enabled: false,
	room: "shared",
	sharedRoomKinds: [],
};

/** `GET /speaker-settings`. `updatedBy` and `updatedAt` are `null` until the first save. */
export const SavedSpeakerSettings = Schema.Struct({
	settings: SpeakerSettings,
	updatedBy: Schema.NullOr(IdentityHex),
	updatedAt: Schema.NullOr(UtcTime),
});
export type SavedSpeakerSettings = typeof SavedSpeakerSettings.Type;

/**
 * The simulated speaker's state, set only for a demonstration. `offline`: the speaker cannot be
 * reached. `refused`: the provider rejects the action, as a real provider can when its permission is
 * revoked.
 */
export const SimulatedSpeakerMode = Schema.Literals([
	"online",
	"offline",
	"refused",
]);
export type SimulatedSpeakerMode = typeof SimulatedSpeakerMode.Type;

/** `PUT /speaker/simulator`. */
export const SimulatedSpeakerInput = Schema.Struct({
	mode: SimulatedSpeakerMode,
});
export type SimulatedSpeakerInput = typeof SimulatedSpeakerInput.Type;

/** One thing the simulated speaker said, in the words a real speaker would say. */
export const SpeakerAnnouncement = Schema.Struct({
	occurrenceId: Schema.String,
	text: Schema.String,
	at: UtcTime,
});
export type SpeakerAnnouncement = typeof SpeakerAnnouncement.Type;

/**
 * `GET /speaker`: the family's speaker. The simulator is kept in server memory, so a restart sets it
 * `online` with no announcements.
 */
export const SpeakerStatus = Schema.Struct({
	provider: Schema.Literal("simulated"),
	mode: SimulatedSpeakerMode,
	/** Newest first, at most 20. */
	announcements: Schema.Array(SpeakerAnnouncement),
});
export type SpeakerStatus = typeof SpeakerStatus.Type;

/** `POST /reminder-occurrences/:occurrenceId/speaker-handoffs`. A retry with the same `clientId` speaks once. */
export const SpeakerHandoffInput = Schema.Struct({
	clientId: Schema.String.check(
		Schema.isPattern(/^[A-Za-z0-9_-]+$/),
		Schema.isMaxLength(128),
	),
});
export type SpeakerHandoffInput = typeof SpeakerHandoffInput.Type;

/**
 * - `spoken`: the speaker said `announcement`, and the occurrence records `delivered` from `speaker`.
 *   The phone shows the reminder for an answer but does not announce it again.
 * - `use_phone`: the speaker did not speak (`reason`). The prompt stays due, and the phone gives it.
 * - `nothing_due`: no prompt is due, for example because a device already gave it. Nothing is said.
 */
export const SpeakerHandoff = Schema.Struct({
	outcome: Schema.Literals(["spoken", "use_phone", "nothing_due"]),
	reason: Schema.NullOr(Schema.Literals(["disabled", "offline", "refused"])),
	announcement: Schema.NullOr(Schema.String),
	detail: ReminderOccurrenceDetail,
});
export type SpeakerHandoff = typeof SpeakerHandoff.Type;
